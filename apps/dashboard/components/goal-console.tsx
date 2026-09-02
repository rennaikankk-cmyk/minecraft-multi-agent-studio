"use client";

import {
  dashboardApiErrorV1Schema,
  dashboardBotListResponseV1Schema,
  dashboardGoalResponseV1Schema,
  type DashboardApiErrorCode,
  type GoalDispatchResultV1,
  type GoalDispatchWaitingV1,
  type PublicBotDetailV1,
} from "@minecraft-studio/protocol";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

const BOT_REFRESH_MS = 3_000;
const MAX_RECENT_GOALS = 8;
const AMBIGUOUS_GOAL_ERRORS = new Set<DashboardApiErrorCode>([
  "CONTROL_API_UNAVAILABLE",
  "INVALID_CONTROL_RESPONSE",
  "GOAL_FAILED",
  "RATE_LIMITED",
]);

type PendingGoal = Readonly<{
  requestId: string;
  botId: string;
  operatorGoal: string;
  submittedAt: string;
}>;

type CurrentTask = NonNullable<PublicBotDetailV1["currentTask"]>;

type RecentGoal = Readonly<{
  taskId: string;
  botId: string;
  operatorGoal: string;
  submittedAt: string;
  result: GoalDispatchResultV1 | GoalDispatchWaitingV1 | null;
  error: string | null;
  retryPending: boolean;
}>;

