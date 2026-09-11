// ---------------------------------------------------------------------------
import { farmProductionSchema, type FarmProduction } from '@minecraft-studio/skills';
import { type BasePhaseFact } from '@minecraft-studio/base-management';
// Shared State 客户端（服务端专用）
//
// 数据流：浏览器 → dashboard API route（本文件，token 只在 Node 侧）
//        → Coordinator SharedStateServer GET /snapshot
// 契约：
//   - token / URL 只从环境变量读取，永不进入浏览器响应
//   - 未配置 / 不可达 → 结构化 unavailable 状态（前端如实显示，不伪造数据）
//   - 视图模型在此聚合：bases/facilities/workstations 摘要计数
// ---------------------------------------------------------------------------

export interface SharedStateSlotView {
  slotId: string;
  index: number;
  workstationType: string;
  status: string;
  reservedBy: string | null;
  statusReason: string | null;
  failureCount: number;
  worldPosition: { x: number; y: number; z: number };
}

export interface SharedStateFacilityView {
  id: string;
  facilityType: string;
  serverProfileId: string;
  dimension: string;
  baseId: string | null;
  anchor: { x: number; y: number; z: number };
  lifecycle: "planned" | "observed_existing";
  slotCounts: Record<string, number>;
  slots: SharedStateSlotView[];
  production?: FarmProduction | null;
}

export interface SharedStateWorkstationView {
  type: string;
  serverProfileId: string;
  dimension: string;
  position: { x: number; y: number; z: number };
  usageMode: string;
  lastSeenAt: number;
  leaseOwnerBotId: string | null;
  leaseExpiresAtMs: number | null;
}

export interface SharedStateBaseView {
  id: string;
  name: string;
  serverProfileId: string;
  dimension: string;
  anchor: { x: number; y: number; z: number };
  blueprintId: string;
  status: string;
  integrity01: number;
  placedCells: number;
  facilityCount: number;
  updatedAt: string;
  source?: "bot_built" | "operator_adopted";
  memberBotIds?: string[];
  phaseFacts?: Record<string, BasePhaseFact>;
  protectedBounds?: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null;
}

export interface SharedStateView {
  schemaVersion: "1.0";
  generatedAt: string;
  savedAt: string | null;
  bases: SharedStateBaseView[];
  facilities: SharedStateFacilityView[];
  workstations: SharedStateWorkstationView[];
}

export type SharedStateResult =
  | Readonly<{ status: "ok"; view: SharedStateView }>
  | Readonly<{ status: "not_configured" }>
  | Readonly<{ status: "unreachable"; detail: string }>;

export interface SharedStateConfig {
  baseUrl: string;
  token: string | undefined;
}

export function loadSharedStateConfig(
  env: NodeJS.ProcessEnv = process.env,
): SharedStateConfig | null {
  const baseUrl = env.STUDIO_SHARED_STATE_URL?.trim();
  if (!baseUrl) return null;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    token: env.STUDIO_SHARED_STATE_TOKEN,
  };
}

interface SnapshotFacilitySlot {
  slotId?: string;
  index?: number;
  workstationType?: string;
  status?: string;
  reservedBy?: string | null;
  statusReason?: string | null;
  failureCount?: number;
  worldPosition?: { x: number; y: number; z: number };
}

interface SnapshotFacility {
  id?: string;
  facilityType?: string;
  serverProfileId?: string;
  dimension?: string;
  baseId?: string | null;
  anchor?: { x: number; y: number; z: number };
  discovery?: string;
  slots?: SnapshotFacilitySlot[];
  metadata?: { production?: unknown };
}

interface SnapshotBase {
  id?: string;
  name?: string;
  serverProfileId?: string;
  dimension?: string;
  anchor?: { x: number; y: number; z: number };
  blueprintId?: string;
  status?: string;
  integrity01?: number;
  placedCells?: number;
  updatedAt?: string;
  source?: "bot_built" | "operator_adopted";
  memberBotIds?: string[];
  phaseFacts?: Record<string, BasePhaseFact>;
  protectedBounds?: SharedStateBaseView["protectedBounds"];
}

interface SnapshotWorkstation {
  type?: string;
  serverProfileId?: string;
  dimension?: string;
  position?: { x: number; y: number; z: number };
  usageMode?: string;
  lastSeenAt?: number;
  lease?: { ownerBotId?: string; expiresAtMs?: number } | null;
}

