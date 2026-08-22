"use client";

import {
  dashboardApiErrorV1Schema,
  dashboardTaskDetailResponseV1Schema,
  dashboardTaskListResponseV1Schema,
  type PublicTaskDetailV1,
  type PublicTaskSummaryV1,
} from "@minecraft-studio/protocol";
import { useCallback, useEffect, useRef, useState } from "react";

const REFRESH_INTERVAL_MS = 5_000;

type LoadState = "loading" | "ready" | "unavailable";

export function TaskHistory() {
  const [state, setState] = useState<LoadState>("loading");
  const [tasks, setTasks] = useState<PublicTaskSummaryV1[]>([]);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [detail, setDetail] = useState<PublicTaskDetailV1 | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const paginationExpandedRef = useRef(false);
  const refreshSequenceRef = useRef(0);
  const detailSequenceRef = useRef(0);
  const detailControllerRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++refreshSequenceRef.current;
    setRefreshing(true);
    try {
      const page = await requestTaskPage(null, signal);
      if (sequence !== refreshSequenceRef.current) return;
      setTasks((current) => paginationExpandedRef.current
        ? mergeRefreshedTasks(current, page.tasks)
        : page.tasks);
      setGeneratedAt(page.generatedAt);
      if (!paginationExpandedRef.current) setNextCursor(page.nextCursor);
      setError(null);
      setState("ready");
    } catch (cause) {
      if (isAbortError(cause) || sequence !== refreshSequenceRef.current) return;
      paginationExpandedRef.current = false;
      setTasks([]);
      setGeneratedAt(null);
      setNextCursor(null);
      setError(errorMessage(cause, "任务历史后端当前不可用。"));
      setState("unavailable");
    } finally {
      if (sequence === refreshSequenceRef.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const schedule = () => {
      if (disposed) return;
      timer = setTimeout(async () => {
        if (document.visibilityState === "visible") {
          await refresh(controller.signal);
        }
        schedule();
      }, REFRESH_INTERVAL_MS);
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") void refresh(controller.signal);
    };

    void refresh(controller.signal).finally(schedule);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      disposed = true;
      controller.abort();
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [refresh]);

  async function loadMore() {
    if (nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await requestTaskPage(nextCursor);
      setTasks((current) => mergeTasks(current, page.tasks));
      setGeneratedAt(page.generatedAt);
      setNextCursor(page.nextCursor);
      paginationExpandedRef.current = true;
      setError(null);
      setState("ready");
    } catch (cause) {
      setError(errorMessage(cause, "任务历史后端当前不可用。"));
      setState("unavailable");
    } finally {
      setLoadingMore(false);
    }
  }

  async function openDetail(taskId: string) {
    detailControllerRef.current?.abort();
    const controller = new AbortController();
    const sequence = ++detailSequenceRef.current;
    detailControllerRef.current = controller;
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const value = await safeJson(response);
      if (!response.ok) throw responseError(value, "任务详情后端当前不可用。");
      const parsed = dashboardTaskDetailResponseV1Schema.safeParse(value);
      if (!parsed.success || parsed.data.data.task.taskId !== taskId) {
        throw new Error("任务详情接口返回了无法识别的数据。");
      }
      if (sequence !== detailSequenceRef.current) return;
      setDetail(parsed.data.data.task);
    } catch (cause) {
      if (isAbortError(cause) || sequence !== detailSequenceRef.current) return;
      setDetailError(errorMessage(cause, "任务详情后端当前不可用。"));
    } finally {
      if (sequence === detailSequenceRef.current) {
        detailControllerRef.current = null;
        setDetailLoading(false);
      }
    }
  }

  function closeDetail() {
    detailSequenceRef.current += 1;
    detailControllerRef.current?.abort();
    detailControllerRef.current = null;
    setDetail(null);
    setDetailError(null);
    setDetailLoading(false);
  }

  useEffect(() => () => {
    detailSequenceRef.current += 1;
    detailControllerRef.current?.abort();
  }, []);

  return (
    <section className="taskHistory" data-testid="task-history">
      <div className="panelTitle">
        <div><span>DURABLE TASKS</span><h3>任务历史</h3></div>
        <div className="taskHistoryActions">
          <em
            className={`state ${state === "ready" ? "available" : state === "unavailable" ? "unavailable" : "unknown"}`}
            data-testid="task-history-state"
          >
            {state === "ready" ? "可用" : state === "unavailable" ? "不可用" : "读取中"}
          </em>
          <button type="button" onClick={() => void refresh()} disabled={refreshing}>
            {refreshing ? "刷新中..." : "刷新"}
          </button>
        </div>
      </div>

      {error ? <p className="goalError" role="alert">{error}</p> : null}
      {state === "loading" ? <p className="emptyText">正在读取任务历史...</p> : null}
      {state === "ready" && tasks.length === 0 ? (
        <p className="emptyText">暂无持久化任务记录。</p>
      ) : null}
      {state === "ready" && tasks.length > 0 ? (
        <ol className="taskHistoryList" data-testid="task-history-list">
          {tasks.map((task) => (
            <li key={task.taskId} data-testid="task-history-item">
              <div className="taskHistoryMain">
                <strong>{task.title}</strong>
                <small>{task.botId ?? "未分配 Bot"} · {formatTime(task.createdAt)}</small>
                <code>{task.taskId}</code>
              </div>
              <div className="taskHistoryMeta">
                <em className={`state ${statusTone(task.status)}`}>{statusLabel(task.status)}</em>
                <span>{task.taskType} · {task.riskLevel} · P{task.priority}</span>
              </div>
              <button type="button" onClick={() => void openDetail(task.taskId)}>
                查看详情
              </button>
            </li>
          ))}
        </ol>
      ) : null}
      {state === "ready" && nextCursor !== null ? (
        <button
          className="taskHistoryMore"
          type="button"
          onClick={() => void loadMore()}
          disabled={loadingMore}
        >
          {loadingMore ? "加载中..." : "加载更多"}
        </button>
      ) : null}
      {generatedAt ? (
        <p className="taskHistoryTimestamp">更新时间：{formatTime(generatedAt)}</p>
      ) : null}

      {detailLoading || detail || detailError ? (
        <section className="taskDetail" aria-live="polite" data-testid="task-detail">
          <div className="panelTitle">
            <div><span>TASK DETAIL</span><h3>任务详情</h3></div>
            <button type="button" onClick={closeDetail}>关闭</button>
          </div>
          {detailLoading ? <p className="emptyText">正在读取任务详情...</p> : null}
          {detailError ? <p className="goalError" role="alert">{detailError}</p> : null}
          {detail ? <TaskDetailFacts task={detail} /> : null}
        </section>
      ) : null}
    </section>
  );
}