export function GoalConsole() {
  const [bots, setBots] = useState<PublicBotDetailV1[]>([]);
  const [botId, setBotId] = useState("");
  const [operatorGoal, setOperatorGoal] = useState("");
  const [loadingBots, setLoadingBots] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [botError, setBotError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [retryPending, setRetryPending] = useState(false);
  const [result, setResult] = useState<GoalDispatchResultV1 | GoalDispatchWaitingV1 | null>(null);
  const [recentGoals, setRecentGoals] = useState<RecentGoal[]>([]);
  const pendingGoal = useRef<PendingGoal | null>(null);

  useEffect(() => {
    let disposed = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;

    async function refreshBots() {
      controller = new AbortController();
      try {
        const response = await fetch("/api/bots", {
          cache: "no-store",
          signal: controller.signal,
        });
        const value = await response.json() as unknown;
        if (!response.ok) {
          const parsedError = dashboardApiErrorV1Schema.safeParse(value);
          throw new Error(
            parsedError.success
              ? parsedError.data.error.message
              : "Bot 状态接口不可用。",
          );
        }
        const parsed = dashboardBotListResponseV1Schema.parse(value);
        if (disposed) return;
        setBots(parsed.data.bots);
        setBotError(null);
        const online = parsed.data.bots.filter(
          ({ connectionState }) => connectionState === "online",
        );
        setBotId((current) =>
          online.some((bot) => bot.botId === current)
            ? current
            : online[0]?.botId ?? "",
        );
      } catch (cause) {
        if (disposed || isAbortError(cause)) return;
        setBots([]);
        setBotId("");
        setBotError(cause instanceof Error ? cause.message : "Bot 状态接口不可用。");
      } finally {
        if (!disposed) {
          setLoadingBots(false);
          refreshTimer = setTimeout(() => void refreshBots(), BOT_REFRESH_MS);
        }
      }
    }

    void refreshBots();
    return () => {
      disposed = true;
      if (refreshTimer !== undefined) clearTimeout(refreshTimer);
      controller?.abort();
    };
  }, []);

  useEffect(() => {
    const pending = pendingGoal.current;
    if (
      pending &&
      (pending.botId !== botId || pending.operatorGoal !== operatorGoal.trim())
    ) {
      pendingGoal.current = null;
      setRetryPending(false);
    }
  }, [botId, operatorGoal]);

  const onlineBots = useMemo(
    () => bots.filter(({ connectionState }) => connectionState === "online"),
    [bots],
  );

  async function submitGoal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedGoal = operatorGoal.trim();
    if (!botId || !trimmedGoal || submitting) return;

    const existing = pendingGoal.current;
    const operation = existing?.botId === botId && existing.operatorGoal === trimmedGoal
      ? existing
      : {
          requestId: crypto.randomUUID(),
          botId,
          operatorGoal: trimmedGoal,
          submittedAt: new Date().toISOString(),
        };
    pendingGoal.current = operation;
    setRecentGoals((current) => upsertRecentGoal(current, {
      taskId: operation.requestId,
      botId: operation.botId,
      operatorGoal: operation.operatorGoal,
      submittedAt: operation.submittedAt,
      result: null,
      error: null,
      retryPending: false,
    }));
    setSubmitting(true);
    setSubmitError(null);
    setResult(null);
    setRetryPending(false);
    let preserveOperation = true;

    try {
      const response = await fetch("/api/goals", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Studio-Action": "submit-goal",
        },
        body: JSON.stringify({
          schemaVersion: "1.0",
          requestId: operation.requestId,
          botId: operation.botId,
          operatorGoal: operation.operatorGoal,
        }),
      });

      let value: unknown;
      try {
        value = await response.json() as unknown;
      } catch {
        throw new Error("目标结果不是有效 JSON，执行状态尚未确认。");
      }

      if (!response.ok) {
        const parsedError = dashboardApiErrorV1Schema.safeParse(value);
        if (parsedError.success) {
          preserveOperation = AMBIGUOUS_GOAL_ERRORS.has(parsedError.data.error.code);
          throw new Error(parsedError.data.error.message);
        }
        throw new Error("目标提交失败，执行状态尚未确认。");
      }

      const parsed = dashboardGoalResponseV1Schema.safeParse(value);
      if (
        !parsed.success ||
        parsed.data.data.botId !== operation.botId ||
        parsed.data.data.taskId !== operation.requestId
      ) {
        throw new Error("目标结果与当前请求不匹配，执行状态尚未确认。");
      }

      preserveOperation = false;
      pendingGoal.current = null;
      setResult(parsed.data.data);
      setRecentGoals((current) => updateRecentGoal(current, operation.requestId, {
        result: parsed.data.data,
        error: null,
        retryPending: false,
      }));
    } catch (cause) {
      if (!preserveOperation) pendingGoal.current = null;
      const message = cause instanceof Error ? cause.message : "目标提交失败。";
      setRetryPending(preserveOperation);
      setSubmitError(message);
      setRecentGoals((current) => updateRecentGoal(current, operation.requestId, {
        error: message,
        retryPending: preserveOperation,
      }));
    } finally {
      setSubmitting(false);
    }
  }

  const resultTone = result === null
    ? ""
    : result.action === "waiting_for_bot"
      ? "unknown"
      : result.action === "noop"
        ? "unknown"
        : result.outcome === "completed"
          ? "available"
          : "unavailable";
  const resultLabel = result?.action === "skill_result" ? result.outcome : result?.action;
  const latestGoal = recentGoals[0] ?? null;
  const latestBot = latestGoal === null
    ? null
    : bots.find((bot) => bot.botId === latestGoal.botId) ?? null;
  const latestBotTask = latestBot?.currentTask ?? null;
  const latestLiveTask = latestGoal !== null && latestBotTask?.taskId === latestGoal.taskId
    ? latestBotTask
    : null;

  return (
    <section className="goalConsole" aria-busy={submitting} data-testid="goal-console">
      <form className="goalForm" onSubmit={submitGoal}>
        <label>
          <span>执行 Bot</span>
          <select
            value={botId}
            onChange={(event) => setBotId(event.target.value)}
            disabled={loadingBots || submitting || onlineBots.length === 0}
          >
            {onlineBots.length === 0 ? (
              <option value="">{loadingBots ? "正在读取..." : "没有在线 Bot"}</option>
            ) : null}
            {onlineBots.map((bot) => (
              <option key={bot.botId} value={bot.botId}>{bot.botId}</option>
            ))}
          </select>
        </label>
        {botError ? <p className="goalInlineError" role="status">{botError}</p> : null}
        <label className="goalInput">
          <span>目标</span>
          <textarea
            value={operatorGoal}
            onChange={(event) => setOperatorGoal(event.target.value)}
            maxLength={4_096}
            rows={5}
            placeholder="例如：采集附近的木材"
            disabled={submitting}
          />
        </label>
        <div className="goalActions">
          <span>{operatorGoal.length} / 4096</span>
          <button
            type="submit"
            disabled={!botId || !operatorGoal.trim() || submitting}
          >
            {submitting ? "执行中..." : retryPending ? "重试目标" : "提交目标"}
          </button>
        </div>
      </form>

      <section className="goalResult" aria-live="polite">
        <GoalTracking
          goals={recentGoals}
          latestGoal={latestGoal}
          latestBot={latestBot}
          latestLiveTask={latestLiveTask}
          bots={bots}
        />
        <div className="panelTitle">
          <div><span>LAST RESULT</span><h3>最近结果</h3></div>
          {result ? (
            <em className={`state ${resultTone}`} data-testid="goal-result-state">
              {resultLabel}
            </em>
          ) : null}
        </div>
        {submitError ? <p className="goalError" role="alert">{submitError}</p> : null}
        {!submitError && !result ? <p className="emptyText">尚未提交目标。</p> : null}
        {result ? (
          <dl className="goalResultGrid">
            <div><dt>Bot</dt><dd>{result.botId}</dd></div>
            <div><dt>任务 ID</dt><dd>{result.taskId}</dd></div>
            <div><dt>原因码</dt><dd>{result.reasonCode}</dd></div>
            <div>
              <dt>Skill</dt>
              <dd>{result.action === "skill_result" ? `${result.skillId} ${result.skillVersion}` : "未调用"}</dd>
            </div>
            <div><dt>结果</dt><dd>{result.action === "skill_result" ? result.outcome : "noop"}</dd></div>
            <div><dt>错误码</dt><dd>{result.action === "skill_result" ? result.errorCode ?? "无" : "无"}</dd></div>
            {result.action === "skill_result" || result.action === "noop" ? (
              <>
                <div><dt>AI 排队</dt><dd>{result.ai.queueTimeMs} ms</dd></div>
                <div><dt>AI 执行</dt><dd>{result.ai.executionTimeMs} ms</dd></div>
              </>
            ) : null}
          </dl>
        ) : null}
      </section>
    </section>
  );
}

