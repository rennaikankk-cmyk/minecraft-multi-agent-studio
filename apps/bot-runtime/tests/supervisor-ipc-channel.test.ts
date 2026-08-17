import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  BoundedIpcSender,
  SupervisorIpcTransportError,
  deriveIpcHmacKey,
  measureIpcPayload,
  signIpcProof,
  verifyIpcProof,
} from "../src/supervisor-ipc-channel.js";

describe("Supervisor IPC 通道", () => {
  it("对证明执行域绑定签名和常量时间校验", () => {
    const secret = randomBytes(32).toString("base64url");
    const key = deriveIpcHmacKey(secret);
    const proof = signIpcProof(key, "context-a");

    expect(proof).toHaveLength(43);
    expect(verifyIpcProof(key, "context-a", proof)).toBe(true);
    expect(verifyIpcProof(key, "context-b", proof)).toBe(false);
    expect(verifyIpcProof(key, "context-a", "invalid")).toBe(false);
  });

  it("限制排队消息数并在回调后释放预算", async () => {
    const callbacks: Array<(error: Error | null) => void> = [];
    const sender = new BoundedIpcSender(
      (_message, callback) => {
        callbacks.push(callback);
        return false;
      },
      {
        sendTimeoutMs: 1_000,
        maxQueuedMessages: 1,
        maxQueuedBytes: 1_024,
      },
    );
    const first = sender.send({ type: "first" });
    expect(sender.snapshot().queuedMessages).toBe(1);
    expect(() => sender.send({ type: "second" })).toThrowError(
      SupervisorIpcTransportError,
    );
    callbacks[0]?.(null);
    await first;
    expect(sender.snapshot()).toEqual({ queuedMessages: 0, queuedBytes: 0 });
  });

  it("拒绝循环对象和超过协议上限的载荷", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(() => measureIpcPayload(circular)).toThrowError(
      SupervisorIpcTransportError,
    );
    const sender = new BoundedIpcSender(() => true, {
      sendTimeoutMs: 1_000,
      maxQueuedMessages: 2,
      maxQueuedBytes: 200_000,
    });
    expect(() => sender.send({ value: "x".repeat(140_000) })).toThrowError(
      SupervisorIpcTransportError,
    );
  });
});
