import {
  RUNTIME_LINK_MAX_PAYLOAD_BYTES,
  RUNTIME_LINK_PATH,
  RUNTIME_LINK_SUBPROTOCOL,
  parseRuntimeLinkClientMessage,
  parseRuntimeLinkServerMessage,
  runtimeLinkAcceptedV1Schema,
  runtimeLinkAuthenticateV1Schema,
  runtimeLinkChallengeV1Schema,
  runtimeLinkClientProofInput,
  runtimeLinkServerProofInput,
  runtimeLinkTelemetryAckV1Schema,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

const challenge = {
  schemaVersion: "1.0",
  messageId: "11111111-1111-4111-8111-111111111111",
  timestamp: "2026-08-07T00:00:00.000Z",
  type: "runtime.link.challenge.v1",
  payload: {
    coordinatorInstanceId: "coordinator-01",
    challengeNonce: "A".repeat(43),
  },
} as const;

const authenticate = {
  schemaVersion: "1.0",
  messageId: "22222222-2222-4222-8222-222222222222",
  timestamp: "2026-08-07T00:00:01.000Z",
  type: "runtime.link.authenticate.v1",
  payload: {
    challengeMessageId: challenge.messageId,
    coordinatorInstanceId: challenge.payload.coordinatorInstanceId,
    challengeNonce: challenge.payload.challengeNonce,
    clientNonce: "B".repeat(43),
    botId: "studio-bot-01",
    runtimeInstanceId: "runtime-01",
    keyId: "runtime-key-01",
    clientProof: "C".repeat(43),
  },
} as const;

describe("Runtime Link protocol", () => {
  it("publishes a fixed loopback transport contract", () => {
    expect(RUNTIME_LINK_PATH).toBe("/v1/runtime-link");
    expect(RUNTIME_LINK_SUBPROTOCOL).toBe("minecraft-studio.runtime.v1");
    expect(RUNTIME_LINK_MAX_PAYLOAD_BYTES).toBe(65_536);
  });

  it("strictly parses the mutual authentication handshake", () => {
    expect(runtimeLinkChallengeV1Schema.parse(challenge)).toEqual(challenge);
    expect(runtimeLinkAuthenticateV1Schema.parse(authenticate)).toEqual(
      authenticate,
    );
    const accepted = {
      schemaVersion: "1.0",
      messageId: "33333333-3333-4333-8333-333333333333",
      timestamp: "2026-08-07T00:00:02.000Z",
      type: "runtime.link.accepted.v1",
      payload: {
        challengeMessageId: challenge.messageId,
        authenticateMessageId: authenticate.messageId,
        coordinatorInstanceId: challenge.payload.coordinatorInstanceId,
        botId: authenticate.payload.botId,
        runtimeInstanceId: authenticate.payload.runtimeInstanceId,
        keyId: authenticate.payload.keyId,
        serverProof: "D".repeat(43),
      },
    } as const;
    expect(runtimeLinkAcceptedV1Schema.parse(accepted)).toEqual(accepted);
    expect(parseRuntimeLinkClientMessage(authenticate)).toEqual(authenticate);
    expect(parseRuntimeLinkServerMessage(accepted)).toEqual(accepted);
  });

  it("rejects unknown versions, fields, and malformed proofs", () => {
    expect(() =>
      runtimeLinkChallengeV1Schema.parse({ ...challenge, schemaVersion: "2.0" }),
    ).toThrow();
    expect(() =>
      runtimeLinkChallengeV1Schema.parse({ ...challenge, executable: "noop" }),
    ).toThrow();
    expect(() =>
      runtimeLinkAuthenticateV1Schema.parse({
        ...authenticate,
        payload: { ...authenticate.payload, clientProof: "short" },
      }),
    ).toThrow();
  });

  it("requires acknowledgement acceptance to match its reason", () => {
    const ack = {
      schemaVersion: "1.0",
      messageId: "44444444-4444-4444-8444-444444444444",
      timestamp: "2026-08-07T00:00:03.000Z",
      type: "runtime.link.telemetry-ack.v1",
      payload: {
        telemetryMessageId: "55555555-5555-4555-8555-555555555555",
        accepted: true,
        reason: "accepted",
      },
    } as const;
    expect(runtimeLinkTelemetryAckV1Schema.parse(ack)).toEqual(ack);
    expect(() =>
      runtimeLinkTelemetryAckV1Schema.parse({
        ...ack,
        payload: { ...ack.payload, reason: "duplicate_message" },
      }),
    ).toThrow();
  });

  it("builds stable, direction-bound proof inputs", () => {
    const proofContext = {
      challengeMessageId: challenge.messageId,
      coordinatorInstanceId: challenge.payload.coordinatorInstanceId,
      challengeNonce: challenge.payload.challengeNonce,
      clientNonce: authenticate.payload.clientNonce,
      botId: authenticate.payload.botId,
      runtimeInstanceId: authenticate.payload.runtimeInstanceId,
      keyId: authenticate.payload.keyId,
    };
    const clientInput = runtimeLinkClientProofInput(proofContext);
    const serverInput = runtimeLinkServerProofInput({
      ...proofContext,
      authenticateMessageId: authenticate.messageId,
    });
    expect(clientInput).toContain("runtime-link/client/v1");
    expect(serverInput).toContain("runtime-link/server/v1");
    expect(serverInput.endsWith(authenticate.messageId)).toBe(true);
    expect(serverInput).not.toBe(clientInput);
  });
});