function GoalTracking({
  goals,
  latestGoal,
  latestBot,
  latestLiveTask,
  bots,
}: {
  goals: readonly RecentGoal[];
  latestGoal: RecentGoal | null;
  latestBot: PublicBotDetailV1 | null;
  latestLiveTask: CurrentTask | null;
  bots: readonly PublicBotDetailV1[];
}) {
  const latestDisplay = latestGoal === null
    ? null
    : lifecycleDisplay(latestGoal, latestLiveTask, latestBot?.currentTask ?? null);

  return (
    <section className="goalTracking" data-testid="goal-lifecycle">
      <div className="panelTitle">
        <div><span>TASK LIFECYCLE</span><h3>任务跟踪</h3></div>
        {latestDisplay ? (
          <em className={`state ${latestDisplay.tone}`} data-testid="goal-live-status">
            {latestDisplay.label}
          </em>
        ) : null}
      </div>

      {latestGoal === null || latestDisplay === null ? (
        <p className="emptyText">没有可跟踪的任务。</p>
      ) : (
        <div className="goalCurrent">
          <p className="goalCurrentText" title={latestGoal.operatorGoal}>
            {truncateGoal(latestGoal.operatorGoal)}
          </p>
          <dl className="goalTrackingGrid">
            <div><dt>Bot</dt><dd>{latestGoal.botId}</dd></div>
            <div><dt>任务 ID</dt><dd>{latestGoal.taskId}</dd></div>
            <div><dt>Bot 当前任务</dt><dd>{latestDisplay.botTask}</dd></div>
            <div><dt>生命周期</dt><dd>{latestDisplay.detail}</dd></div>
          </dl>
        </div>
      )}

      {goals.length > 0 ? (
        <>
          <div className="goalRecentHeading">最近提交</div>
          <ol className="goalRecentList" data-testid="goal-recent-list">
            {goals.map((goal) => {
              const bot = bots.find((candidate) => candidate.botId === goal.botId) ?? null;
              const botTask = bot?.currentTask ?? null;
              const liveTask = botTask?.taskId === goal.taskId ? botTask : null;
              const display = lifecycleDisplay(goal, liveTask, botTask);
              return (
                <li key={goal.taskId} data-testid="goal-recent-item" data-task-id={goal.taskId}>
                  <div className="goalRecentMain">
                    <strong title={goal.operatorGoal}>{truncateGoal(goal.operatorGoal)}</strong>
                    <small>{goal.botId} · {formatSubmittedAt(goal.submittedAt)}</small>
                    <code>{goal.taskId}</code>
                  </div>
                  <em className={`state ${display.tone}`}>{display.label}</em>
                  <span>{display.detail}</span>
                </li>
              );
            })}
          </ol>
        </>
      ) : null}
    </section>
  );
}

