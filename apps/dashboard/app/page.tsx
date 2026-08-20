"use client";

import {
  environmentMemorySampleSchema,
  type EnvironmentMemorySample,
  type EnvironmentSnapshot,
} from "@minecraft-studio/protocol";
import { useCallback, useEffect, useRef, useState } from "react";

import { BotOverviewStrip } from "@/components/bot-overview-strip";

type EnvironmentResponse = {
  requestId: string;
  environment: EnvironmentSnapshot;
};

type ApiError = {
  requestId?: string;
  error?: { code?: string; message?: string };
};

type EnvironmentMemoryResponse = {
  requestId?: string;
  sample?: unknown;
  error?: { code?: string; message?: string };
};

const MEMORY_POLL_INTERVAL_MS = 5_000;
const MEMORY_REQUEST_TIMEOUT_MS = 4_000;
const MEMORY_SAMPLE_STALE_AFTER_MS = 15_000;

const modeNames: Record<EnvironmentSnapshot["mode"]["value"], string> = {
  standard: "标准模式",
  docker: "Docker 模式",
  portable: "便携模式",
  netcafe: "网吧模式",
};

const softwareNames: Record<EnvironmentSnapshot["software"][number]["id"], string> = {
  node: "Node.js",
  java: "Java",
  docker: "Docker",
  git: "Git",
};

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "无法读取";
  const gib = value / 1024 ** 3;
  return `${gib.toFixed(gib >= 10 ? 1 : 2)} GiB`;
}

function statusText(status: EnvironmentSnapshot["software"][number]["status"]): string {
  if (status === "available") return "可用";
  if (status === "unavailable") return "未安装或不可访问";
  return "探测失败";
}

