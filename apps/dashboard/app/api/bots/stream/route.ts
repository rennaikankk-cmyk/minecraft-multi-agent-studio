import { randomUUID } from "node:crypto";

import {
  DashboardControlError,
  loadDashboardControlConfig,
} from "@/lib/control-api-client";
import {
  openBotStreamProxy,
  type BotStreamProxyErrorCode,
  type BotStreamProxyHandle,
} from "@/lib/bot-stream-proxy";
import { dashboardLogger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_INTERVAL_MS = 15_000;

const encoder = new TextEncoder();

function sseFrame(eventName: string, payload: unknown): Uint8Array {
  return encoder.encode(
    `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`,
  );
}

export async function GET(request: Request): Promise<Response> {
  const requestId = randomUUID();

  let config;
  try {
    config = loadDashboardControlConfig();
  } catch (cause) {
    const code =
      cause instanceof DashboardControlError
        ? cause.code
        : "DASHBOARD_CONTROL_NOT_CONFIGURED";
    // A misconfigured proxy is reported as a one-shot SSE error stream so the
    // client sees an explicit failure instead of a silent hang.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(sseFrame("stream-error", { requestId, code }));
        controller.close();
      },
    });
    return sseResponse(body);
  }

  let proxy: BotStreamProxyHandle | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const shutdown = () => {
        if (closed) return;
        closed = true;
        if (heartbeat !== null) clearInterval(heartbeat);
        heartbeat = null;
        proxy?.close();
        try {
          controller.close();
        } catch {
          // The stream may already be closed by the client disconnecting.
        }
      };

      const send = (eventName: string, payload: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(sseFrame(eventName, payload));
        } catch {
          shutdown();
        }
      };

      proxy = openBotStreamProxy(config, {
        onEvent(event) {
          if (event.kind === "snapshot") {
            send("snapshot", { requestId, message: event.message });
            return;
          }
          if (event.kind === "event") {
            send("event", { requestId, message: event.message });
            return;
          }
          logStreamError(requestId, event.code);
          send("stream-error", { requestId, code: event.code });
        },
        onClose() {
          shutdown();
        },
      });

      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          shutdown();
        }
      }, HEARTBEAT_INTERVAL_MS);

      request.signal.addEventListener("abort", shutdown, { once: true });
    },
    cancel() {
      closed = true;
      if (heartbeat !== null) clearInterval(heartbeat);
      heartbeat = null;
      proxy?.close();
    },
  });

  return sseResponse(body);
}

function sseResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

function logStreamError(
  requestId: string,
  code: BotStreamProxyErrorCode,
): void {
  dashboardLogger.error("dashboard_bot_stream_failed", {
    traceId: requestId,
    taskId: null,
    botId: null,
    skillId: null,
    modelName: null,
    code,
  });
}
