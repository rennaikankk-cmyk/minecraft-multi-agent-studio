// ---------------------------------------------------------------------------
// F-B4：Overview / 全局状态栏的统一数据装载。
//
// 旧实现把每个请求都写成 `.then(r => r.json()).catch(() => null)`，于是
// 「后端不可用」被静默降级成 `bots = []`、`incidents = 0`，页面显示
// 「Bots 0/0」「没有已注册的 Bot」这种假健康态，`failed`/`stale` 永远不可达
// （违反 ARCHITECTURE.md §10、AGENTS.md §1.6/§2.10）。
//
// 本模块的契约：
//   * 每个数据源要么是**真实数据**（允许真实的空数组 / 0），要么是 `null`
//     ——表示「无法确认」，绝不把失败伪装成 0；
//   * 无法确认的数据源记入 `unavailable`，并合成人类可读的 `failureMessage`；
//   * 注意 `/api/incidents`、`/api/servers`、`/api/servers/local-test` 即使后端
//     不可用也返回 HTTP 200（正文里用 status / reachable 标记），因此不能只看
//     `response.ok`，必须做正文形态校验；
//   * `loadDashboardStatus()` 永不抛异常（每个数据源独立兜底）。
// ---------------------------------------------------------------------------

export interface OverviewBotSummary {
  botId: string;
  username?: string;
  connectionState: string;
  currentTask?: { title: string | null } | null;
}

export interface OverviewIncidentIssue {
  incidentId: string;
  type: string;
  primaryFailureCode: string;
  suspectedLayer: string;
  status: string;
  maxSeverity: string;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrenceCount: number;
}

export interface OverviewServerConnection {
  endpoint: string;
  counts: { ready: number; failed: number };
}

export interface OverviewSparkStatus {
  state: string;
  model: string | null;
  latencyMs: number | null;
}

export interface OverviewLocalTest {
  status: string;
  desiredState: string;
  managedByStudio: boolean;
}

export interface OverviewStudioStatus {
  sessionId?: string | null;
  ai?: OverviewSparkStatus | null;
  capabilities?: unknown;
}

export type UnavailableSource =
  | "Studio 状态"
  | "Local Test"
  | "Bot 列表"
  | "Incident 列表"
  | "Server 连接"
  | "Control API 连接态";

export interface DashboardStatusSnapshot {
  readonly studio: OverviewStudioStatus | null;
  readonly localTest: OverviewLocalTest | null;
  /** `null` = 无法确认；`[]` = 后端真实返回「没有 Bot」。 */
  readonly bots: OverviewBotSummary[] | null;
  /** `null` = 无法确认。 */
  readonly incidents: OverviewIncidentIssue[] | null;
  /** `null` = 无法确认。 */
  readonly servers: OverviewServerConnection[] | null;
  readonly unavailable: readonly UnavailableSource[];
  readonly failureMessage: string | null;
}

export interface GlobalStatusView {
  studioMode: "NORMAL" | "LOCAL_TEST" | "E2E" | "UNKNOWN";
  localTest: { status: "online" | "starting" | "not_running" | "unknown"; managedByStudio: boolean } | null;
  /** true = Local Test 观察态无法确认（`localTest === null` 不等于「未运行」）。 */
  localTestUnknown: boolean;
  bots: { online: number; total: number } | null;
  incidents: { open: number; critical: number } | null;
  spark: { state: string; model: string | null; latencyMs: number | null } | null;
  lastRefreshAt: string | null;
  stale: boolean;
}

type JsonRecord = Record<string, unknown>;