type LifecycleDisplay = Readonly<{
  label: string;
  tone: "available" | "unknown" | "unavailable";
  botTask: string;
  detail: string;
}>;

function lifecycleDisplay(
  goal: RecentGoal,
  liveTask: CurrentTask | null,
  botTask: CurrentTask | null,
): LifecycleDisplay {
  if (goal.result !== null) {
    const label = goal.result.action === "skill_result"
      ? goalOutcomeLabel(goal.result.outcome)
      : "未执行";
    return {
      label,
      tone: goalResultTone(goal.result.action === "waiting_for_bot" ? null : goal.result),
      botTask: liveTask === null
        ? botTask === null
          ? "当前快照无任务"
          : `${botTask.title} · ${taskStatusLabel(botTask.status)}`
        : `${liveTask.title} · ${taskStatusLabel(liveTask.status)}`,
      detail: `执行结果：${label}`,
    };
  }

  if (liveTask !== null) {
    return {
      label: taskStatusLabel(liveTask.status),
      tone: taskStatusTone(liveTask.status),
      botTask: `${liveTask.title} · ${taskStatusLabel(liveTask.status)}`,
      detail: `Bot 状态：${taskStatusLabel(liveTask.status)}`,
    };
  }

  if (goal.error !== null) {
    return {
      label: goal.retryPending ? "等待重试" : "结果未确认",
      tone: "unknown",
      botTask: botTask === null
        ? "当前快照无任务"
        : `${botTask.title} · ${taskStatusLabel(botTask.status)}`,
      detail: goal.retryPending
        ? "提交响应不确定，保留任务 ID"
        : "提交失败，执行状态未确认",
    };
  }

  return {
    label: "等待状态",
    tone: "unknown",
    botTask: botTask === null
      ? "尚未观测到该任务"
      : `${botTask.title} · ${taskStatusLabel(botTask.status)}`,
    detail: botTask === null
      ? "最近 Bot 快照未包含该任务"
      : "Bot 当前任务与此提交不同",
  };
}

function taskStatusLabel(status: CurrentTask["status"]): string {
  const labels: Record<CurrentTask["status"], string> = {
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

function taskStatusTone(status: CurrentTask["status"]): LifecycleDisplay["tone"] {
  if (status === "failed" || status === "cancelled" || status === "expired") {
    return "unavailable";
  }
  if (status === "blocked" || status === "waiting" || status === "paused") {
    return "unknown";
  }
  return "available";
}

function goalResultTone(goal: GoalDispatchResultV1 | null): LifecycleDisplay["tone"] {
  if (goal === null || goal.action === "noop") return "unknown";
  return goal.outcome === "completed" ? "available" : "unavailable";
}

function goalOutcomeLabel(
  outcome: Extract<GoalDispatchResultV1, { action: "skill_result" }>["outcome"],
): string {
  const labels: Record<
    Extract<GoalDispatchResultV1, { action: "skill_result" }>["outcome"],
    string
  > = {
    completed: "已完成",
    rejected: "已拒绝",
    failed: "失败",
    cancelled: "已取消",
    timed_out: "已超时",
  };
  return labels[outcome];
}

function truncateGoal(goal: string): string {
  const limit = 180;
  return goal.length > limit ? `${goal.slice(0, limit)}...` : goal;
}

function formatSubmittedAt(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function upsertRecentGoal(
  goals: readonly RecentGoal[],
  next: RecentGoal,
): RecentGoal[] {
  const existing = goals.find((goal) => goal.taskId === next.taskId);
  const merged = existing === undefined
    ? next
    : { ...existing, ...next, submittedAt: existing.submittedAt };
  return [merged, ...goals.filter((goal) => goal.taskId !== next.taskId)]
    .slice(0, MAX_RECENT_GOALS);
}

function updateRecentGoal(
  goals: readonly RecentGoal[],
  taskId: string,
  patch: Partial<Pick<RecentGoal, "result" | "error" | "retryPending">>,
): RecentGoal[] {
  return goals.map((goal) => goal.taskId === taskId ? { ...goal, ...patch } : goal);
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "AbortError";
}
