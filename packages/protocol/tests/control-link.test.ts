import { describe, expect, it } from "vitest";

import {
  CONTROL_LINK_MAX_BOTS,
  CONTROL_LINK_MAX_PAYLOAD_BYTES,
  CONTROL_LINK_PATH,
  CONTROL_LINK_SUBPROTOCOL,
  controlLinkAcceptedV1Schema,
  controlLinkAuthenticateV1Schema,
  controlLinkBotStateV1Schema,
  controlLinkChallengeV1Schema,
  controlLinkClientProofInput,
  controlLinkServerProofInput,
  controlLinkSnapshotBeginV1Schema,
  controlLinkSnapshotEndV1Schema,
  controlLinkSnapshotItemV1Schema,
  controlLinkStateUpsertV1Schema,
  controlLinkStopRequestV1Schema,
  controlLinkStopResponseV1Schema,
  parseControlLinkClientMessage,
  parseControlLinkServerMessage,
} from "../src/index.js";

const NOW = "2026-08-07T10:00:00.000Z";
const LATER = "2026-08-07T10:00:30.000Z";
const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const CHALLENGE_ID = "22222222-2222-4222-8222-222222222222";
const AUTHENTICATE_ID = "33333333-3333-4333-8333-333333333333";
const SNAPSHOT_ID = "44444444-4444-4444-8444-444444444444";

const bot = {
  botId: "worker-01",
  connectionState: "online" as const,
  lastMessageAt: NOW,
  lastHeartbeatAt: NOW,
  lastStatusAt: NOW,
  health: { current: 20, maximum: 20 },
  food: { level: 20, saturation: 5 },
  armorPoints: 0,
  latencyMs: 12,
  currentTask: null,
  position: { x: 1, y: 64, z: 2, dimension: "minecraft:overworld" },
  positionRedacted: false,
  minecraftVersion: null,
  safety: null,
};

const challenge = {
  schemaVersion: "1.0",
  messageId: CHALLENGE_ID,
  timestamp: NOW,
  type: "control.link.challenge.v1",
  payload: {
    coordinatorInstanceId: "coordinator-01",
    challengeNonce: "A".repeat(43),
  },
} as const;

const proofContext = {
  challengeMessageId: CHALLENGE_ID,
  coordinatorInstanceId: "coordinator-01",
  challengeNonce: "A".repeat(43),
  clientNonce: "B".repeat(43),
  clientId: "control-api",
  controlApiInstanceId: "control-api-01",
  keyId: "control-key-01",
};

const authenticate = {
  schemaVersion: "1.0",
  messageId: AUTHENTICATE_ID,
  timestamp: NOW,
  type: "control.link.authenticate.v1",
  payload: { ...proofContext, clientProof: "C".repeat(43) },
} as const;

