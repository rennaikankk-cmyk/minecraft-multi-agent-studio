// spark-strategy-v1/summary.ts —— 有界局势摘要构建器（纯函数，无 I/O）。
//
// 一期指令 §4 核心要求：
//  - 只做有界摘要：大小上限 + 明确裁剪顺序；裁剪绝不丢掉用于判断是否
//    允许行动的事实（作用域/约束/短缺/阶段门永不裁剪）。
//  - 未知保持 unknown；摘要不把 unknown 转成 0/空。
//  - token 计数无真实 tokenizer → 一律标 estimated（chars/4 口径）。
//  - 自由文本过脱敏；设施/资源用不透明引用。

import {
  factVersion,
  scrubFreeText,
  type Facility,
  type InventoryItem,
  type TeamFactsInput,
} from "./facts.js";

export type SummaryOptions = {
  /** 摘要文本字符上限（超过走裁剪顺序）。默认 4000。 */
  maxChars?: number;
  /** 事件保留窗口（ms；窗口外 failure/death 仍保留最近的，其余裁剪）。默认 30min。 */
  eventWindowMs?: number;
  /** 每类条目上限（库存/事件）。默认 12。 */
  maxEntriesPerSection?: number;
  nowMs?: number;
};

export type TokenEstimate = {
  value: number;
  method: "estimated-chars-div-4";
};

export type SituationSummary = {
  scope: TeamFactsInput["scope"];
  capturedAtMs: number;
  generatedAtMs: number;
  factVersion: string;
  /** 结构化分区（供验证器/报告复用，不重新解析文本）。 */
  sections: {
    bots: string[];
    team: string[];
    events: string[];
    constraints: string[];
    shortages: string[];
  };
  /** 模型提示用文本（已脱敏、已裁剪）。 */
  text: string;
  tokenEstimate: TokenEstimate;
  /** 裁剪统计（可观测不静默）。 */
  trimmed: {
    eventsDropped: number;
    eventsCompressed: number;
    inventoryItemsDropped: number;
    charactersDropped: number;
  };
};

export class SummaryScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SummaryScopeError";
  }
}

/** 裁剪顺序：①窗口外非 failure/death 事件 ②同类事件压缩 ③库存低价值条目。
 * 永不裁剪：scope、constraints（能力/阶段门/不可抢占/允许范围）、shortages。 */
