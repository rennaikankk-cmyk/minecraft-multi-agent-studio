import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import type { AppLogger } from "@minecraft-studio/observability";
import {
  COORDINATOR_GOAL_EXECUTION_PATH,
  coordinatorGoalExecutionRequestV1Schema,
  coordinatorGoalExecutionResponseV1Schema,
  type ControlLinkGoalErrorCode,
} from "@minecraft-studio/protocol";
import type { PostgresTaskRepository } from "@minecraft-studio/task-system";

import { safePersistedGoalInput } from "./goal-lifecycle-store.js";
import {
  mapGoalExecutionError,
  projectGoalDispatchResult,
} from "./goal-execution-result.js";
import type { CoordinatorLocalPlanner } from "./local-planner.js";

const MAX_REQUEST_BYTES = 8 * 1_024;

export type GoalExecutionServerOptions = Readonly<{
  host: "127.0.0.1" | "::1";
  port: number;
  secret: string;
  repository: Pick<
    PostgresTaskRepository,
    "getTask" | "isTaskAssignmentLeaseActive"
  >;
  planner: Pick<CoordinatorLocalPlanner, "planAndDispatch">;
  logger: AppLogger;
}>;

export type GoalExecutionServerAddress = Readonly<{
  host: "127.0.0.1" | "::1";
  port: number;
}>;

export class CoordinatorGoalExecutionServer {
  private readonly server: HttpServer;
  private readonly expectedSecretHash: Buffer;
  private readonly activeRequests = new Set<AbortController>();
  private started = false;
  private stopped = false;

  constructor(private readonly options: GoalExecutionServerOptions) {
    if (options.host !== "127.0.0.1" && options.host !== "::1") {
      throw new TypeError("Goal execution bridge must bind to loopback.");
    }
    if (
      !Number.isSafeInteger(options.port) ||
      options.port < 0 ||
      options.port > 65_535
    ) {
      throw new TypeError("Goal execution bridge port is invalid.");
    }
    if (options.secret.length < 32 || options.secret.length > 512) {
      throw new TypeError("Goal execution bridge secret is invalid.");
    }
    this.expectedSecretHash = digest(options.secret);
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server.on("clientError", (_error, socket) => {
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    });
  }

  async start(): Promise<GoalExecutionServerAddress> {
    if (this.started || this.stopped) {
      throw new Error("Goal execution bridge cannot be started twice.");
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server.once("error", onError);
      this.server.listen(
        { host: this.options.host, port: this.options.port, exclusive: true },
        () => {
          this.server.off("error", onError);
          resolve();
        },
      );
    });
    this.started = true;
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Goal execution bridge did not receive a TCP address.");
    }
    return {
      host: this.options.host,
      port: (address as AddressInfo).port,
    };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const controller of this.activeRequests) {
      controller.abort(new Error("coordinator_shutdown"));
    }
    if (!this.started) return;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (
      request.method !== "POST" ||
      request.url !== COORDINATOR_GOAL_EXECUTION_PATH
    ) {
      writeJson(response, 404, { error: "not_found" });
      return;
    }
    if (!isLoopbackPeer(request.socket.remoteAddress)) {
      writeJson(response, 403, { error: "forbidden" });
      return;
    }
    if (!this.authorized(request.headers.authorization)) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }

    const controller = new AbortController();
    this.activeRequests.add(controller);
    request.once("aborted", () =>
      controller.abort(new Error("worker_request_aborted")),
    );
    response.once("close", () => {
      if (!response.writableEnded) {
        controller.abort(new Error("worker_response_closed"));
      }
    });
    let taskId: string | null = null;
    try {
      const message = coordinatorGoalExecutionRequestV1Schema.parse(
        await readJson(request),
      );
      taskId = message.taskId;
      const task = await this.options.repository.getTask(message.taskId);
      const input = task ? safePersistedGoalInput(task) : null;
      if (
        !task ||
        !input ||
        task.taskType !== "coordinator.goal" ||
        task.handlerVersion !== "1.0.0" ||
        task.executionIdempotent ||
        task.status !== "running" ||
        task.dispatchBotId !== input.botId ||
        task.assignedBotId !== input.botId ||
        task.leaseOwner !== message.assignmentLeaseOwner
      ) {
        writeExecutionError(response, message.taskId, "AUTHORIZATION_REJECTED");
        return;
      }
      const leaseActive =
        await this.options.repository.isTaskAssignmentLeaseActive({
          taskId: task.taskId,
          botId: input.botId,
          leaseOwner: message.assignmentLeaseOwner,
        });
      if (!leaseActive) {
        writeExecutionError(response, message.taskId, "AUTHORIZATION_REJECTED");
        return;
      }

      const planResult = await this.options.planner.planAndDispatch({
        requestId: input.operationId,
        traceId: input.operationId,
        taskId: input.taskId,
        botId: input.botId,
        operatorGoal: input.operatorGoal,
        timeoutMs: input.timeoutMs,
        assignmentLeaseOwner: message.assignmentLeaseOwner,
        signal: controller.signal,
      });
      const result = projectGoalDispatchResult(input, planResult);
      writeJson(
        response,
        200,
        coordinatorGoalExecutionResponseV1Schema.parse({
          schemaVersion: "1.0",
          taskId: message.taskId,
          ok: true,
          result,
        }),
      );
      this.options.logger.info("coordinator_queued_goal_executed", {
        traceId: input.operationId,
        taskId: input.taskId,
        botId: input.botId,
        workerInstanceId: message.workerInstanceId,
        action: result.action,
      });
    } catch (cause) {
      if (!response.writableEnded && !response.destroyed) {
        if (taskId === null) {
          writeJson(response, 400, { error: "request_invalid" });
        } else {
          writeExecutionError(
            response,
            taskId,
            mapGoalExecutionError(
              cause,
              false,
              controller.signal.aborted,
            ),
          );
        }
      }
    } finally {
      this.activeRequests.delete(controller);
    }
  }

  private authorized(header: string | undefined): boolean {
    if (!header?.startsWith("Bearer ")) return false;
    const candidate = header.slice("Bearer ".length);
    if (candidate.length < 32 || candidate.length > 512) return false;
    return timingSafeEqual(digest(candidate), this.expectedSecretHash);
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_REQUEST_BYTES) throw new Error("request_too_large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function writeExecutionError(
  response: ServerResponse,
  taskId: string,
  errorCode: ControlLinkGoalErrorCode,
): void {
  writeJson(
    response,
    200,
    coordinatorGoalExecutionResponseV1Schema.parse({
      schemaVersion: "1.0",
      taskId,
      ok: false,
      errorCode,
    }),
  );
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  value: unknown,
): void {
  if (response.writableEnded || response.destroyed) return;
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function isLoopbackPeer(address: string | undefined): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}