export default function HomePage() {
  const [snapshot, setSnapshot] = useState<EnvironmentSnapshot | null>(null);
  const [requestId, setRequestId] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [memorySample, setMemorySample] =
    useState<EnvironmentMemorySample | null>(null);
  const [memoryError, setMemoryError] = useState<string>("");
  const [memoryStaleByAge, setMemoryStaleByAge] = useState(false);
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

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/environment", { cache: "no-store" });
      const body = (await response.json()) as EnvironmentResponse | ApiError;
      setRequestId(body.requestId ?? "");

      if (!response.ok) {
        const apiError = body as ApiError;
        throw new Error(apiError.error?.message ?? "环境检测接口不可用");
      }

      if (!("environment" in body)) {
        throw new Error("环境检测接口返回了无法识别的数据");
      }

      const initialMemorySample = environmentMemorySampleSchema.parse({
        schemaVersion: "1.0",
        capturedAt: body.environment.capturedAt,
        source: "node-os",
        memory: body.environment.hardware.memory,
      });
      setSnapshot(body.environment);
      applyMemorySample(initialMemorySample);
    } catch (cause) {
      setSnapshot(null);
      setError(cause instanceof Error ? cause.message : "环境检测失败");
    } finally {
      setLoading(false);
    }
  }, [applyMemorySample]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
      requestTimeout = window.setTimeout(
        () => controller.abort(),
        MEMORY_REQUEST_TIMEOUT_MS,
      );

      try {
        const response = await fetch("/api/environment/memory", {
          cache: "no-store",
          signal: controller.signal,
        });
        const body = (await response.json()) as EnvironmentMemoryResponse;
        if (!response.ok) {
          throw new Error(body.error?.message ?? "内存采集接口不可用");
        }
        const parsed = environmentMemorySampleSchema.safeParse(body.sample);
        if (!parsed.success) {
          throw new Error("内存采集接口返回了无法识别的数据");
        }
        if (!disposed) {
          applyMemorySample(parsed.data);
        }
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

    const interval = window.setInterval(
      () => {
        if (document.visibilityState === "visible") void captureMemory();
      },
      MEMORY_POLL_INTERVAL_MS,
    );
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      const lastSuccessAt = memoryLastSuccessAtRef.current;
      if (
        lastSuccessAt !== null &&
        Date.now() - lastSuccessAt >= MEMORY_SAMPLE_STALE_AFTER_MS
      ) {
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

  useEffect(() => {
    if (!memorySample || memoryLastSuccessAtRef.current === null) return;
    const remaining = Math.max(
      0,
      MEMORY_SAMPLE_STALE_AFTER_MS -
        (Date.now() - memoryLastSuccessAtRef.current),
    );
    const timeout = window.setTimeout(
      () => setMemoryStaleByAge(true),
      remaining,
    );
    return () => window.clearTimeout(timeout);
  }, [memorySample]);

  const memoryIsStale = Boolean(memoryError) || memoryStaleByAge;

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brandMark" aria-hidden="true">M</div>
        <div>
          <p className="eyebrow">CONTROL PLANE · ENVIRONMENT</p>
          <h1>Minecraft Multi-Agent Studio</h1>
        </div>
        <button className="refreshButton" type="button" onClick={() => void refresh()} disabled={loading}>
          {loading ? "检测中…" : "重新检测"}
        </button>
      </header>

      <section className="hero">
        <div>
          <span className="liveBadge"><i />真实环境检测</span>
          <h2>先认识运行环境，再启动任何 Agent。</h2>
          <p>
            本页只展示服务端实时读取的设备和软件信息。不绑定固定 CPU、GPU 或主机，
            也不会用模拟 Bot 状态填充控制台。
          </p>
        </div>
        <div className="modeCard">
          <span>当前运行模式</span>
          <strong>{snapshot ? modeNames[snapshot.mode.value] : loading ? "检测中" : "不可用"}</strong>
          <small>{snapshot ? `来源：${snapshot.mode.source}` : "等待真实检测结果"}</small>
        </div>
      </section>

      <BotOverviewStrip />

      {error ? (
        <section className="errorPanel" role="alert">
          <strong>环境状态不可用</strong>
          <span>{error}</span>
          {requestId ? <code>请求编号：{requestId}</code> : null}
        </section>
      ) : null}

      {snapshot ? (
        <>
          <section className="sectionHeading">
            <div>
              <span>HARDWARE</span>
              <h3>当前设备</h3>
            </div>
            <time dateTime={snapshot.capturedAt}>
              采集时间：{new Date(snapshot.capturedAt).toLocaleString("zh-CN")}
            </time>
          </section>

          <section className="metricGrid">
            <article className="metricCard wide">
              <span>处理器</span>
              <strong>{snapshot.hardware.cpu.model}</strong>
              <small>{snapshot.hardware.cpu.logicalCores} 个逻辑核心</small>
            </article>
            <article className="metricCard" data-testid="memory-card">
              <span>内存</span>
              <strong>
                {formatBytes(
                  memorySample?.memory.totalBytes ??
                    snapshot.hardware.memory.totalBytes,
                )}
              </strong>
              <small data-testid="memory-free">
                当前可用{" "}
                {formatBytes(
                  memorySample?.memory.freeBytes ??
                    snapshot.hardware.memory.freeBytes,
                )}
              </small>
              <small
                className={`memorySampleStatus ${memoryIsStale ? "stale" : "fresh"}`}
                data-testid="memory-sample-status"
              >
                {memoryError
                  ? `数据已过期：${memoryError}`
                  : memoryStaleByAge
                    ? "数据已过期：超过 15 秒未成功采集"
                  : `每 5 秒采集 · ${new Date(
                      memorySample?.capturedAt ?? snapshot.capturedAt,
                    ).toLocaleTimeString("zh-CN")}`}
              </small>
            </article>
            <article className="metricCard">
              <span>系统</span>
              <strong>{snapshot.hardware.platform} · {snapshot.hardware.architecture}</strong>
              <small>版本 {snapshot.hardware.release}</small>
            </article>
          </section>

          <section className="panelGrid">
            <article className="panel">
              <div className="panelTitle">
                <div>
                  <span>GRAPHICS</span>
                  <h3>图形设备</h3>
                </div>
                <em className={`state ${snapshot.hardware.gpu.status}`}>
                  {snapshot.hardware.gpu.status === "detected"
                    ? "已检测"
                    : snapshot.hardware.gpu.status === "not_detected"
                      ? "未发现"
                      : "探测不可用"}
                </em>
              </div>
              {snapshot.hardware.gpu.devices.length ? (
                <ul className="dataList">
                  {snapshot.hardware.gpu.devices.map((device, index) => (
                    <li key={`${device.name}-${index}`}>
                      <div><strong>{device.name}</strong><small>{device.vendor ?? "厂商信息未提供"}</small></div>
                      <span>{device.memoryBytes ? formatBytes(device.memoryBytes) : "显存未知"}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="emptyText">没有可展示的图形设备；系统不会补造设备信息。</p>
              )}
              <small className="sourceText">探测来源：{snapshot.hardware.gpu.source}</small>
            </article>

            <article className="panel">
              <div className="panelTitle">
                <div>
                  <span>SOFTWARE</span>
                  <h3>本机软件</h3>
                </div>
              </div>
              <ul className="dataList">
                {snapshot.software.map((item) => (
                  <li key={item.id}>
                    <div><strong>{softwareNames[item.id]}</strong><small>{item.version ?? item.detail ?? "没有版本信息"}</small></div>
                    <em className={`state ${item.status}`}>{statusText(item.status)}</em>
                  </li>
                ))}
              </ul>
            </article>
          </section>

          {snapshot.warnings.length ? (
            <section className="warningPanel">
              <strong>检测说明</strong>
              <ul>{snapshot.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
            </section>
          ) : null}
        </>
      ) : loading ? <section className="loadingPanel">正在从当前设备读取真实环境信息…</section> : null}

      <section className="sectionHeading serviceHeading">
        <div><span>SERVICE STATUS</span><h3>服务接入状态</h3></div>
      </section>
      <section className="serviceGrid">
        <article><i className="ready" /><div><strong>环境检测</strong><small>本模块已接入</small></div></article>
        <article><i className="ready" /><div><strong>Control API</strong><small>状态以实时请求结果为准</small></div></article>
        <article><i /><div><strong>Bot Runtime</strong><small>Runtime Link 已接入；无遥测不显示在线</small></div></article>
        <article><i /><div><strong>Coordinator</strong><small>Control Link 已接入；断线明确标记不可用</small></div></article>
        <article><i /><div><strong>Local AI Hub</strong><small>在线状态以 AI 节点页实时采集为准</small></div></article>
      </section>

      <footer>
        <span>Schema v{snapshot?.schemaVersion ?? "—"}</span>
        <span>{requestId ? `请求 ${requestId}` : "尚无请求编号"}</span>
      </footer>
    </main>
  );
}