export function buildSituationSummary(
  input: TeamFactsInput,
  options: SummaryOptions = {},
): SituationSummary {
  if (input.scope.serverProfileId.trim().length === 0 || input.scope.dimension.trim().length === 0) {
    throw new SummaryScopeError("summary requires serverProfileId and dimension; refusing to produce an actionable-scope summary");
  }
  const nowMs = options.nowMs ?? Date.now();
  const maxChars = options.maxChars ?? 4000;
  const eventWindowMs = options.eventWindowMs ?? 30 * 60_000;
  const maxEntries = options.maxEntriesPerSection ?? 12;

  const version = factVersion(input);
  const trimmed = { eventsDropped: 0, eventsCompressed: 0, inventoryItemsDropped: 0, charactersDropped: 0 };

  // ---- 事件：窗口过滤 + 同 (kind, botId, detail) 压缩，failure/death 优先保留。
  const windowFloor = input.scope.observedAtMs - eventWindowMs;
  const priority = (kind: string): number => (kind === "failure" || kind === "death" ? 0 : 1);
  const sorted = [...input.events].sort((a, b) =>
    priority(a.kind) - priority(b.kind) || b.atMs - a.atMs,
  );
  const keptEvents = [];
  const compressed = new Map<string, { count: number; lastAtMs: number; sample: string }>();
  for (const event of sorted) {
    const compressible = event.kind !== "failure" && event.kind !== "death";
    if (event.atMs < windowFloor && compressible) {
      trimmed.eventsDropped += 1;
      continue;
    }
    if (compressible) {
      const key = `${event.kind}|${event.botId ?? "-"}|${scrubFreeText(event.detail)}`;
      const existing = compressed.get(key);
      if (existing) {
        existing.count += 1;
        existing.lastAtMs = Math.max(existing.lastAtMs, event.atMs);
        trimmed.eventsCompressed += 1;
        continue;
      }
      compressed.set(key, { count: 1, lastAtMs: event.atMs, sample: event.source });
    }
    keptEvents.push(event);
    if (keptEvents.length >= maxEntries) {
      // 条目上限截断：剩余事件计入 dropped（可观测，不静默丢弃）。
      trimmed.eventsDropped += sorted.length - keptEvents.length - trimmed.eventsDropped - trimmed.eventsCompressed;
      break;
    }
  }

  // ---- Bot 分区（unknown 显式表达）。
  const botLines = input.bots.map((bot) => {
    const task = bot.currentTask === "unknown"
      ? "task=unknown"
      : bot.currentTask === null
        ? "task=idle"
        : `task="${scrubFreeText(bot.currentTask.goalText)}" phase=${bot.currentTask.phase}`;
    const inventory = bot.inventory === "unknown"
      ? "inventory=unknown"
      : `inventory=${summarizeInventory(bot.inventory, maxEntries, trimmed)}`;
    return [
      `- ${bot.botId} online=${bot.online} ${task}`,
      `  health=${fmt(bot.survival.health)} food=${fmt(bot.survival.food)} armor=${fmt(bot.survival.armorPoints)} deaths=${fmt(bot.deaths)}`,
      `  ${inventory}`,
    ].join("\n");
  });

  // ---- 团队分区。
  const teamLines: string[] = [];
  teamLines.push(
    input.team.sharedInventory === "unknown"
      ? "- sharedInventory=unknown"
      : `- sharedInventory=${summarizeInventory(input.team.sharedInventory, maxEntries, trimmed)}`,
  );
  teamLines.push(
    input.team.facilities === "unknown"
      ? "- facilities=unknown"
      : input.team.facilities.length === 0
        ? "- facilities=none-known"
        : `- facilities=${input.team.facilities
            .slice(0, maxEntries)
            .map((f: Facility) => `${f.facilityId}(${f.kind},${f.status})`)
            .join(", ")}`,
  );
  for (const reservation of input.team.reservedResources.slice(0, maxEntries)) {
    teamLines.push(`- reserved=${reservation.resource} by=${reservation.heldByBotId}`);
  }

  // ---- 约束分区（永不裁剪）。
  const constraintLines = [
    `- allowedChangeScope: ${scrubFreeText(input.constraints.allowedChangeScope)}`,
    `- nonPreemptibleBots: ${input.constraints.nonPreemptibleBots.length > 0 ? input.constraints.nonPreemptibleBots.join(", ") : "none"}`,
    `- capabilities: ${input.constraints.capabilities
        .filter((c) => c.supported)
        .slice(0, 40)
        .map((c) => c.skillId)
        .join(", ")}${input.constraints.capabilities.filter((c) => c.supported).length > 40 ? " …" : ""}`,
    ...input.constraints.phaseGates.map(
      (gate) => `- gate ${gate.gate}: ${fmt(gate.satisfied)}`,
    ),
  ];

  const eventLines = keptEvents.map((event) => {
    const key = `${event.kind}|${event.botId ?? "-"}|${scrubFreeText(event.detail)}`;
    const extra = compressed.get(key);
    const countSuffix = extra && extra.count > 1 ? ` (x${extra.count})` : "";
    return `- ${event.kind}${event.botId ? `[${event.botId}]` : ""} at=${event.atMs} src=${event.source}${countSuffix}: ${scrubFreeText(event.detail)}`;
  });

  const sections = {
    bots: botLines,
    team: teamLines,
    events: eventLines,
    constraints: constraintLines,
    shortages: input.team.shortages.map((s) => scrubFreeText(s)),
  };

  const header = [
    `SCOPE server=${input.scope.serverProfileId} dim=${input.scope.dimension}${input.scope.sessionEpoch !== undefined ? ` sessionEpoch=${input.scope.sessionEpoch}` : ""}`,
    `FACTS capturedAt=${input.capturedAtMs} observedAt=${input.scope.observedAtMs} version=${version}`,
  ].join("\n");

  const full = [
    header,
    `SHORTAGES: ${sections.shortages.length > 0 ? sections.shortages.join("; ") : "none-observed"}`,
    // 约束区紧跟作用域/短缺——末级字符截断从尾部裁，约束事实永不丢
    // （§4：裁剪不能丢掉用于判断是否允许行动的事实）。
    "CONSTRAINTS:",
    ...sections.constraints,
    "TEAM:",
    ...sections.team,
    "BOTS:",
    ...sections.bots,
    "RECENT EVENTS:",
    ...(sections.events.length > 0 ? sections.events : ["- none-in-window"]),
  ].join("\n");

  // 末级保护：仍超上限时从事件尾部向下截断（约束/短缺/团队/bot 顺序保留）。
  let text = full;
  if (text.length > maxChars) {
    const lines = text.split("\n");
    const kept: string[] = [];
    let used = 0;
    for (const line of lines) {
      if (used + line.length + 1 > maxChars) {
        trimmed.charactersDropped += text.length - used;
        break;
      }
      kept.push(line);
      used += line.length + 1;
    }
    text = kept.join("\n");
  }

  return {
    scope: input.scope,
    capturedAtMs: input.capturedAtMs,
    generatedAtMs: nowMs,
    factVersion: version,
    sections,
    text,
    tokenEstimate: { value: Math.ceil(text.length / 4), method: "estimated-chars-div-4" },
    trimmed,
  };
}

function fmt(value: number | boolean | "unknown"): string {
  return value === "unknown" ? "unknown" : String(value);
}

function summarizeInventory(
  items: InventoryItem[],
  maxEntries: number,
  trimmed: { inventoryItemsDropped: number },
): string {
  const sorted = [...items].sort((a, b) => b.count - a.count);
  const kept = sorted.slice(0, maxEntries);
  trimmed.inventoryItemsDropped += Math.max(0, sorted.length - kept.length);
  return kept.map((item) => `${item.itemName}x${item.count}`).join(", ");
}