describe("Control Link protocol", () => {
  it("publishes a fixed bounded transport contract", () => {
    expect(CONTROL_LINK_PATH).toBe("/v1/control-link");
    expect(CONTROL_LINK_SUBPROTOCOL).toBe("minecraft-studio.control-link.v1");
    expect(CONTROL_LINK_MAX_PAYLOAD_BYTES).toBe(65_536);
    expect(CONTROL_LINK_MAX_BOTS).toBe(1_000);
  });

  it("strictly validates the mutual authentication handshake", () => {
    expect(controlLinkChallengeV1Schema.parse(challenge)).toEqual(challenge);
    expect(controlLinkAuthenticateV1Schema.parse(authenticate)).toEqual(
      authenticate,
    );
    const accepted = {
      schemaVersion: "1.0",
      messageId: "55555555-5555-4555-8555-555555555555",
      timestamp: NOW,
      type: "control.link.accepted.v1",
      payload: {
        challengeMessageId: CHALLENGE_ID,
        authenticateMessageId: AUTHENTICATE_ID,
        coordinatorInstanceId: "coordinator-01",
        clientId: "control-api",
        controlApiInstanceId: "control-api-01",
        keyId: "control-key-01",
        serverProof: "D".repeat(43),
      },
    } as const;
    expect(controlLinkAcceptedV1Schema.parse(accepted)).toEqual(accepted);
    expect(parseControlLinkClientMessage(authenticate)).toEqual(authenticate);
    expect(parseControlLinkServerMessage(accepted)).toEqual(accepted);
  });

  it("uses direction- and protocol-bound proof inputs", () => {
    const client = controlLinkClientProofInput(proofContext);
    const server = controlLinkServerProofInput({
      ...proofContext,
      authenticateMessageId: AUTHENTICATE_ID,
    });
    expect(client).toContain("control-link/client/v1");
    expect(server).toContain("control-link/server/v1");
    expect(server.endsWith(AUTHENTICATE_ID)).toBe(true);
    expect(server).not.toBe(client);
  });

  it("requires an unredacted service state and bounded atomic snapshot", () => {
    expect(controlLinkBotStateV1Schema.parse(bot)).toEqual(bot);
    expect(() =>
      controlLinkBotStateV1Schema.parse({
        ...bot,
        position: null,
        positionRedacted: true,
      }),
    ).toThrow();

    const begin = {
      schemaVersion: "1.0",
      messageId: "66666666-6666-4666-8666-666666666666",
      timestamp: NOW,
      type: "control.link.snapshot-begin.v1",
      payload: {
        coordinatorInstanceId: "coordinator-01",
        snapshotId: SNAPSHOT_ID,
        baseSequence: 8,
        botCount: 1,
      },
    } as const;
    expect(controlLinkSnapshotBeginV1Schema.parse(begin)).toEqual(begin);
    expect(
      controlLinkSnapshotItemV1Schema.parse({
        ...begin,
        messageId: "77777777-7777-4777-8777-777777777777",
        type: "control.link.snapshot-item.v1",
        payload: {
          coordinatorInstanceId: begin.payload.coordinatorInstanceId,
          snapshotId: begin.payload.snapshotId,
          baseSequence: begin.payload.baseSequence,
          index: 0,
          bot,
        },
      }).payload.bot.botId,
    ).toBe(bot.botId);
    expect(
      controlLinkSnapshotEndV1Schema.parse({
        ...begin,
        messageId: "88888888-8888-4888-8888-888888888888",
        type: "control.link.snapshot-end.v1",
      }).payload.baseSequence,
    ).toBe(8);
    expect(
      controlLinkStateUpsertV1Schema.parse({
        ...begin,
        messageId: "99999999-9999-4999-8999-999999999999",
        type: "control.link.state-upsert.v1",
        payload: {
          coordinatorInstanceId: "coordinator-01",
          streamSequence: 9,
          bot,
        },
      }).payload.streamSequence,
    ).toBe(9);
  });

  it("accepts only the minimal delegated graceful-stop request", () => {
    const request = {
      schemaVersion: "1.0",
      messageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      timestamp: NOW,
      type: "control.link.stop-request.v1",
      payload: {
        coordinatorInstanceId: "coordinator-01",
        clientId: "control-api",
        controlApiInstanceId: "control-api-01",
        operationId: OPERATION_ID,
        botId: bot.botId,
        actorId: "operator-01",
        issuedAt: NOW,
        expiresAt: LATER,
      },
    } as const;
    expect(controlLinkStopRequestV1Schema.parse(request)).toEqual(request);
    expect(parseControlLinkClientMessage(request)).toEqual(request);
    expect(() =>
      controlLinkStopRequestV1Schema.parse({
        ...request,
        payload: { ...request.payload, permission: "bot.stop" },
      }),
    ).toThrow();
    expect(() =>
      controlLinkStopRequestV1Schema.parse({
        ...request,
        payload: {
          ...request.payload,
          expiresAt: "2026-08-07T10:02:00.000Z",
        },
      }),
    ).toThrow();
  });

  it("binds stop responses to the original operation and Bot", () => {
    const response = {
      schemaVersion: "1.0",
      messageId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      timestamp: LATER,
      type: "control.link.stop-response.v1",
      ok: true,
      payload: {
        coordinatorInstanceId: "coordinator-01",
        requestMessageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        operationId: OPERATION_ID,
        botId: bot.botId,
        result: {
          schemaVersion: "1.0",
          messageId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          traceId: OPERATION_ID,
          timestamp: LATER,
          source: { service: "bot-runtime", instanceId: "runtime-01" },
          botId: bot.botId,
          type: "bot.stop.result.v1",
          payload: {
            commandId: OPERATION_ID,
            runtimeInstanceId: "runtime-01",
            outcome: "completed",
            completedAt: LATER,
          },
        },
      },
    } as const;
    expect(controlLinkStopResponseV1Schema.parse(response)).toEqual(response);
    expect(parseControlLinkServerMessage(response)).toEqual(response);
    expect(() =>
      controlLinkStopResponseV1Schema.parse({
        ...response,
        payload: { ...response.payload, operationId: CHALLENGE_ID },
      }),
    ).toThrow();
    expect(
      controlLinkStopResponseV1Schema.parse({
        ...response,
        ok: false,
        payload: {
          coordinatorInstanceId: "coordinator-01",
          requestMessageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          operationId: OPERATION_ID,
          botId: bot.botId,
          errorCode: "CONTROL_LINK_BACKPRESSURE",
        },
      }).ok,
    ).toBe(false);
  });
});
