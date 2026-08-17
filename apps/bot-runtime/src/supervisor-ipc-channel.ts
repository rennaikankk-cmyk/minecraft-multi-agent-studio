import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { SUPERVISOR_IPC_MAX_PAYLOAD_BYTES } from "@minecraft-studio/protocol";

import type { BotSupervisorIpcConfig } from "./supervisor-config.js";

export type SupervisorIpcTransportErrorCode =
  | "IPC_PAYLOAD_INVALID"
  | "IPC_PAYLOAD_TOO_LARGE"
  | "IPC_QUEUE_OVERFLOW"
  | "IPC_CHANNEL_CLOSED"
  | "IPC_SEND_FAILED"
  | "IPC_SEND_TIMEOUT";

export class SupervisorIpcTransportError extends Error {
  readonly code: SupervisorIpcTransportErrorCode;

  constructor(code: SupervisorIpcTransportErrorCode, message: string) {
    super(message);
    this.name = "SupervisorIpcTransportError";
    this.code = code;
  }
}

export type IpcSendFunction = (
  message: unknown,
  callback: (error: Error | null) => void,
) => boolean;

export class BoundedIpcSender {
  private queuedMessages = 0;
  private queuedBytes = 0;

  constructor(
    private readonly sendFunction: IpcSendFunction,
    private readonly config: Pick<
      BotSupervisorIpcConfig,
      "sendTimeoutMs" | "maxQueuedMessages" | "maxQueuedBytes"
    >,
  ) {}

  send(message: unknown): Promise<void> {
    const bytes = measureIpcPayload(message);
    if (bytes > SUPERVISOR_IPC_MAX_PAYLOAD_BYTES) {
      throw new SupervisorIpcTransportError(
        "IPC_PAYLOAD_TOO_LARGE",
        "Supervisor IPC 消息超过协议上限。",
      );
    }
    if (
      this.queuedMessages + 1 > this.config.maxQueuedMessages ||
      this.queuedBytes + bytes > this.config.maxQueuedBytes
    ) {
      throw new SupervisorIpcTransportError(
        "IPC_QUEUE_OVERFLOW",
        "Supervisor IPC 发送队列超过上限。",
      );
    }

    this.queuedMessages += 1;
    this.queuedBytes += bytes;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: SupervisorIpcTransportError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.queuedMessages -= 1;
        this.queuedBytes -= bytes;
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(
        () =>
          finish(
            new SupervisorIpcTransportError(
              "IPC_SEND_TIMEOUT",
              "Supervisor IPC 发送超时。",
            ),
          ),
        this.config.sendTimeoutMs,
      );

      try {
        this.sendFunction(message, (error) => {
          if (error) {
            finish(
              new SupervisorIpcTransportError(
                "IPC_SEND_FAILED",
                "Supervisor IPC 发送失败。",
              ),
            );
            return;
          }
          finish();
        });
      } catch {
        finish(
          new SupervisorIpcTransportError(
            "IPC_CHANNEL_CLOSED",
            "Supervisor IPC 通道已经关闭。",
          ),
        );
      }
    });
  }

  snapshot(): Readonly<{ queuedMessages: number; queuedBytes: number }> {
    return Object.freeze({
      queuedMessages: this.queuedMessages,
      queuedBytes: this.queuedBytes,
    });
  }
}

export function measureIpcPayload(input: unknown): number {
  try {
    const serialized = JSON.stringify(input);
    if (serialized === undefined) throw new Error("载荷无法序列化。");
    return Buffer.byteLength(serialized, "utf8");
  } catch {
    throw new SupervisorIpcTransportError(
      "IPC_PAYLOAD_INVALID",
      "Supervisor IPC 消息无法安全序列化。",
    );
  }
}

export function deriveIpcHmacKey(secret: string): Buffer {
  if (
    secret.length !== 43 ||
    !/^[A-Za-z0-9_-]+$/u.test(secret)
  ) {
    throw new TypeError("Supervisor IPC 会话密钥格式无效。");
  }
  return createHash("sha256").update(secret, "utf8").digest();
}

export function signIpcProof(key: Buffer, input: string): string {
  return createHmac("sha256", key).update(input, "utf8").digest("base64url");
}

export function verifyIpcProof(
  key: Buffer,
  input: string,
  proof: string,
): boolean {
  let actual: Buffer;
  try {
    actual = Buffer.from(proof, "base64url");
  } catch {
    return false;
  }
  const expected = createHmac("sha256", key).update(input, "utf8").digest();
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}
