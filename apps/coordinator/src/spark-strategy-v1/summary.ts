import { factVersion, scrubFreeText, type TeamFactsInput } from "./facts.js";

export type SummaryOptions = { maxChars?: number; eventWindowMs?: number; maxEntriesPerSection?: number; nowMs?: number };
export type TokenEstimate = { value: number; method: "estimated-chars-div-4" };
export type SituationSummary = {
  scope: TeamFactsInput["scope"];
  capturedAtMs: number;
  generatedAtMs: number;
  factVersion: string;
  sections: { bots: string[]; team: string[]; events: string[]; constraints: string[]; shortages: string[] };
  text: string;
  tokenEstimate: TokenEstimate;
  trimmed: { eventsDropped: number; eventsCompressed: number; inventoryItemsDropped: number; charactersDropped: number };
};
export class SummaryScopeError extends Error {}
export class SummaryBudgetError extends Error {
  constructor(readonly requiredChars: number, readonly maxChars: number) {
    super(`mandatory summary requires ${requiredChars} chars; budget=${maxChars}`);
    this.name = "SummaryBudgetError";
  }
}

export function buildSituationSummary(input: TeamFactsInput, options: SummaryOptions = {}): SituationSummary {
  if (!input.scope.serverProfileId.trim() || !input.scope.dimension.trim()) throw new SummaryScopeError("summary requires serverProfileId and dimension");
  const maxChars = options.maxChars ?? 4000;
  const maxEntries = options.maxEntriesPerSection ?? 12;
  const eventWindow = options.eventWindowMs ?? 30 * 60_000;
  if (!Number.isSafeInteger(maxChars) || maxChars < 1 || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isFinite(eventWindow) || eventWindow < 0) throw new RangeError("invalid summary budget");
  const version = factVersion(input);
  const trimmed = { eventsDropped: 0, eventsCompressed: 0, inventoryItemsDropped: 0, charactersDropped: 0 };
  const sections: SituationSummary["sections"] = {
    shortages: input.team.shortages.map(scrubFreeText),
    constraints: [
      `- allowedChangeScope: ${scrubFreeText(input.constraints.allowedChangeScope)}`,
      `- nonPreemptibleBots: ${input.constraints.nonPreemptibleBots.join(", ") || "none"}`,
      `- capabilities: ${input.constraints.capabilities.map((c) => `${c.skillId}=${c.supported}`).join(", ")}`,
      ...input.constraints.phaseGates.map((g) => `- gate ${g.gate}${g.botId ? `[${g.botId}]` : ""}: ${g.satisfied}`),
    ],
    bots: input.bots.map((bot) => {
      const task = bot.currentTask === "unknown" ? "unknown" : bot.currentTask === null ? "idle" : `active:${scrubFreeText(bot.currentTask.phase)}`;
      return `- ${bot.botId} online=${bot.online} task=${task} health=${bot.survival.health} food=${bot.survival.food} armor=${bot.survival.armorPoints} deaths=${bot.deaths} inventory=${bot.inventory === "unknown" ? "unknown" : bot.inventory.length === 0 ? "empty" : "partial-details-below"}`;
    }),
    team: [
      `- sharedInventory=${input.team.sharedInventory === "unknown" ? "unknown" : input.team.sharedInventory.length === 0 ? "empty" : "partial-details-below"}`,
      ...(input.team.facilities === "unknown" ? ["- facilities=unknown"] : input.team.facilities.length === 0 ? ["- facilities=none-known"]
        : input.team.facilities.map((f) => `- facility=${f.facilityId} kind=${f.kind} status=${f.status} heldBy=${f.heldByBotId ?? "unknown"}`)),
      ...input.team.reservedResources.map((r) => `- reserved=${r.resource} by=${r.heldByBotId}`),
    ],
    events: [],
  };
  const header = [
    `SCOPE server=${input.scope.serverProfileId} dim=${input.scope.dimension}${input.scope.sessionEpoch !== undefined ? ` sessionEpoch=${input.scope.sessionEpoch}` : ""}${input.scope.snapshotId ? ` snapshotId=${input.scope.snapshotId}` : ""}`,
    `FACTS capturedAt=${input.capturedAtMs} observedAt=${input.scope.observedAtMs} version=${version}`,
  ];
  const render = () => [...header, `SHORTAGES: ${sections.shortages.join("; ") || "none-observed"}`,
    "CONSTRAINTS:", ...sections.constraints, "TEAM:", ...sections.team, "BOTS:", ...sections.bots,
    ...(sections.events.length ? ["RECENT EVENTS:", ...sections.events] : [])].join("\n");
  const mandatory = render();
  if (mandatory.length > maxChars) throw new SummaryBudgetError(mandatory.length, maxChars);
  const tryLine = (list: string[], line: string): boolean => {
    list.push(line);
    if (render().length <= maxChars) return true;
    list.pop();
    trimmed.charactersDropped += line.length + 1;
    return false;
  };

  // Optional details spend only the budget remaining after every action constraint.
  const groups = new Map<string, { text: string; count: number; at: number; priority: number }>();
  for (const event of input.events) {
    const priority = event.kind === "failure" || event.kind === "death" ? 0 : 1;
    if (priority === 1 && event.atMs < input.scope.observedAtMs - eventWindow) { trimmed.eventsDropped++; continue; }
    const text = `- ${event.kind}[${event.botId ?? "team"}] src=${scrubFreeText(event.source)}: ${scrubFreeText(event.detail)}`;
    const group = groups.get(text);
    if (group) { group.count++; group.at = Math.max(group.at, event.atMs); }
    else groups.set(text, { text, count: 1, at: event.atMs, priority });
  }
  let entries = 0;
  for (const group of [...groups.values()].sort((a, b) => a.priority - b.priority || b.at - a.at || a.text.localeCompare(b.text))) {
    const line = `${group.text} at=${group.at}${group.count > 1 ? ` (x${group.count})` : ""}`;
    if (entries < maxEntries && tryLine(sections.events, line)) { entries++; trimmed.eventsCompressed += group.count - 1; }
    else {
      trimmed.eventsDropped += group.count;
      if (entries >= maxEntries) trimmed.charactersDropped += line.length + 1;
    }
  }
  const inventoryGroups = [
    { owner: "shared", items: input.team.sharedInventory, lines: sections.team },
    ...input.bots.map((b) => ({ owner: b.botId, items: b.inventory, lines: sections.bots })),
  ];
  for (const group of inventoryGroups) {
    if (group.items === "unknown") continue;
    let kept = 0;
    for (const item of [...group.items].sort((a, b) => b.count - a.count || a.itemName.localeCompare(b.itemName))) {
      const line = `- inventory[${group.owner}] ${item.itemName}x${item.count}`;
      if (kept < maxEntries && tryLine(group.lines, line)) kept++;
      else {
        trimmed.inventoryItemsDropped++;
        if (kept >= maxEntries) trimmed.charactersDropped += line.length + 1;
      }
    }
  }
  const text = render();
  return { scope: input.scope, capturedAtMs: input.capturedAtMs, generatedAtMs: options.nowMs ?? Date.now(), factVersion: version,
    sections, text, tokenEstimate: { value: Math.ceil(text.length / 4), method: "estimated-chars-div-4" }, trimmed };
}