export async function loadDashboardStatus(
  fetchImplementation: typeof fetch = fetch,
): Promise<DashboardStatusSnapshot> {
  // 每个数据源独立兜底：网络错误 / 非 JSON / 非 2xx 一律返回 null，绝不抛出。
  const read = async (path: string): Promise<unknown> => {
    try {
      const response = await fetchImplementation(path, { cache: "no-store" });
      return await response.json();
    } catch {
      return null;
    }
  };
  const [studioBody, localBody, botsBody, incidentsBody, serversBody] = await Promise.all([
    read("/api/studio/status"),
    read("/api/servers/local-test"),
    read("/api/bots"),
    read("/api/incidents?limit=100"),
    read("/api/servers"),
  ]);

  const botsRecord = asRecord(botsBody);
  const botsData = asRecord(botsRecord?.data);
  const bots = Array.isArray(botsData?.bots) ? (botsData.bots as OverviewBotSummary[]) : null;
  const incidentsRecord = asRecord(incidentsBody);
  const incidents =
    incidentsRecord?.status === "ok" && Array.isArray(incidentsRecord.issues)
      ? (incidentsRecord.issues as OverviewIncidentIssue[])
      : null;
  const localRecord = asRecord(localBody);
  const localResource = localRecord?.status === "ok" ? asRecord(localRecord.resource) : null;
  const studioRecord = asRecord(studioBody);
  const studio =
    studioRecord !== null && asRecord(studioRecord.capabilities) !== null
      ? (studioRecord as OverviewStudioStatus)
      : null;
  const serversRecord = asRecord(serversBody);
  const servers =
    serversRecord?.managerReachable === true && Array.isArray(serversRecord.servers)
      ? (serversRecord.servers as OverviewServerConnection[])
      : null;

  const unavailable: UnavailableSource[] = [];
  if (studio === null) unavailable.push("Studio 状态");
  if (localRecord?.status !== "ok") unavailable.push("Local Test");
  if (bots === null) unavailable.push("Bot 列表");
  if (incidents === null) unavailable.push("Incident 列表");
  if (servers === null) unavailable.push("Server 连接");
  // Connection API 不可达时服务器分组仍来自 manager 进程态，但「在线」结论不可信。
  else if (serversRecord?.controlApiReachable !== true) unavailable.push("Control API 连接态");

  return {
    studio,
    localTest: localResource as OverviewLocalTest | null,
    bots,
    incidents,
    servers,
    unavailable,
    failureMessage: unavailable.length === 0
      ? null
      : `无法确认：${unavailable.join("、")}（后端不可用或未配置；显示为「—」而不是 0/空，不保留"在线"假象）。`,
  };
}

/** 把数据快照映射成全局状态栏视图（不伪造 0/0，无法确认时保持 null）。 */
export function toGlobalStatusView(
  snapshot: DashboardStatusSnapshot,
  nowIso: string,
): GlobalStatusView {
  const resource = snapshot.localTest;
  const bots = snapshot.bots;
  const issues = snapshot.incidents;
  const openIssues = (issues ?? []).filter(
    (issue) => issue.status === "open" || issue.status === "investigating",
  );
  return {
    studioMode:
      snapshot.studio !== null && typeof snapshot.studio.sessionId === "string"
        ? resource?.desiredState === "on" || resource?.status === "online"
          ? "LOCAL_TEST"
          : "NORMAL"
        : "UNKNOWN",
    localTest: resource
      ? {
          status:
            resource.status === "online"
              ? "online"
              : resource.status === "starting"
                ? "starting"
                : resource.status === "not_running"
                  ? "not_running"
                  : "unknown",
          managedByStudio: Boolean(resource.managedByStudio),
        }
      : null,
    localTestUnknown: snapshot.unavailable.includes("Local Test"),
    bots: bots === null
      ? null
      : {
          online: bots.filter((bot) => bot.connectionState === "online").length,
          total: bots.length,
        },
    incidents: issues === null
      ? null
      : {
          open: openIssues.length,
          critical: openIssues.filter((issue) => issue.maxSeverity === "CRITICAL").length,
        },
    spark: snapshot.studio?.ai
      ? {
          state: snapshot.studio.ai.state,
          model: snapshot.studio.ai.model,
          latencyMs: snapshot.studio.ai.latencyMs,
        }
      : null,
    lastRefreshAt: nowIso,
    stale: snapshot.unavailable.length > 0,
  };
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}