interface Snapshot {
  savedAt?: string;
  workstations?: { entries?: SnapshotWorkstation[] };
  facilities?: { facilities?: SnapshotFacility[] };
  bases?: { bases?: SnapshotBase[] };
}

/** 把 durable snapshot 聚合成 UI 视图模型（纯函数，供测试）。 */
export function toSharedStateView(snapshot: Snapshot): SharedStateView {
  const facilities = (snapshot.facilities?.facilities ?? []).map((facility): SharedStateFacilityView => {
    const slots = (facility.slots ?? []).map((slot, index) => ({
      slotId: slot.slotId ?? `${facility.id}#${index}`,
      index: slot.index ?? index,
      workstationType: slot.workstationType ?? "unknown",
      status: slot.status ?? "unknown",
      reservedBy: slot.reservedBy ?? null,
      statusReason: slot.statusReason ?? null,
      failureCount: slot.failureCount ?? 0,
      worldPosition: slot.worldPosition ?? { x: 0, y: 0, z: 0 },
    }));
    const slotCounts: Record<string, number> = {};
    for (const slot of slots) slotCounts[slot.status] = (slotCounts[slot.status] ?? 0) + 1;
    const production = farmProductionSchema.safeParse(facility.metadata?.production);
    return {
      id: facility.id ?? "unknown-facility",
      facilityType: facility.facilityType ?? "unknown",
      serverProfileId: facility.serverProfileId ?? "unknown",
      dimension: facility.dimension ?? "minecraft:overworld",
      baseId: facility.baseId ?? null,
      anchor: facility.anchor ?? { x: 0, y: 0, z: 0 },
      lifecycle: facility.discovery === "observed_existing" ? "observed_existing" : "planned",
      slotCounts,
      slots,
      production: production.success && production.data.input.area.serverProfileId === facility.serverProfileId &&
        production.data.input.area.dimension === facility.dimension ? production.data : null,
    };
  });

  const bases = (snapshot.bases?.bases ?? []).map((base): SharedStateBaseView => ({
    id: base.id ?? "unknown-base",
    name: base.name ?? base.id ?? "unnamed",
    serverProfileId: base.serverProfileId ?? "unknown",
    dimension: base.dimension ?? "minecraft:overworld",
    anchor: base.anchor ?? { x: 0, y: 0, z: 0 },
    blueprintId: base.blueprintId ?? "unknown",
    status: base.status ?? "unknown",
    integrity01: base.integrity01 ?? 0,
    placedCells: base.placedCells ?? 0,
    facilityCount: facilities.filter((facility) => facility.baseId === (base.id ?? "unknown-base")).length,
    updatedAt: base.updatedAt ?? new Date(0).toISOString(),
    source: base.source ?? "bot_built",
    memberBotIds: base.memberBotIds ?? [],
    protectedBounds: base.protectedBounds ?? null,
    phaseFacts: Object.fromEntries(Object.entries(base.phaseFacts ?? {}).map(([key, fact]) => {
      const age = Date.now() - Date.parse(fact.observedAt);
      return [key, { ...fact, availability: key !== "BASE_SITE_RESERVED" && (!Number.isFinite(age) || age < -5_000 || age > 60_000) ? "UNVERIFIED" : fact.availability }];
    })),
  }));

  const workstations = (snapshot.workstations?.entries ?? []).map((entry): SharedStateWorkstationView => ({
    type: entry.type ?? "unknown",
    serverProfileId: entry.serverProfileId ?? "unknown",
    dimension: entry.dimension ?? "minecraft:overworld",
    position: entry.position ?? { x: 0, y: 0, z: 0 },
    usageMode: entry.usageMode ?? "shared",
    lastSeenAt: entry.lastSeenAt ?? 0,
    leaseOwnerBotId: entry.lease?.ownerBotId ?? null,
    leaseExpiresAtMs: entry.lease?.expiresAtMs ?? null,
  }));

  return {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    savedAt: snapshot.savedAt ?? null,
    bases,
    facilities,
    workstations,
  };
}

