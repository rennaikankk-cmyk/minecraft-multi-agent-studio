"use client";

import {
  dashboardApiErrorV1Schema,
  dashboardBotListResponseV1Schema,
  dashboardGoalResponseV1Schema,
  type DashboardApiErrorCode,
  type GoalDispatchResultV1,
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
  const [result, setResult] = useState<GoalDispatchResultV1 | null>(null);
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
      : { requestId: crypto.randomUUID(), botId, operatorGoal: trimmedGoal };
    pendingGoal.current = operation;
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
    } catch (cause) {
      if (!preserveOperation) pendingGoal.current = null;
      setRetryPending(preserveOperation);
      setSubmitError(cause instanceof Error ? cause.message : "目标提交失败。");
    } finally {
      setSubmitting(false);
    }
  }

  const resultTone = result === null
    ? ""
    : result.action === "noop"
      ? "unknown"
      : result.outcome === "completed"
        ? "available"
        : "unavailable";
  const resultLabel = result?.action === "skill_result" ? result.outcome : result?.action;

  return (
    <section className="goalConsole" aria-busy={submitting} data-testid="goal-console">
      <form className="goalForm" onSubmit={submitGoal}>
        <label>
          <span>目标 Bot</span>
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
            <div><dt>AI 排队</dt><dd>{result.ai.queueTimeMs} ms</dd></div>
            <div><dt>AI 执行</dt><dd>{result.ai.executionTimeMs} ms</dd></div>
          </dl>
        ) : null}
      </section>
    </section>
  );
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "AbortError";
}
