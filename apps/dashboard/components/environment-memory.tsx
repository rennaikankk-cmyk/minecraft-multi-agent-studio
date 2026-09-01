"use client";

// 实时内存采样卡（自旧 Overview 提取，语义不变）：
// /api/environment 初始快照 + /api/environment/memory 每 5s 采集；
// 请求 4s 超时；>15s 未成功采集或连续失败 → 明确"数据已过期"；页面隐藏不采集。
import { useCallback, useEffect, useRef, useState } from "react";

import {
  environmentMemorySampleSchema,
  type EnvironmentMemorySample,
} from "@minecraft-studio/protocol";

const MEMORY_POLL_INTERVAL_MS = 5_000;
const MEMORY_REQUEST_TIMEOUT_MS = 4_000;
const MEMORY_SAMPLE_STALE_AFTER_MS = 15_000;

type EnvironmentMemoryResponse = {
  requestId?: string;
  sample?: EnvironmentMemorySample;
  error?: { message?: string };
};

function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "—";
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${gib.toFixed(2)} GiB`;
  return `${(bytes / 1024 ** 2).toFixed(0)} MiB`;
}

export function EnvironmentMemoryCard() {
  const [memorySample, setMemorySample] = useState<EnvironmentMemorySample | null>(null);
  const [memoryError, setMemoryError] = useState<string>("");
  const [memoryStaleByAge, setMemoryStaleByAge] = useState(false);
  const [initial, setInitial] = useState<{ totalBytes: number; freeBytes: number; capturedAt: string } | null>(null);
  const memoryLastSuccessAtRef = useRef<number | null>(null);
  const memoryLatestCapturedAtRef = useRef<number>(Number.NEGATIVE_INFINITY);

  const applyMemorySample = useCallback((sample: EnvironmentMemorySample) => {
    const capturedAt = Date.parse(sample.capturedAt);
    if (capturedAt < memoryLatestCapturedAtRef.current) return false;
    memoryLatestCapturedAtRef.current = capturedAt;
    memoryLastSuccessAtRef.current = Date.now();
    setMemorySample(sample);
    setMemoryError("");
    setMemoryStaleByAge(false);
    return true;
  }, []);

  // 初始快照（/api/environment）
  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const response = await fetch("/api/environment", { cache: "no-store" });
        const body = (await response.json()) as {
          environment?: { capturedAt: string; hardware?: { memory?: { totalBytes: number; freeBytes: number } } };
        };
        const memory = body.environment?.hardware?.memory;
        if (disposed || !memory) return;
        setInitial({ totalBytes: memory.totalBytes, freeBytes: memory.freeBytes, capturedAt: body.environment!.capturedAt });
        applyMemorySample(
          environmentMemorySampleSchema.parse({
            schemaVersion: "1.0",
            capturedAt: body.environment!.capturedAt,
            source: "node-os",
            memory,
          }),
        );
      } catch {
        // 初始快照失败：等待 5s 采集通道；卡片显示 —
      }
    })();
    return () => {
      disposed = true;
    };
  }, [applyMemorySample]);

  // 5s 采集（可见页面）+ 可见性恢复 + 过期标记
  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let activeController: AbortController | null = null;
    let requestTimeout: number | null = null;

    const captureMemory = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      const controller = new AbortController();
      activeController = controller;
      requestTimeout = window.setTimeout(() => controller.abort(), MEMORY_REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch("/api/environment/memory", { cache: "no-store", signal: controller.signal });
        const body = (await response.json()) as EnvironmentMemoryResponse;
        if (!response.ok) throw new Error(body.error?.message ?? "内存采集接口不可用");
        const parsed = environmentMemorySampleSchema.safeParse(body.sample);
        if (!parsed.success) throw new Error("内存采集接口返回了无法识别的数据");
        if (!disposed) applyMemorySample(parsed.data);
      } catch (cause) {
        if (!disposed) {
          setMemoryError(
            cause instanceof DOMException && cause.name === "AbortError"
              ? "采集超时，正在显示上次成功结果"
              : cause instanceof Error
                ? cause.message
                : "内存采集失败，正在显示上次成功结果",
          );
        }
      } finally {
        if (requestTimeout !== null) window.clearTimeout(requestTimeout);
        requestTimeout = null;
        if (activeController === controller) activeController = null;
        inFlight = false;
      }
    };

    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void captureMemory();
    }, MEMORY_POLL_INTERVAL_MS);

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      const lastSuccessAt = memoryLastSuccessAtRef.current;
      if (lastSuccessAt !== null && Date.now() - lastSuccessAt >= MEMORY_SAMPLE_STALE_AFTER_MS) {
        setMemoryStaleByAge(true);
      }
      void captureMemory();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (requestTimeout !== null) window.clearTimeout(requestTimeout);
      activeController?.abort();
    };
  }, [applyMemorySample]);

  // 15s 无新样本 → 按时长过期
  useEffect(() => {
    if (!memorySample || memoryLastSuccessAtRef.current === null) return;
    const remaining = Math.max(0, MEMORY_SAMPLE_STALE_AFTER_MS - (Date.now() - memoryLastSuccessAtRef.current));
    const timeout = window.setTimeout(() => setMemoryStaleByAge(true), remaining);
    return () => window.clearTimeout(timeout);
  }, [memorySample]);

  const memoryIsStale = Boolean(memoryError) || memoryStaleByAge;
  const totalBytes = memorySample?.memory.totalBytes ?? initial?.totalBytes;
  const freeBytes = memorySample?.memory.freeBytes ?? initial?.freeBytes;
  const capturedAt = memorySample?.capturedAt ?? initial?.capturedAt;

  return (
    <div>
      <div className="flex justify-between text-[12.5px]">
        <span className="text-subtle-foreground">Memory total / free</span>
        <span className="data-mono">{formatBytes(totalBytes)} / {formatBytes(freeBytes)}</span>
      </div>
      <p className="mt-1 text-[11px]" data-testid="memory-free">
        当前可用 {formatBytes(freeBytes)}
      </p>
      <p
        className={memoryIsStale ? "text-[11px] text-warning" : "text-[11px] text-subtle-foreground"}
        data-testid="memory-sample-status"
      >
        {memoryError
          ? `数据已过期：${memoryError}`
          : memoryStaleByAge
            ? "数据已过期：超过 15 秒未成功采集"
            : `每 5 秒采集 · ${capturedAt ? new Date(capturedAt).toLocaleTimeString("zh-CN") : "—"}`}
      </p>
    </div>
  );
}
