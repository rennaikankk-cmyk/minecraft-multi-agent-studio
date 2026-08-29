import { randomUUID } from "node:crypto";

import type { PublicBotDetailV1, StudioManagerStatusV1 } from "@minecraft-studio/protocol";
import { NextResponse } from "next/server";

import {
  DashboardControlError,
  fetchDashboardBots,
  loadDashboardControlConfig,
} from "@/lib/control-api-client";
import {
  fetchStudioManagerStatus,
  loadStudioManagerConfig,
  StudioManagerClientError,
} from "@/lib/studio-manager-client";

export const dynamic = "force-dynamic";

export interface ServerBotMembershipView {
  botId: string;
  username: string;
  processState: string;
  connectionState: string | null;
  healthCurrent: number | null;
  latencyMs: number | null;
  position: string | null;
  lastError: string | null;
}

export interface ServerSummaryView {
  /** host:port —— 分组键；真实 identity 由后端持有。 */
  endpoint: string;
  host: string;
  port: number;
  minecraftVersion: string;
  bots: ServerBotMembershipView[];
  counts: { ready: number; connecting: number; failed: number; other: number };
}

export interface ServersView {
  schemaVersion: "1.0";
  generatedAt: string;
  servers: ServerSummaryView[];
  controlApiReachable: boolean;
  managerReachable: boolean;
  notes: string[];
}

export async function GET() {
  const requestId = randomUUID();
  const notes: string[] = [];

  const [managerResult, controlResult] = await Promise.all([
    fetchStudioManagerStatus(loadStudioManagerConfig())
      .then((status) => ({ ok: true as const, status }))
      .catch((cause) => ({ ok: false as const, cause })),
    loadDashboardControlConfigSafe().then((config) =>
      config
        ? fetchDashboardBots(config)
            .then((result) => ({ ok: true as const, bots: result.bots }))
            .catch(() => ({ ok: false as const, bots: [] as PublicBotDetailV1[] }))
        : { ok: false as const, bots: [] as PublicBotDetailV1[] },
    ),
  ]);

  if (!managerResult.ok) {
    const cause = managerResult.cause;
    notes.push(
      cause instanceof StudioManagerClientError && cause.code === "MANAGER_NOT_CONFIGURED"
        ? "Studio Manager 未配置（无法创建/管理 Bot 进程）。"
        : `Studio Manager 不可达：${cause instanceof Error ? cause.message : "unknown"}`,
    );
  }
  if (!controlResult.ok) {
    notes.push("Control API 不可达：连接状态来自 Studio Manager 进程态，可能与协议连接态不一致。");
  }

  const managerBots: StudioManagerStatusV1["bots"] = managerResult.ok ? managerResult.status.bots : [];
  const connectionByBot = new Map(controlResult.bots.map((bot) => [bot.botId, bot]));

  const groups = new Map<string, ServerSummaryView>();
  for (const managed of managerBots) {
    const endpoint = `${managed.serverHost}:${managed.serverPort}`;
    let group = groups.get(endpoint);
    if (!group) {
      group = {
        endpoint,
        host: managed.serverHost,
        port: managed.serverPort,
        minecraftVersion: managed.minecraftVersion,
        bots: [],
        counts: { ready: 0, connecting: 0, failed: 0, other: 0 },
      };
      groups.set(endpoint, group);
    }
    const detail = connectionByBot.get(managed.botId);
    const connectionState = detail?.connectionState ?? null;
    const healthCurrent = detail?.health?.current ?? null;
    const latencyMs = detail?.latencyMs ?? null;
    const position = detail?.position
      ? `${Math.floor(detail.position.x)}, ${Math.floor(detail.position.y)}, ${Math.floor(detail.position.z)}`
      : null;
    group.bots.push({
      botId: managed.botId,
      username: managed.username,
      processState: managed.processState,
      connectionState,
      healthCurrent,
      latencyMs,
      position,
      lastError: managed.lastError,
    });
    if (connectionState === "online") group.counts.ready += 1;
    else if (connectionState === "connecting") group.counts.connecting += 1;
    else if (connectionState === "error" || managed.processState === "error") group.counts.failed += 1;
    else group.counts.other += 1;
  }

  const view: ServersView = {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    servers: [...groups.values()].sort((a, b) => a.endpoint.localeCompare(b.endpoint)),
    controlApiReachable: controlResult.ok,
    managerReachable: managerResult.ok,
    notes,
  };
  return NextResponse.json(view, {
    headers: { "Cache-Control": "no-store", "X-Request-Id": requestId },
  });
}

async function loadDashboardControlConfigSafe() {
  try {
    return loadDashboardControlConfig();
  } catch (cause) {
    if (cause instanceof DashboardControlError) return null;
    throw cause;
  }
}
