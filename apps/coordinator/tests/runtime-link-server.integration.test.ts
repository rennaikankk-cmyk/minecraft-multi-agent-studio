import { createHash, createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AppLogger } from "@minecraft-studio/observability";
import {
  RUNTIME_LINK_SUBPROTOCOL,
  parseRuntimeLinkServerMessage,
  runtimeLinkAuthenticateV1Schema,
  runtimeLinkClientProofInput,
  runtimeLinkServerProofInput,
  type BotHeartbeatV1,
  type BotSkillCatalogV1,
  type BotStatusV1,
  type ControlAuthorizationContext,
  type RuntimeLinkChallengeV1,
  type RuntimeLinkProofContext,
  type SkillExecutionResultV1,
  type SkillInvocationV1,
  type StopBotCommandV1,
} from "@minecraft-studio/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import {
  BotRegistry,
  InMemoryStopAuditSink,
  RuntimeLinkServer,
  StopController,
} from "../src/index.js";

const NOW = new Date("2026-08-07T10:00:00.000Z");
const BOT_ID = "worker-01";
const RUNTIME_ID = "runtime-link-test";
const KEY_ID = "runtime-key-01";
const SECRET = "runtime-link-test-secret-000000000000000000000001";
const SECRET_SHA256 = createHash("sha256").update(SECRET, "utf8").digest("hex");
const CHALLENGE_NONCE = Buffer.alloc(32, 1).toString("base64url");
const CLIENT_NONCE = Buffer.alloc(32, 2).toString("base64url");

