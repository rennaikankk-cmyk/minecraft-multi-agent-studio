// ---------------------------------------------------------------------------
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
