import { createHmac, timingSafeEqual } from "node:crypto";
import type { Duplex } from "node:stream";
import { WebSocket } from "ws";

import type { AppLogger } from "@minecraft-studio/observability";

/**
 * Control Link 与 Runtime Link 共用的传输安全原语。
 * 两个 WebSocket 认证服务此前各维护一份逐字节相同的实现（HMAC proof、
 * 回环判定、升级拒绝、关闭时序、日志隔离、整数界检查）——安全敏感逻辑
 * 漂移即产生分叉的认证行为，统一在此单点维护。
 */

export function hmac(secretSha256: string, value: string): string {
  return createHmac("sha256", Buffer.from(secretSha256, "hex"))
    .update(value, "utf8")
    .digest("base64url");
}

export function proofMatches(received: string, expected: string): boolean {
  const receivedBuffer = Buffer.from(received, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return (
    receivedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(receivedBuffer, expectedBuffer)
  );
}

export function validNow(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`${label} clock is invalid.`);
  }
  return value;
}

export function withinClockSkew(value: string, now: Date, maxSkewMs: number): boolean {
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) &&
    Math.abs(timestamp - now.getTime()) <= maxSkewMs
  );
}

export function isLoopbackAddress(value: string | undefined): boolean {
  if (!value) return false;
  return (
    value === "::1" ||
    value.startsWith("127.") ||
    value.toLowerCase().startsWith("::ffff:127.")
  );
}

export function rejectUpgrade(socket: Duplex, status: number, statusText: string): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  socket.end(
    `HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n`,
  );
}

export function closeWebSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      socket.terminate();
      finish();
    }, 500);
    timer.unref();
    socket.once("close", finish);
    socket.close(1001, "server_shutdown");
  });
}

export function safeLog(
  logger: AppLogger,
  level: "info" | "warn" | "error",
  event: string,
  fields: Readonly<Record<string, unknown>>,
): void {
  try {
    logger[level](event, fields);
  } catch {
    // Observability failures cannot alter authenticated transport state.
  }
}

export function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} is outside the allowed range.`);
  }
  return value;
}
