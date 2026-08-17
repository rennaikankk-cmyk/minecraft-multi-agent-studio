import { createHmac } from "node:crypto";

import {
  SUPERVISOR_IPC_MAX_BOTS_PER_PROCESS,
  SUPERVISOR_IPC_MAX_PAYLOAD_BYTES,
  parseSupervisorChildMessage,
  parseSupervisorParentMessage,
  supervisorIpcAuthenticateV1Schema,
  supervisorIpcChildProofInput,
  supervisorIpcLifecycleProofInput,
  supervisorIpcParentProofInput,
  supervisorIpcStartV1Schema,
  supervisorIpcStopProofInput,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

const secret = "s".repeat(32);
const base = {
  supervisorInstanceId: "supervisor-01",
  childId: "child-01",
  groupId: "group-01",
  challengeMessageId: "11111111-1111-4111-8111-111111111111",
  challengeNonce: "A".repeat(43),
  childNonce: "B".repeat(43),
  childPid: 1234,
} as const;

const assignment = {
  botId: "studio-bot-01",
  profilePath: "/srv/studio/profiles/bot-01.json",
  profileSha256: "a".repeat(64),
  deploymentTier: "production",
  runtimeLink: {
    url: "ws://127.0.0.1:3220/v1/runtime-link",
    keyId: "runtime-key-01",
    secret: "r".repeat(32),
  },
} as const;

function sign(value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

describe("Supervisor IPC 协议", () => {
  it("公开固定的消息与进程分组上限", () => {
    expect(SUPERVISOR_IPC_MAX_PAYLOAD_BYTES).toBe(131_072);
    expect(SUPERVISOR_IPC_MAX_BOTS_PER_PROCESS).toBe(3);
  });

  it("严格解析双向认证与启动清单", () => {
    const authenticate = {
      schemaVersion: "1.0",
      messageId: "22222222-2222-4222-8222-222222222222",
      timestamp: "2026-08-17T00:00:01.000Z",
      type: "supervisor.ipc.authenticate.v1",
      payload: {
        ...base,
        childProof: sign(supervisorIpcChildProofInput(base)),
      },
    } as const;
    expect(supervisorIpcAuthenticateV1Schema.parse(authenticate)).toEqual(
      authenticate,
    );
    expect(parseSupervisorChildMessage(authenticate)).toEqual(authenticate);

    const parentContext = {
      ...base,
      authenticateMessageId: authenticate.messageId,
      assignments: [assignment],
    } as const;
    const start = {
      schemaVersion: "1.0",
      messageId: "33333333-3333-4333-8333-333333333333",
      timestamp: "2026-08-17T00:00:02.000Z",
      type: "supervisor.ipc.start.v1",
      payload: {
        supervisorInstanceId: base.supervisorInstanceId,
        childId: base.childId,
        groupId: base.groupId,
        challengeMessageId: base.challengeMessageId,
        authenticateMessageId: authenticate.messageId,
        challengeNonce: base.challengeNonce,
        childNonce: base.childNonce,
        assignments: [assignment],
        parentProof: sign(supervisorIpcParentProofInput(parentContext)),
      },
    } as const;
    expect(supervisorIpcStartV1Schema.parse(start)).toEqual(start);
    expect(parseSupervisorParentMessage(start)).toEqual(start);
  });

  it("将清单、生命周期和停止原因绑定到不同证明域", () => {
    const parentProof = supervisorIpcParentProofInput({
      ...base,
      authenticateMessageId: "22222222-2222-4222-8222-222222222222",
      assignments: [assignment],
    });
    const changedProof = supervisorIpcParentProofInput({
      ...base,
      authenticateMessageId: "22222222-2222-4222-8222-222222222222",
      assignments: [{ ...assignment, botId: "studio-bot-02" }],
    });
    const lifecycleProof = supervisorIpcLifecycleProofInput({
      supervisorInstanceId: base.supervisorInstanceId,
      childId: base.childId,
      groupId: base.groupId,
      childPid: base.childPid,
      sequence: 1,
      state: "ready",
      botIds: [assignment.botId],
    });
    const stopProof = supervisorIpcStopProofInput({
      supervisorInstanceId: base.supervisorInstanceId,
      childId: base.childId,
      groupId: base.groupId,
      reason: "supervisor_shutdown",
    });

    expect(parentProof).not.toBe(changedProof);
    expect(parentProof).not.toBe(lifecycleProof);
    expect(lifecycleProof).not.toBe(stopProof);
  });

  it("拒绝未知字段、重复 Bot、越界分组和畸形证明", () => {
    const payload = {
      supervisorInstanceId: base.supervisorInstanceId,
      childId: base.childId,
      groupId: base.groupId,
      challengeMessageId: base.challengeMessageId,
      authenticateMessageId: "22222222-2222-4222-8222-222222222222",
      challengeNonce: base.challengeNonce,
      childNonce: base.childNonce,
      assignments: [assignment],
      parentProof: "C".repeat(43),
    };
    expect(() =>
      supervisorIpcStartV1Schema.parse({
        schemaVersion: "1.0",
        messageId: "33333333-3333-4333-8333-333333333333",
        timestamp: "2026-08-17T00:00:02.000Z",
        type: "supervisor.ipc.start.v1",
        payload: { ...payload, executable: "node arbitrary.js" },
      }),
    ).toThrow();
    expect(() =>
      supervisorIpcStartV1Schema.parse({
        schemaVersion: "1.0",
        messageId: "33333333-3333-4333-8333-333333333333",
        timestamp: "2026-08-17T00:00:02.000Z",
        type: "supervisor.ipc.start.v1",
        payload: { ...payload, assignments: [assignment, assignment] },
      }),
    ).toThrow();
    expect(() =>
      supervisorIpcStartV1Schema.parse({
        schemaVersion: "1.0",
        messageId: "33333333-3333-4333-8333-333333333333",
        timestamp: "2026-08-17T00:00:02.000Z",
        type: "supervisor.ipc.start.v1",
        payload: {
          ...payload,
          assignments: Array.from({ length: 4 }, (_, index) => ({
            ...assignment,
            botId: `studio-bot-0${index + 1}`,
          })),
        },
      }),
    ).toThrow();
    expect(() =>
      supervisorIpcAuthenticateV1Schema.parse({
        schemaVersion: "1.0",
        messageId: "22222222-2222-4222-8222-222222222222",
        timestamp: "2026-08-17T00:00:01.000Z",
        type: "supervisor.ipc.authenticate.v1",
        payload: { ...base, childProof: "short" },
      }),
    ).toThrow();
  });
});