export async function fetchSharedStateView(
  config: SharedStateConfig | null,
  { timeoutMs = 4_000 }: { timeoutMs?: number } = {},
): Promise<SharedStateResult> {
  if (!config) return { status: "not_configured" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {};
    if (config.token) headers.Authorization = `Bearer ${config.token}`;
    const response = await fetch(`${config.baseUrl}/snapshot`, {
      headers,
      signal: controller.signal,
      cache: "no-store",
    });
    if (response.status === 401 || response.status === 403) {
      return { status: "unreachable", detail: `unauthorized (HTTP ${response.status})` };
    }
    if (!response.ok) {
      return { status: "unreachable", detail: `HTTP ${response.status}` };
    }
    const snapshot = (await response.json()) as Snapshot;
    return { status: "ok", view: toSharedStateView(snapshot) };
  } catch (error) {
    return { status: "unreachable", detail: error instanceof Error ? error.message : "unknown" };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Gap Console（D4）：skill gaps / releases / lessons 的受限代理视图。
// 契约与 snapshot 相同：token 只在 Node 侧，未配置/不可达如实 unavailable。
// ---------------------------------------------------------------------------

export interface SkillGapView {
  fingerprint: string;
  kind: string;
  severity: string;
  occurrenceCount: number;
  actionFamily: string;
  terminalFailureCode: string;
  requestedSkillId: string | null;
  serverProfileId: string;
  lastSeenAtMs: number;
}

export interface CompositionSuggestionView {
  fingerprint: string;
  skillIds: string[];
  rationale: string | null;
}

export interface SkillReleaseView {
  releaseId: string;
  skillId: string;
  status: string;
  gapFingerprint: string;
  evidenceCount: number;
  updatedAtMs: number;
}

export type GapConsoleResult =
  | { status: "ok"; gaps: SkillGapView[]; suggestions: CompositionSuggestionView[]; releases: SkillReleaseView[] }
  | { status: "not_configured" | "unreachable"; detail?: string };

async function sharedStateFetch(
  config: SharedStateConfig,
  pathname: string,
  init: { method: "GET" | "POST"; body?: unknown; timeoutMs?: number },
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 4_000);
  try {
    const headers: Record<string, string> = {};
    if (config.token) headers.Authorization = `Bearer ${config.token}`;
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${config.baseUrl}${pathname}`, {
      method: init.method,
      headers,
      signal: controller.signal,
      cache: "no-store",
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const json = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, json };
  } finally {
    clearTimeout(timer);
  }
}

function toGapView(gap: Record<string, unknown>): SkillGapView {
  const gapDetail = (gap.gap ?? {}) as Record<string, unknown>;
  return {
    fingerprint: String(gap.fingerprint ?? ""),
    kind: String(gap.kind ?? "unknown"),
    severity: String(gap.severity ?? "info"),
    occurrenceCount: Number(gap.occurrenceCount ?? 0),
    actionFamily: String(gapDetail.actionFamily ?? "general"),
    terminalFailureCode: String(gapDetail.terminalFailureCode ?? ""),
    requestedSkillId: typeof gapDetail.requestedSkillId === "string" ? gapDetail.requestedSkillId : null,
    serverProfileId: String((gap.runtime as Record<string, unknown> | undefined)?.serverProfileId ?? ""),
    lastSeenAtMs: Number(gap.lastSeenAtMs ?? 0),
  };
}

export async function fetchGapConsole(config: SharedStateConfig | null): Promise<GapConsoleResult> {
  if (!config) return { status: "not_configured" };
  try {
    const gaps = await sharedStateFetch(config, "/skill-gaps", { method: "GET" });
    if (!gaps.ok) return { status: "unreachable", detail: `gaps HTTP ${gaps.status}` };
    const releases = await sharedStateFetch(config, "/skill-releases", { method: "GET" });
    const payload = gaps.json as {
      gaps?: Array<Record<string, unknown>>;
      compositionSuggestions?: Array<{ fingerprint?: string; suggestion?: { skillIds?: string[]; rationale?: string } | null }>;
    };
    const releasePayload = (releases.json ?? {}) as { releases?: Array<Record<string, unknown>> };
    return {
      status: "ok",
      gaps: (payload.gaps ?? []).map(toGapView),
      suggestions: (payload.compositionSuggestions ?? []).map((entry) => ({
        fingerprint: String(entry.fingerprint ?? ""),
        skillIds: entry.suggestion?.skillIds ?? [],
        rationale: entry.suggestion?.rationale ?? null,
      })),
      releases: (releasePayload.releases ?? []).map((release) => ({
        releaseId: String(release.releaseId ?? ""),
        skillId: String(release.skillId ?? ""),
        status: String(release.status ?? ""),
        gapFingerprint: String(release.gapFingerprint ?? ""),
        evidenceCount: Array.isArray(release.evidence) ? release.evidence.length : 0,
        updatedAtMs: Number(release.updatedAtMs ?? 0),
      })),
    };
  } catch (error) {
    return { status: "unreachable", detail: error instanceof Error ? error.message : "unknown" };
  }
}

export type ReleaseActionResult =
  | { status: "ok"; releaseId?: string; implementationPrompt?: string; releaseStatus?: string }
  | { status: "not_configured" | "unreachable" | "rejected"; detail?: string };

export async function createReleaseDraft(config: SharedStateConfig | null, gapFingerprint: string): Promise<ReleaseActionResult> {
  if (!config) return { status: "not_configured" };
  try {
    const result = await sharedStateFetch(config, "/skill-releases", {
      method: "POST",
      body: { action: "create-draft", gapFingerprint },
      timeoutMs: 8_000,
    });
    const json = (result.json ?? {}) as { ok?: boolean; error?: string; releaseId?: string; implementationPrompt?: string };
    if (!result.ok || json.ok !== true) return { status: "rejected", detail: json.error ?? `HTTP ${result.status}` };
    return {
      status: "ok",
      ...(json.releaseId !== undefined ? { releaseId: json.releaseId } : {}),
      ...(json.implementationPrompt !== undefined ? { implementationPrompt: json.implementationPrompt } : {}),
    };
  } catch (error) {
    return { status: "unreachable", detail: error instanceof Error ? error.message : "unknown" };
  }
}

export async function releaseOperatorDecision(
  config: SharedStateConfig | null,
  input: { releaseId: string; decision: "promote-canary" | "promote-active" | "revoke"; operator: string; note?: string },
): Promise<ReleaseActionResult> {
  if (!config) return { status: "not_configured" };
  try {
    const result = await sharedStateFetch(config, "/skill-releases", {
      method: "POST",
      body: { action: "operator-decision", ...input },
      timeoutMs: 8_000,
    });
    const json = (result.json ?? {}) as { ok?: boolean; error?: string; status?: string };
    if (!result.ok || json.ok !== true) return { status: "rejected", detail: json.error ?? `HTTP ${result.status}` };
    return {
      status: "ok",
      ...(json.status !== undefined ? { releaseStatus: json.status } : {}),
    };
  } catch (error) {
    return { status: "unreachable", detail: error instanceof Error ? error.message : "unknown" };
  }
}

export interface LessonCardView {
  lessonId: string;
  kind: string;
  goalPattern: string;
  advice: string;
  confidence: number;
  observedAtMs: number;
}

export type LessonListResult =
  | { status: "ok"; lessons: LessonCardView[] }
  | { status: "not_configured" | "unreachable"; detail?: string };

export async function fetchLessons(config: SharedStateConfig | null, serverProfileId: string): Promise<LessonListResult> {
  if (!config) return { status: "not_configured" };
  try {
    const result = await sharedStateFetch(config, `/lessons?serverProfileId=${encodeURIComponent(serverProfileId)}`, { method: "GET" });
    if (!result.ok) return { status: "unreachable", detail: `HTTP ${result.status}` };
    const payload = (result.json ?? {}) as { lessons?: Array<Record<string, unknown>> };
    return {
      status: "ok",
      lessons: (payload.lessons ?? []).map((lesson) => ({
        lessonId: String(lesson.lessonId ?? ""),
        kind: String(lesson.kind ?? ""),
        goalPattern: String(((lesson.trigger ?? {}) as Record<string, unknown>).goalPattern ?? ""),
        advice: String(lesson.advice ?? ""),
        confidence: Number(lesson.confidence ?? 0),
        observedAtMs: Number(lesson.observedAtMs ?? 0),
      })),
    };
  } catch (error) {
    return { status: "unreachable", detail: error instanceof Error ? error.message : "unknown" };
  }
}

export async function requestLessonReview(config: SharedStateConfig | null, serverProfileId: string): Promise<ReleaseActionResult> {
  if (!config) return { status: "not_configured" };
  try {
    const result = await sharedStateFetch(config, "/lessons/review", {
      method: "POST",
      body: { serverProfileId },
      timeoutMs: 8_000,
    });
    const json = (result.json ?? {}) as { ok?: boolean; review?: { queued?: boolean; reason?: string } };
    if (!result.ok) return { status: "rejected", detail: `HTTP ${result.status}` };
    if (json.review && json.review.queued === false) {
      return { status: "rejected", detail: json.review.reason ?? "cooldown" };
    }
    return { status: "ok" };
  } catch (error) {
    return { status: "unreachable", detail: error instanceof Error ? error.message : "unknown" };
  }
}