function TaskDetailFacts({ task }: { task: PublicTaskDetailV1 }) {
  return (
    <dl className="goalTrackingGrid">
      <div><dt>任务 ID</dt><dd>{task.taskId}</dd></div>
      <div><dt>状态</dt><dd>{statusLabel(task.status)}</dd></div>
      <div><dt>Bot</dt><dd>{task.botId ?? "未分配"}</dd></div>
      <div><dt>风险等级</dt><dd>{task.riskLevel}</dd></div>
      <div><dt>创建时间</dt><dd>{formatTime(task.createdAt)}</dd></div>
      <div><dt>更新时间</dt><dd>{formatTime(task.updatedAt)}</dd></div>
      <div><dt>失败原因</dt><dd>{task.failureReason ?? "无"}</dd></div>
      <div className="taskGoalFact">
        <dt>操作目标</dt>
        <dd>{task.operatorGoal ?? "该任务没有可公开的操作目标。"}</dd>
      </div>
    </dl>
  );
}

async function requestTaskPage(cursor: string | null, signal?: AbortSignal) {
  const search = new URLSearchParams({ limit: "25" });
  if (cursor !== null) search.set("cursor", cursor);
  const response = await fetch(`/api/tasks?${search.toString()}`, {
    cache: "no-store",
    ...(signal ? { signal } : {}),
  });
  const value = await safeJson(response);
  if (!response.ok) throw responseError(value, "任务历史后端当前不可用。");
  const parsed = dashboardTaskListResponseV1Schema.safeParse(value);
  if (!parsed.success) throw new Error("任务历史接口返回了无法识别的数据。");
  return parsed.data.data;
}

function mergeTasks(
  current: readonly PublicTaskSummaryV1[],
  next: readonly PublicTaskSummaryV1[],
): PublicTaskSummaryV1[] {
  const merged = new Map(current.map((task) => [task.taskId, task]));
  for (const task of next) merged.set(task.taskId, task);
  return [...merged.values()];
}

function mergeRefreshedTasks(
  current: readonly PublicTaskSummaryV1[],
  refreshed: readonly PublicTaskSummaryV1[],
): PublicTaskSummaryV1[] {
  const refreshedIds = new Set(refreshed.map((task) => task.taskId));
  return [
    ...refreshed,
    ...current.filter((task) => !refreshedIds.has(task.taskId)),
  ];
}

function statusLabel(status: PublicTaskSummaryV1["status"]): string {
  const labels: Record<PublicTaskSummaryV1["status"], string> = {
    queued: "排队中",
    assigned: "已分配",
    running: "执行中",
    blocked: "受阻",
    waiting: "等待中",
    paused: "已暂停",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
    expired: "已过期",
  };
  return labels[status];
}

function statusTone(status: PublicTaskSummaryV1["status"]): "available" | "unknown" | "unavailable" {
  if (status === "failed" || status === "cancelled" || status === "expired") {
    return "unavailable";
  }
  if (status === "blocked" || status === "waiting" || status === "paused") {
    return "unknown";
  }
  return "available";
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN");
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    if (isAbortError(cause)) throw cause;
    throw new Error("接口返回了非 JSON 响应。");
  }
}

function responseError(value: unknown, fallback: string): Error {
  const parsed = dashboardApiErrorV1Schema.safeParse(value);
  return new Error(parsed.success ? parsed.data.error.message : fallback);
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === "AbortError";
}