const logger: AppLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const servers: RuntimeLinkServer[] = [];
const sockets: WebSocket[] = [];
const peerDirectories: string[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  for (const dir of peerDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("Coordinator Runtime Link server", () => {
  it("authenticates both directions, ingests telemetry, and confirms a stop", async () => {
    const { registry, server, url } = await startServer();
    const socket = await authenticate(url);

    const heartbeat = heartbeatMessage(1);
    const acknowledgementPromise = nextServerMessage(socket);
    socket.send(JSON.stringify(heartbeat));
    await expect(acknowledgementPromise).resolves.toMatchObject({
      type: "runtime.link.telemetry-ack.v1",
      payload: {
        telemetryMessageId: heartbeat.messageId,
        accepted: true,
        reason: "accepted",
      },
    });
    expect(registry.get(BOT_ID, NOW)).toMatchObject({
      botId: BOT_ID,
      runtimeInstanceId: RUNTIME_ID,
      connectionState: "online",
    });

    const commandPromise = nextServerMessage(socket);
    const controller = new StopController({
      instanceId: "coordinator-test",
      registry,
      transport: server,
      auditSink: new InMemoryStopAuditSink(),
      logger,
      now: () => NOW,
      randomId: uuidSequence(500),
    });
    const stopPromise = controller.requestStop({
      commandId: testUuid(600),
      traceId: testUuid(601),
      botId: BOT_ID,
      mode: "graceful",
      reason: "Operator confirmed Runtime Link test stop.",
      gracePeriodMs: 1_000,
      timeoutMs: 2_000,
      authorization: {
        decisionId: testUuid(602),
        actorId: "operator-01",
        permissions: new Set(["bot.stop"]),
        issuedAt: new Date(NOW.getTime() - 1_000),
        expiresAt: new Date(NOW.getTime() + 10_000),
      },
    });
    const command = (await commandPromise) as StopBotCommandV1;
    expect(command).toMatchObject({
      type: "bot.stop.command.v1",
      botId: BOT_ID,
      traceId: testUuid(601),
      payload: {
        commandId: testUuid(600),
        expectedRuntimeInstanceId: RUNTIME_ID,
      },
    });

    socket.send(
      JSON.stringify({
        schemaVersion: "1.0",
        messageId: testUuid(700),
        traceId: command.traceId,
        timestamp: NOW.toISOString(),
        source: { service: "bot-runtime", instanceId: RUNTIME_ID },
        botId: BOT_ID,
        type: "bot.stop.result.v1",
        payload: {
          commandId: command.payload.commandId,
          runtimeInstanceId: RUNTIME_ID,
          outcome: "completed",
          completedAt: NOW.toISOString(),
        },
      }),
    );
    await expect(stopPromise).resolves.toMatchObject({
      traceId: command.traceId,
      payload: { outcome: "completed" },
    });
    expect(registry.get(BOT_ID, NOW)?.connectionState).toBe("offline");
  });

  it("acknowledges duplicate telemetry without mutating newer state", async () => {
    const { registry, url } = await startServer();
    const socket = await authenticate(url);
    const heartbeat = heartbeatMessage(1);

    const firstAck = nextServerMessage(socket);
    socket.send(JSON.stringify(heartbeat));
    await firstAck;
    const duplicateAck = nextServerMessage(socket);
    socket.send(JSON.stringify(heartbeat));
    await expect(duplicateAck).resolves.toMatchObject({
      type: "runtime.link.telemetry-ack.v1",
      payload: { accepted: false, reason: "duplicate_message" },
    });
    expect(registry.get(BOT_ID, NOW)?.lastSequence).toBe(1);
  });

  it("delivers a bounded skill invocation and validates its correlated result", async () => {
    const { server, url } = await startServer();
    const socket = await authenticateAndActivate(url);
    const invocation = skillInvocation(testUuid(750));
    const received = nextServerMessage(socket);
    const pending = server.sendSkillInvocation(
      invocation,
      RUNTIME_ID,
      new AbortController().signal,
    );

    await expect(received).resolves.toEqual(invocation);
    socket.send(JSON.stringify(skillResult(invocation)));
    await expect(pending).resolves.toMatchObject({
      traceId: invocation.traceId,
      taskId: invocation.taskId,
      payload: {
        invocationId: invocation.payload.invocationId,
        outcome: "completed",
      },
    });
  });

  it("requests and waits for a strictly newer status from the same Runtime", async () => {
    const { registry, server, url } = await startServer();
    const unsubscribe = trackRegistryUnsubscribe(registry);
    const socket = await authenticateAndActivate(url);
    const initialStatus = statusMessage(2);
    const initialAck = nextServerMessage(socket);
    socket.send(JSON.stringify(initialStatus));
    await initialAck;

    const received = nextServerMessage(socket);
    const pending = server.requestFreshStatus(
      BOT_ID,
      RUNTIME_ID,
      initialStatus.payload.sequence,
      "trace-fresh-status",
      "task-fresh-status",
      new AbortController().signal,
    );
    await expect(received).resolves.toMatchObject({
      type: "runtime.link.state-request.v1",
      traceId: "trace-fresh-status",
      source: { service: "coordinator", instanceId: "coordinator-test" },
      botId: BOT_ID,
      taskId: "task-fresh-status",
      payload: {
        expectedRuntimeInstanceId: RUNTIME_ID,
        afterStatusSequence: initialStatus.payload.sequence,
        expiresAt: new Date(NOW.getTime() + 30_000).toISOString(),
      },
    });

    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    const heartbeatAck = nextServerMessage(socket);
    socket.send(JSON.stringify(heartbeatMessage(3)));
    await heartbeatAck;
    await Promise.resolve();
    expect(settled).toBe(false);

    const freshStatus = statusMessage(4);
    const freshAck = nextServerMessage(socket);
    socket.send(JSON.stringify(freshStatus));
    await freshAck;
    await expect(pending).resolves.toBeUndefined();
    expect(registry.get(BOT_ID, NOW)?.currentStatus?.sequence).toBe(4);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("rejects or cleans a fresh-status wait on identity mismatch, abort, and disconnect", async () => {
    const { registry, server, url } = await startServer();
    const unsubscribe = trackRegistryUnsubscribe(registry);
    const socket = await authenticateAndActivate(url);
    const statusAck = nextServerMessage(socket);
    socket.send(JSON.stringify(statusMessage(2)));
    await statusAck;

    await expect(
      server.requestFreshStatus(
        BOT_ID,
        "different-runtime",
        2,
        "trace-runtime-mismatch",
        "task-runtime-mismatch",
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_LINK_UNAVAILABLE" });

    const abortController = new AbortController();
    const abortReceived = nextServerMessage(socket);
    const aborted = server.requestFreshStatus(
      BOT_ID,
      RUNTIME_ID,
      2,
      "trace-status-abort",
      "task-status-abort",
      abortController.signal,
    );
    await abortReceived;
    abortController.abort();
    await expect(aborted).rejects.toMatchObject({ code: "RUNTIME_LINK_ABORTED" });
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    const disconnectReceived = nextServerMessage(socket);
    const disconnected = server.requestFreshStatus(
      BOT_ID,
      RUNTIME_ID,
      2,
      "trace-status-disconnect",
      "task-status-disconnect",
      new AbortController().signal,
    );
    await disconnectReceived;
    socket.terminate();
    await expect(disconnected).rejects.toMatchObject({
      code: "RUNTIME_LINK_UNAVAILABLE",
    });
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });

  it("cleans a fresh-status wait when the Runtime Link server stops", async () => {
    const { registry, server, url } = await startServer();
    const unsubscribe = trackRegistryUnsubscribe(registry);
    const socket = await authenticateAndActivate(url);
    const statusAck = nextServerMessage(socket);
    socket.send(JSON.stringify(statusMessage(2)));
    await statusAck;
    const received = nextServerMessage(socket);
    const pending = server.requestFreshStatus(
      BOT_ID,
      RUNTIME_ID,
      2,
      "trace-status-stop",
      "task-status-stop",
      new AbortController().signal,
    );
    await received;

    const stopped = server.stop();
    await expect(pending).rejects.toMatchObject({ code: "RUNTIME_LINK_STOPPED" });
    await stopped;
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("rejects a fresh-status request with an outdated baseline", async () => {
    const { server, url } = await startServer();
    const socket = await authenticateAndActivate(url);
    const statusAck = nextServerMessage(socket);
    socket.send(JSON.stringify(statusMessage(2)));
    await statusAck;

    await expect(
      server.requestFreshStatus(
        BOT_ID,
        RUNTIME_ID,
        1,
        "trace-status-stale-baseline",
        "task-status-stale-baseline",
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_LINK_STATUS_BASELINE_STALE" });
  });

  it("propagates caller cancellation to an active Runtime skill", async () => {
    const { server, url } = await startServer();
    const socket = await authenticateAndActivate(url);
    const invocation = skillInvocation(testUuid(760));
    const abortController = new AbortController();
    const received = nextServerMessage(socket);
    const pending = server.sendSkillInvocation(
      invocation,
      RUNTIME_ID,
      abortController.signal,
    );
    await received;
    const cancellationReceived = nextServerMessage(socket);
    const pendingRejected = expect(pending).rejects.toMatchObject({
      code: "RUNTIME_LINK_ABORTED",
    });
    abortController.abort();

    await expect(cancellationReceived).resolves.toMatchObject({
      type: "skill.cancel.v1",
      botId: BOT_ID,
      taskId: invocation.taskId,
      payload: {
        invocationId: invocation.payload.invocationId,
        reason: "caller_cancelled",
      },
    });
    await pendingRejected;
  });

  it("rejects an invalid client proof before registry mutation", async () => {
    const { registry, url } = await startServer();
    const socket = new WebSocket(url, RUNTIME_LINK_SUBPROTOCOL);
    sockets.push(socket);
    const challenge = (await nextServerMessage(socket)) as RuntimeLinkChallengeV1;
    const closed = once(socket, "close");
    socket.send(
      JSON.stringify(
        runtimeLinkAuthenticateV1Schema.parse({
          schemaVersion: "1.0",
          messageId: testUuid(800),
          timestamp: NOW.toISOString(),
          type: "runtime.link.authenticate.v1",
          payload: {
            challengeMessageId: challenge.messageId,
            coordinatorInstanceId: challenge.payload.coordinatorInstanceId,
            challengeNonce: challenge.payload.challengeNonce,
            clientNonce: CLIENT_NONCE,
            botId: BOT_ID,
            runtimeInstanceId: RUNTIME_ID,
            keyId: KEY_ID,
            clientProof: Buffer.alloc(32, 9).toString("base64url"),
          },
        }),
      ),
    );
    const [code] = await closed;
    expect(code).toBe(1008);
    expect(registry.get(BOT_ID, NOW)).toBeNull();
  });

  it("rejects binary application frames", async () => {
    const { url } = await startServer();
    const socket = await authenticate(url);
    const closed = once(socket, "close");
    socket.send(Buffer.from("{}"));
    const [code] = await closed;
    expect(code).toBe(1003);
  });

  it("rejects browser-origin WebSocket upgrades", async () => {
    const { url } = await startServer();
    expect(await rejectedWebSocketStatus(url, "https://untrusted.example")).toBe(
      403,
    );
  });

  it("cleans a pending stop when its caller aborts", async () => {
    const { server, url } = await startServer();
    const socket = await authenticateAndActivate(url);
    const abortController = new AbortController();
    const command = stopCommand(testUuid(900), testUuid(901));
    const commandReceived = nextServerMessage(socket);
    const pending = server.sendStopCommand(
      command,
      authorizationContext(command),
      abortController.signal,
    );
    await commandReceived;
    abortController.abort();
    await expect(pending).rejects.toMatchObject({ code: "RUNTIME_LINK_ABORTED" });
  });

  it("fails a pending stop when the authenticated Runtime disconnects", async () => {
    const { server, url } = await startServer();
    const socket = await authenticateAndActivate(url);
    const command = stopCommand(testUuid(910), testUuid(911));
    const commandReceived = nextServerMessage(socket);
    const pending = server.sendStopCommand(
      command,
      authorizationContext(command),
      new AbortController().signal,
    );
    await commandReceived;
    socket.terminate();
    await expect(pending).rejects.toMatchObject({
      code: "RUNTIME_LINK_UNAVAILABLE",
    });
  });

  it("bounds unauthenticated sessions and pending stop commands", async () => {
    const { server, url } = await startServer({
      maxSessions: 1,
      maxPendingStops: 1,
    });
    const socket = await authenticateAndActivate(url);
    expect(await rejectedWebSocketStatus(url)).toBe(503);

    const firstAbort = new AbortController();
    const firstCommand = stopCommand(testUuid(930), testUuid(931));
    const firstReceived = nextServerMessage(socket);
    const firstPending = server.sendStopCommand(
      firstCommand,
      authorizationContext(firstCommand),
      firstAbort.signal,
    );
    await firstReceived;

    const secondCommand = stopCommand(testUuid(932), testUuid(933));
    await expect(
      server.sendStopCommand(
        secondCommand,
        authorizationContext(secondCommand),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_LINK_BACKPRESSURE" });
    firstAbort.abort();
    await expect(firstPending).rejects.toMatchObject({
      code: "RUNTIME_LINK_ABORTED",
    });
  });

  it("logs which advertised skills a runtime actually offered", async () => {
    // 目录此前只落进 registry。planner 的生成分支是由这份目录构建的，
    // 所以"某个技能有没有被提供出去"必须有一个可读的面，否则注册漂移
    // 只能靠提交一个目标去猜。
    const { url } = await startServer();
    const socket = await authenticate(url);
    const catalog = skillCatalogMessage(1);
    const acknowledgement = nextServerMessage(socket);
    socket.send(JSON.stringify(catalog));
    await acknowledgement;

    expect(logger.info).toHaveBeenCalledWith(
      "coordinator_runtime_link_skill_catalog",
      {
        traceId: catalog.traceId,
        botId: BOT_ID,
        runtimeInstanceId: RUNTIME_ID,
        accepted: true,
        reason: "accepted",
        skillCount: 2,
        availableCount: 1,
        availableSkills: ["world.scan@1.0.0"],
        unavailableSkills: ["mine.branch@1.0.0"],
      },
    );
    // 目录日志不得复制世界内容或服务器身份：那是遥测泄露面，不是可观测性。
    const logged = JSON.stringify((logger.info as ReturnType<typeof vi.fn>).mock.calls);
    expect(logged).not.toContain("isolated-test");
  });
});

describe("managed Runtime Link username binding over real WebSocket", () => {
  it("preserves static external peers during managed file failure and rejects file control over them", async () => {
    const external = { keyId: "external-key", botId: "ExternalBot", secretSha256: "b".repeat(64) };
    const peersPath = managedPeerFile("Resident_1");
    const { url, registry } = await startServer({ peersPath, managedKeyIds: [KEY_ID],
      peers: [{ keyId: KEY_ID, botId: BOT_ID, secretSha256: SECRET_SHA256 }, external] });
    const externalSocket = await authenticate(url, external.botId, external.keyId, external.secretSha256);
    const managedSocket = await authenticate(url, "Resident_1");
    for (const [index, body] of ["{", JSON.stringify({ schemaVersion: "1.0", peers: [external] }),
      JSON.stringify({ schemaVersion: "1.0", peers: [{ keyId: KEY_ID, botId: "externalbot", secretSha256: SECRET_SHA256 }] })].entries()) {
      writeFileSync(peersPath, body);
      const ack = nextServerMessage(externalSocket);
      externalSocket.send(JSON.stringify({ ...heartbeatMessage(index + 1), botId: external.botId }));
      await expect(ack).resolves.toMatchObject({ payload: { accepted: true } });
      await expect(rejectedAuthentication(url, "Resident_1")).resolves.toBe("authentication_rejected");
      await expect(rejectedAuthentication(url, "externalbot")).resolves.toBe("authentication_rejected");
    }
    rmSync(peersPath);
    // Static authentication and routing do not need a healthy managed file.
    await authenticate(url, external.botId, external.keyId, external.secretSha256);
    expect(registry.get(external.botId, NOW)?.lastSequence).toBe(3);
    const closed = once(managedSocket, "close");
    managedSocket.send(JSON.stringify({ ...heartbeatMessage(4), botId: "Resident_1" }));
    expect(String((await closed)[1])).toBe("runtime_binding_changed");
  });

  it("cannot reactivate a fenced session when its former username is assigned again", async () => {
    const peersPath = managedPeerFile("Resident_1");
    const { url, registry } = await startServer({ peersPath });
    const old = await authenticate(url, "Resident_1");
    writeManagedPeers(peersPath, "Resident_2");
    const closed = once(old, "close");
    await authenticate(url, "Resident_2");
    await closed;
    writeManagedPeers(peersPath, "Resident_1");
    expect(old.readyState).toBe(WebSocket.CLOSED);
    const current = await authenticate(url, "Resident_1");
    const ack = nextServerMessage(current);
    current.send(JSON.stringify({ ...heartbeatMessage(1), botId: "Resident_1" }));
    await expect(ack).resolves.toMatchObject({ payload: { accepted: true } });
    expect(registry.get("Resident_1", NOW)?.lastSequence).toBe(1);
  });

  it("accepts a renamed username with its preauthorized slot key and ingests telemetry", async () => {
    const peersPath = managedPeerFile("_Resident_1");
    const { registry, url } = await startServer({ peersPath });
    const socket = await authenticate(url, "_Resident_1");
    const ack = nextServerMessage(socket);
    socket.send(JSON.stringify({ ...heartbeatMessage(1), botId: "_Resident_1" }));
    await expect(ack).resolves.toMatchObject({ payload: { accepted: true } });
    expect(registry.get("_Resident_1", NOW)?.lastSequence).toBe(1);
    expect(registry.get(BOT_ID, NOW)).toBeNull();
    await expect(rejectedAuthentication(url, BOT_ID)).resolves.toBe("authentication_rejected");
  });

  it("rejects stale incoming telemetry as soon as the file reassigns the slot", async () => {
    const peersPath = managedPeerFile("Resident_1");
    const { registry, url } = await startServer({ peersPath });
    const socket = await authenticate(url, "Resident_1");
    const ack = nextServerMessage(socket);
    socket.send(JSON.stringify({ ...heartbeatMessage(1), botId: "Resident_1" }));
    await ack;
    writeManagedPeers(peersPath, "Resident_2");
    const closed = once(socket, "close");
    socket.send(JSON.stringify({ ...heartbeatMessage(2), botId: "Resident_1" }));
    expect(String((await closed)[1])).toBe("runtime_binding_changed");
    expect(registry.get("Resident_1", NOW)?.lastSequence).toBe(1);
  });

  it("rejects dispatch and closes a stale session without waiting for another heartbeat", async () => {
    const peersPath = managedPeerFile("Resident_1");
    const { server, url } = await startServer({ peersPath });
    const socket = await authenticate(url, "Resident_1");
    writeManagedPeers(peersPath, "Resident_2");
    const closed = once(socket, "close");
    await expect(server.sendSkillInvocation({ ...skillInvocation(testUuid(950)), botId: "Resident_1" },
      RUNTIME_ID, new AbortController().signal)).rejects.toMatchObject({ code: "RUNTIME_LINK_UNAVAILABLE" });
    expect(String((await closed)[1])).toBe("runtime_binding_changed");
  });

  it("fences the old same-key socket and pending request when the new username authenticates", async () => {
    const peersPath = managedPeerFile("Resident_1");
    const { server, url } = await startServer({ peersPath });
    const old = await authenticate(url, "Resident_1");
    const invocation = { ...skillInvocation(testUuid(951)), botId: "Resident_1" };
    const received = nextServerMessage(old);
    const pending = expect(server.sendSkillInvocation(invocation, RUNTIME_ID, new AbortController().signal))
      .rejects.toMatchObject({ code: "RUNTIME_LINK_UNAVAILABLE" });
    await received;
    writeManagedPeers(peersPath, "Resident_2");
    const closed = once(old, "close");
    const current = await authenticate(url, "Resident_2");
    expect(String((await closed)[1])).toBe("runtime_replaced");
    await pending;
    const next = { ...skillInvocation(testUuid(952)), botId: "Resident_2" };
    const delivered = nextServerMessage(current);
    const completion = server.sendSkillInvocation(next, RUNTIME_ID, new AbortController().signal);
    await expect(delivered).resolves.toEqual(next);
    current.send(JSON.stringify(skillResult(next)));
    await expect(completion).resolves.toMatchObject({ botId: "Resident_2" });
  });

  it.each(["missing", "corrupt", "tampered", "removed"] as const)("fails closed on %s bindings, including static Bot IDs", async (mode) => {
    const peersPath = managedPeerFile("Resident_1");
    const { server, url } = await startServer({ peersPath });
    const socket = await authenticate(url, "Resident_1");
    if (mode === "missing") rmSync(peersPath);
    else if (mode === "corrupt") writeFileSync(peersPath, "{");
    else if (mode === "removed") writeFileSync(peersPath, JSON.stringify({ schemaVersion: "1.0", peers: [] }));
    else writeManagedPeers(peersPath, "Resident_1", "b".repeat(64));
    await expect(rejectedAuthentication(url, "Resident_1")).resolves.toBe("authentication_rejected");
    await expect(rejectedAuthentication(url, BOT_ID)).resolves.toBe("authentication_rejected");
    const closed = once(socket, "close");
    await expect(server.requestFreshStatus("Resident_1", RUNTIME_ID, 1, "trace-managed", "task-managed",
      new AbortController().signal)).rejects.toMatchObject({ code: "RUNTIME_LINK_UNAVAILABLE" });
    expect(String((await closed)[1])).toBe("runtime_binding_changed");
  });
});

function managedPeerFile(botId: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "runtime-ws-peers-"));
  peerDirectories.push(dir);
  const file = path.join(dir, "peers.json");
  writeManagedPeers(file, botId);
  return file;
}

function writeManagedPeers(file: string, botId: string, secretSha256 = SECRET_SHA256): void {
  writeFileSync(file, JSON.stringify({ schemaVersion: "1.0", peers: [{ keyId: KEY_ID, botId, secretSha256 }] }));
}

async function rejectedAuthentication(url: string, botId: string): Promise<string> {
  const socket = new WebSocket(url, RUNTIME_LINK_SUBPROTOCOL);
  sockets.push(socket);
  const challenge = await nextServerMessage(socket) as RuntimeLinkChallengeV1;
  const context: RuntimeLinkProofContext = { challengeMessageId: challenge.messageId,
    coordinatorInstanceId: challenge.payload.coordinatorInstanceId, challengeNonce: challenge.payload.challengeNonce,
    clientNonce: CLIENT_NONCE, botId, runtimeInstanceId: RUNTIME_ID, keyId: KEY_ID };
  const closed = once(socket, "close");
  socket.send(JSON.stringify({ schemaVersion: "1.0", messageId: testUuid(998), timestamp: NOW.toISOString(),
    type: "runtime.link.authenticate.v1", payload: { ...context, clientProof: hmac(runtimeLinkClientProofInput(context)) } }));
  return String((await closed)[1]);
}

async function startServer(
  overrides: Partial<{
    maxSessions: number;
    maxPendingStops: number;
    maxPendingSkills: number;
    peersPath: string;
    managedKeyIds: string[];
    peers: Array<{ keyId: string; botId: string; secretSha256: string }>;
  }> = {},
): Promise<{
  registry: BotRegistry;
  server: RuntimeLinkServer;
  url: string;
}> {
  const registry = new BotRegistry({ staleAfterMs: 15_000, now: () => NOW });
  const server = new RuntimeLinkServer({
    host: "127.0.0.1",
    port: 0,
    instanceId: "coordinator-test",
    peers: [{ keyId: KEY_ID, botId: BOT_ID, secretSha256: SECRET_SHA256 }],
    registry,
    logger,
    now: () => NOW,
    randomId: uuidSequence(1),
    randomNonce: () => CHALLENGE_NONCE,
    ...overrides,
  });
  servers.push(server);
  const address = await server.start();
  return {
    registry,
    server,
    url: `ws://127.0.0.1:${address.port}/v1/runtime-link`,
  };
}

async function authenticate(url: string, botId = BOT_ID, keyId = KEY_ID, secretSha256 = SECRET_SHA256): Promise<WebSocket> {
  const socket = new WebSocket(url, RUNTIME_LINK_SUBPROTOCOL);
  sockets.push(socket);
  const challenge = (await nextServerMessage(socket)) as RuntimeLinkChallengeV1;
  const context: RuntimeLinkProofContext = {
    challengeMessageId: challenge.messageId,
    coordinatorInstanceId: challenge.payload.coordinatorInstanceId,
    challengeNonce: challenge.payload.challengeNonce,
    clientNonce: CLIENT_NONCE,
    botId,
    runtimeInstanceId: RUNTIME_ID,
    keyId,
  };
  const authenticateMessageId = testUuid(300);
  const acceptedPromise = nextServerMessage(socket);
  socket.send(
    JSON.stringify(
      runtimeLinkAuthenticateV1Schema.parse({
        schemaVersion: "1.0",
        messageId: authenticateMessageId,
        timestamp: NOW.toISOString(),
        type: "runtime.link.authenticate.v1",
        payload: {
          ...context,
          clientProof: hmac(runtimeLinkClientProofInput(context), secretSha256),
        },
      }),
    ),
  );
  const accepted = await acceptedPromise;
  expect(accepted).toMatchObject({
    type: "runtime.link.accepted.v1",
    payload: {
      authenticateMessageId,
      botId,
      runtimeInstanceId: RUNTIME_ID,
      keyId,
    },
  });
  if (accepted.type !== "runtime.link.accepted.v1") {
    throw new Error("Expected Runtime Link accepted message.");
  }
  expect(accepted.payload.serverProof).toBe(
    hmac(runtimeLinkServerProofInput({ ...context, authenticateMessageId }), secretSha256),
  );
  return socket;
}

async function authenticateAndActivate(url: string): Promise<WebSocket> {
  const socket = await authenticate(url);
  const acknowledgement = nextServerMessage(socket);
  socket.send(JSON.stringify(heartbeatMessage(1)));
  await acknowledgement;
  return socket;
}

function nextServerMessage(socket: WebSocket) {
  return new Promise<ReturnType<typeof parseRuntimeLinkServerMessage>>(
    (resolve, reject) => {
      socket.once("message", (data) => {
        try {
          resolve(parseRuntimeLinkServerMessage(JSON.parse(data.toString()) as unknown));
        } catch (cause) {
          reject(cause);
        }
      });
      socket.once("error", reject);
    },
  );
}

function rejectedWebSocketStatus(url: string, origin?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, RUNTIME_LINK_SUBPROTOCOL, {
      ...(origin ? { headers: { Origin: origin } } : {}),
    });
    socket.once("unexpected-response", (_request, response) => {
      const status = response.statusCode ?? 0;
      response.resume();
      resolve(status);
    });
    socket.once("error", () => undefined);
    socket.once("open", () => {
      socket.terminate();
      reject(new Error("Expected Runtime Link session limit rejection."));
    });
  });
}

function heartbeatMessage(sequence: number): BotHeartbeatV1 {
  return {
    schemaVersion: "1.0",
    messageId: testUuid(400 + sequence),
    traceId: "trace-runtime-link",
    timestamp: NOW.toISOString(),
    source: { service: "bot-runtime", instanceId: RUNTIME_ID },
    botId: BOT_ID,
    type: "bot.heartbeat.v1",
    payload: {
      serverProfileId: "isolated-test",
      runtimeInstanceId: RUNTIME_ID,
      sequence,
      observedAt: NOW.toISOString(),
      connectionState: "online",
      uptimeMs: sequence * 1_000,
      lastStatusSequence: null,
      currentTaskId: null,
    },
  };
}

function skillCatalogMessage(sequence: number): BotSkillCatalogV1 {
  return {
    schemaVersion: "1.0",
    messageId: testUuid(1_500 + sequence),
    traceId: "trace-runtime-catalog",
    timestamp: NOW.toISOString(),
    source: { service: "bot-runtime", instanceId: RUNTIME_ID },
    botId: BOT_ID,
    type: "bot.skill-catalog.v1",
    payload: {
      serverProfileId: "isolated-test",
      runtimeInstanceId: RUNTIME_ID,
      sequence,
      observedAt: NOW.toISOString(),
      minecraftVersion: "1.21.11",
      protocolVersion: 774,
      skills: [
        {
          skillId: "world.scan",
          skillVersion: "1.0.0",
          availability: "available",
          verification: "unverified",
          inputSchema: { type: "object", additionalProperties: false },
          timeoutMs: 10_000,
          idempotent: true,
          selectedVariantId: "portable",
          unavailableReasons: [],
        },
        {
          skillId: "mine.branch",
          skillVersion: "1.0.0",
          availability: "unavailable",
          verification: "unverified",
          inputSchema: { type: "object", additionalProperties: false },
          timeoutMs: 60_000,
          idempotent: false,
          selectedVariantId: null,
          unavailableReasons: [
            {
              variantId: "portable",
              code: "SERVER_CAPABILITY_UNKNOWN",
              subject: "mine.runtime",
            },
          ],
        },
      ],
    },
  };
}

function statusMessage(sequence: number): BotStatusV1 {
  return {
    schemaVersion: "1.0",
    messageId: testUuid(1_000 + sequence),
    traceId: "trace-runtime-status",
    timestamp: NOW.toISOString(),
    source: { service: "bot-runtime", instanceId: RUNTIME_ID },
    botId: BOT_ID,
    type: "bot.status.v1",
    payload: {
      serverProfileId: "isolated-test",
      runtimeInstanceId: RUNTIME_ID,
      sequence,
      observedAt: NOW.toISOString(),
      connectionState: "online",
      health: { current: 20, maximum: 20 },
      food: { level: 20, saturation: 5 },
      armorPoints: 0,
      position: {
        x: 0,
        y: 64,
        z: 0,
        dimension: "minecraft:overworld",
      },
      latencyMs: null,
      currentTask: null,
      safety: {
        mode: "monitoring",
        normalTasksPaused: false,
        activeRisks: [],
        lastDecisionId: null,
        lastAction: null,
      },
    },
  };
}

function stopCommand(commandId: string, traceId: string): StopBotCommandV1 {
  return {
    schemaVersion: "1.0",
    messageId: testUuid(920),
    traceId,
    timestamp: NOW.toISOString(),
    source: { service: "coordinator", instanceId: "coordinator-test" },
    botId: BOT_ID,
    type: "bot.stop.command.v1",
    payload: {
      commandId,
      mode: "graceful",
      reason: "Operator confirmed Runtime Link transport stop.",
      requestedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 10_000).toISOString(),
      gracePeriodMs: 1_000,
      expectedRuntimeInstanceId: RUNTIME_ID,
      authorization: {
        decisionId: testUuid(921),
        actorId: "operator-01",
        permission: "bot.stop",
        issuedAt: new Date(NOW.getTime() - 1_000).toISOString(),
        expiresAt: new Date(NOW.getTime() + 10_000).toISOString(),
      },
    },
  };
}

function skillInvocation(invocationId: string): SkillInvocationV1 {
  return {
    schemaVersion: "1.0",
    messageId: testUuid(751),
    traceId: "trace-runtime-skill",
    timestamp: NOW.toISOString(),
    source: { service: "coordinator", instanceId: "coordinator-test" },
    botId: BOT_ID,
    taskId: "task-runtime-skill",
    type: "skill.invoke.v1",
    payload: {
      invocationId,
      skillId: "movement.goto",
      skillVersion: "1.0.0",
      expiresAt: new Date(NOW.getTime() + 10_000).toISOString(),
      input: {
        target: {
          x: 12,
          y: 64,
          z: -20,
          dimension: "minecraft:overworld",
          serverProfileId: "isolated-test",
        },
        radius: 2,
      },
      authorization: {
        decisionId: testUuid(752),
        actorId: "coordinator-agent",
        issuedAt: new Date(NOW.getTime() - 1_000).toISOString(),
        expiresAt: new Date(NOW.getTime() + 10_000).toISOString(),
      },
    },
  };
}

function skillResult(invocation: SkillInvocationV1): SkillExecutionResultV1 {
  return {
    schemaVersion: "1.0",
    messageId: testUuid(753),
    traceId: invocation.traceId,
    timestamp: NOW.toISOString(),
    source: { service: "bot-runtime", instanceId: RUNTIME_ID },
    botId: invocation.botId,
    taskId: invocation.taskId,
    type: "skill.result.v1",
    payload: {
      invocationId: invocation.payload.invocationId,
      skillId: invocation.payload.skillId,
      skillVersion: invocation.payload.skillVersion,
      completedAt: NOW.toISOString(),
      outcome: "completed",
      attempts: 1,
      output: { reached: true },
    },
  };
}

function authorizationContext(
  command: StopBotCommandV1,
): ControlAuthorizationContext {
  return {
    decisionId: command.payload.authorization.decisionId,
    actorId: command.payload.authorization.actorId,
    botId: command.botId,
    commandId: command.payload.commandId,
    permissions: new Set(["bot.stop"]),
    now: NOW,
  };
}

function trackRegistryUnsubscribe(registry: BotRegistry) {
  const unsubscribe = vi.fn();
  const subscribe = registry.subscribe.bind(registry);
  vi.spyOn(registry, "subscribe").mockImplementation((listener) => {
    const remove = subscribe(listener);
    return () => {
      unsubscribe();
      remove();
    };
  });
  return unsubscribe;
}

function hmac(value: string, secretSha256 = SECRET_SHA256): string {
  const key = Buffer.from(secretSha256, "hex");
  return createHmac("sha256", key).update(value, "utf8").digest("base64url");
}

function uuidSequence(start: number): () => string {
  let value = start;
  return () => testUuid(value++);
}

function testUuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}
