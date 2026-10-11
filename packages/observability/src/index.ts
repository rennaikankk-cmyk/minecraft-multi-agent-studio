export type LogLevel = "info" | "warn" | "error";

export type CorrelationFields = Readonly<{
  traceId: string | null;
  taskId: string | null;
  botId: string | null;
  skillId: string | null;
  modelName: string | null;
}>;

export type StructuredLogRecord = CorrelationFields &
  Readonly<{
    timestamp: string;
    level: LogLevel;
    service: string;
    instanceId: string;
    event: string;
  }> &
  Readonly<Record<string, unknown>>;

export type AppLogger = Readonly<{
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
  error(event: string, fields?: Readonly<Record<string, unknown>>): void;
}>;

export type StructuredLoggerOptions = Readonly<{
  service: string;
  instanceId: string;
  now?: () => Date;
  sink?: (record: StructuredLogRecord) => void;
  /** Phase 3 测量面（可选）：单次日志写入（sanitize+sink）耗时回调。 */
  onWriteSpan?: (durationMs: number) => void;
}>;

export const lifecycleMetricNames = [
  "bot_connection_attempts_total",
  "bot_heartbeats_total",
  "bot_disconnects_total",
  "bot_reconnects_scheduled_total",
  "bot_stop_requests_total",
  "bot_stop_results_total",
  "bot_safety_decisions_total",
  "bot_safety_actions_total",
  "bot_safety_failures_total",
  "bot_skill_results_total",
  "bot_task_state_transitions_total",
  "bot_task_success_total",
  "bot_task_abort_total",
  "bot_movement_preemptions_total",
  "bot_watchdog_recoveries_total",
  "bot_watchdog_stuck_total",
  "bot_watchdog_loops_total",
  "bot_duplicate_crafting_prevented_total",
  "bot_stale_responses_total",
  "bot_deaths_total",
  "bot_cancelled_requests_total",
  "bot_llm_requests_total",
  "bot_llm_useful_responses_total",
  "bot_llm_prompt_tokens_total",
  "bot_llm_completion_tokens_total",
  "bot_llm_queue_time_ms_total",
  "bot_llm_execution_time_ms_total",
  "bot_llm_total_latency_ms_total",
  "bot_task_completion_time_ms_total",
  "planner_deterministic_decisions_total",
  "bot_autonomous_goals_total",
  "bot_autonomous_recoveries_total",
] as const;

export type LifecycleMetricName = (typeof lifecycleMetricNames)[number];

export type MetricSample = Readonly<{
  name: LifecycleMetricName;
  value: number;
  labels: Readonly<Record<string, string>>;
}>;

export type MetricRecorder = Readonly<{
  increment(
    name: LifecycleMetricName,
    labels?: Readonly<Record<string, string>>,
    amount?: number,
  ): void;
  snapshot(): MetricSample[];
}>;

/**
 * Bounds on how much of one structured field reaches the log. The caps
 * themselves are deliberate — an unbounded array or object from a message
 * payload would let a remote peer decide log volume. What must not happen is
 * dropping the excess *silently*: a capped array is indistinguishable from a
 * complete one, so a reader counting names in it concludes the missing entries
 * were never there. That is how a truthful `availableCount: 21` ended up beside
 * a 20-name catalog array, reading as though the 21st Skill was not offered.
 *
 * So every cap below is paired with a visible marker. Incomplete observations
 * are reported as incomplete, the same discipline the Skill layer applies to a
 * partial world scan.
 */
const MAX_LOGGED_ARRAY_ITEMS = 20;
const MAX_LOGGED_OBJECT_KEYS = 32;
const MAX_LOGGED_FIELDS = 64;
const TRUNCATION_KEY = "[TRUNCATED]";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const METRIC_LABEL_PATTERN = /^[a-z][a-z0-9_]{0,31}$/u;
/**
 * Sensitive keys are matched on word tokens, not on raw substrings. Substring
 * matching redacted every key that merely *contained* a sensitive word:
 * `disposition` and `deposition` hit `position`, `maxTokens` and `tokenizer`
 * hit `token`. That silently deletes diagnostics — the coordinator's
 * `plan_items` retry logged `disposition: "[REDACTED]"`, hiding the one field
 * that says what the retry decided.
 *
 * Splitting on separators and camelCase humps keeps every true positive
 * (`position`, `botPosition`, `server_host`, `access_token`) while letting a
 * longer word that happens to embed one through. Matching stays deliberately
 * generous in the other direction: a lone `tokens` count is redacted rather
 * than risk leaking a credential, because over-redaction costs a diagnostic
 * and under-redaction costs a secret.
 */
const SENSITIVE_KEY_TOKENS = new Set([
  "authorization",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "password",
  "passwords",
  "secret",
  "secrets",
  "token",
  "tokens",
  "apikey",
  "appsecret",
  "coordinate",
  "coordinates",
  "position",
  "positions",
  "serveraddress",
  "serverhost",
  "serverip",
]);
const SENSITIVE_KEY_TOKEN_PAIRS = new Set([
  "access:token",
  "api:key",
  "app:secret",
  "private:key",
  "refresh:token",
  "server:address",
  "server:host",
  "server:ip",
]);
/**
 * 值级 secret 模式。键名不可信：同一个令牌换个键名（message/detail/reason/url/
 * body）就原样落盘，所以字符串值本身必须扫一遍。以前只有 4 条模式，且除 Bearer
 * 外都是大小写敏感的 {20,} 长体——把 ghp_、AWS AKIA、Slack xoxb、JWT 和
 * `password=hunter2` 这类自由文本 key/value 全放过去了。
 *
 * 覆盖面与 packages/skills/src/incidents.ts 的 redactSecrets 对齐（Bearer/JWT/
 * sk-pk-ghp-gho-xox/AKIA/URL userinfo/自由文本 key=value）。这里是刻意的重复，
 * 不是疏忽：observability 是零依赖的叶子包（package.json 里没有 dependencies），
 * apps/* 与 dashboard 全部依赖它；skills 是上层包（依赖 protocol/zod/asset-policy
 * 等）。反向依赖会把整条技能栈拖进日志基础设施，方向是错的，所以两处模式各自
 * 维护、必须同步修改。
 *
 * 与 incidents.ts 的两处刻意差异（只更强，不更弱）：
 *   1. 全部模式统一 g+i：`GHP_…`、`akia…` 这类大小写变体也要拦住；
 *   2. Slack token 允许连字符（xoxb-<数字>-<字母数字>）；incidents 的
 *      `[A-Za-z0-9]{16,}` 体匹配不到真实形态。
 * URL userinfo 用零宽断言只吃掉 `user:pass`，保留 scheme 和 host——脱敏不该把
 * 一条诊断用的 URL 弄成不可读的碎片。
 */
const SENSITIVE_VALUE_PATTERNS = [
  // URL userinfo：scheme://user:pass@host，密码常常直接写在 URL 里
  /(?<=:\/\/)[^\s/@:]+:[^\s/@]+(?=@)/giu,
  // 授权头（Bearer/Basic），连同 scheme 一起替换
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/giu,
  // JWT：eyJ 开头的三段 base64url
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/giu,
  // GitHub token 家族（ghp_/gho_/ghu_/ghs_/ghr_）
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/giu,
  // GitHub fine-grained PAT
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/giu,
  // sk-/pk- 前缀密钥（OpenAI、Anthropic、Stripe 等），前缀后允许连字符
  /\b(?:sk|pk)[-_][A-Za-z0-9_-]{16,}\b/giu,
  // Slack token
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/giu,
  // AWS access key id（长期 AKIA / 临时 ASIA）
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/giu,
  // 自由文本 key/value：password=xxx / token: xxx / api_key: xxx
  // 字符类排除 `[`：免得把上一条模式刚写下的 [REDACTED] 占位符再吃一遍。
  /\b(?:password|passwd|token|api[_-]?key|secret|authorization|credential)\b\s*[:=]\s*[^\s,;'}\[\]]+/giu,
];
const CORE_FIELDS = new Set([
  "timestamp",
  "level",
  "service",
  "instanceId",
  "event",
]);

export function createStructuredLogger(
  options: StructuredLoggerOptions,
): AppLogger {
  if (!IDENTIFIER_PATTERN.test(options.service)) {
    throw new TypeError("Logger service identifier is invalid.");
  }
  if (!IDENTIFIER_PATTERN.test(options.instanceId)) {
    throw new TypeError("Logger instance identifier is invalid.");
  }
  const now = options.now ?? (() => new Date());
  const sink = options.sink ?? writeConsoleRecord;

  const write = (
    level: LogLevel,
    event: string,
    fields: Readonly<Record<string, unknown>> = {},
  ) => {
    if (!IDENTIFIER_PATTERN.test(event)) {
      throw new TypeError("Logger event identifier is invalid.");
    }
    const timestamp = now();
    if (!Number.isFinite(timestamp.getTime())) {
      throw new TypeError("Logger clock returned an invalid date.");
    }
    const writeBegan = globalThis.performance?.now?.() ?? Date.now();
    const sanitized = sanitizeFields(fields);
    sink({
      timestamp: timestamp.toISOString(),
      level,
      service: options.service,
      instanceId: options.instanceId,
      event,
      traceId: correlationValue(sanitized.traceId),
      taskId: correlationValue(sanitized.taskId),
      botId: correlationValue(sanitized.botId, true),
      skillId: correlationValue(sanitized.skillId),
      modelName: correlationValue(sanitized.modelName),
      ...withoutReservedFields(sanitized),
    });
    options.onWriteSpan?.((globalThis.performance?.now?.() ?? Date.now()) - writeBegan);
  };

  return {
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}

export class InMemoryMetricRegistry implements MetricRecorder {
  private readonly values = new Map<string, MetricSample>();

  increment(
    name: LifecycleMetricName,
    labels: Readonly<Record<string, string>> = {},
    amount = 1,
  ): void {
    if (!lifecycleMetricNames.includes(name)) {
      throw new TypeError("Metric name is not registered.");
    }
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new TypeError("Metric increment must be a positive safe integer.");
    }
    const normalizedLabels: Record<string, string> = {};
    const entries = Object.entries(labels).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    if (entries.length > 8) throw new TypeError("Metric has too many labels.");
    for (const [key, value] of entries) {
      if (
        !METRIC_LABEL_PATTERN.test(key) ||
        isSensitiveKey(key) ||
        !(IDENTIFIER_PATTERN.test(value) || (key === "botId" && /^[A-Za-z0-9_]{3,16}$/u.test(value)))
      ) {
        throw new TypeError("Metric label is invalid or sensitive.");
      }
      normalizedLabels[key] = value;
    }
    const mapKey = `${name}|${JSON.stringify(normalizedLabels)}`;
    const current = this.values.get(mapKey);
    this.values.set(mapKey, {
      name,
      value: (current?.value ?? 0) + amount,
      labels: normalizedLabels,
    });
  }

  snapshot(): MetricSample[] {
    return [...this.values.values()]
      .map((sample) => ({
        name: sample.name,
        value: sample.value,
        labels: { ...sample.labels },
      }))
      .sort((left, right) =>
        `${left.name}|${JSON.stringify(left.labels)}`.localeCompare(
          `${right.name}|${JSON.stringify(right.labels)}`,
        ),
      );
  }
}

function sanitizeFields(
  fields: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const entries = Object.entries(fields);
  for (const [key, value] of entries.slice(0, MAX_LOGGED_FIELDS)) {
    if (CORE_FIELDS.has(key)) continue;
    output[key] = isSensitiveKey(key)
      ? "[REDACTED]"
      : sanitizeValue(value, 0, new WeakSet<object>());
  }
  const droppedFields = entries.length - MAX_LOGGED_FIELDS;
  if (droppedFields > 0) output[TRUNCATION_KEY] = droppedFields;
  return output;
}

function sanitizeValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    return null;
  }
  if (depth >= 4 || typeof value !== "object") return "[TRUNCATED]";
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) {
    const kept = value
      .slice(0, MAX_LOGGED_ARRAY_ITEMS)
      .map((item) => sanitizeValue(item, depth + 1, seen));
    const dropped = value.length - kept.length;
    // The marker is an extra element rather than a replacement, so the entries
    // that did fit stay readable and the reader still learns the list is short.
    return dropped > 0 ? [...kept, `[+${dropped} ${TRUNCATION_KEY}]`] : kept;
  }
  if (value instanceof Error) {
    return { name: sanitizeString(value.name) };
  }
  const record: Record<string, unknown> = {};
  const entries = Object.entries(value);
  for (const [key, item] of entries.slice(0, MAX_LOGGED_OBJECT_KEYS)) {
    record[key] = isSensitiveKey(key)
      ? "[REDACTED]"
      : sanitizeValue(item, depth + 1, seen);
  }
  const droppedKeys = entries.length - MAX_LOGGED_OBJECT_KEYS;
  if (droppedKeys > 0) record[TRUNCATION_KEY] = droppedKeys;
  return record;
}

function isSensitiveKey(key: string): boolean {
  const tokens = key
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[^A-Za-z0-9]+/u)
    .filter((token) => token.length > 0)
    .map((token) => token.toLowerCase());
  for (const [index, token] of tokens.entries()) {
    if (SENSITIVE_KEY_TOKENS.has(token)) return true;
    const next = tokens[index + 1];
    if (next !== undefined && SENSITIVE_KEY_TOKEN_PAIRS.has(`${token}:${next}`)) {
      return true;
    }
  }
  return false;
}

/**
 * 脱敏预扫上限：形状完整的敏感值（JWT 的 claims 段可远超 500 字符）必须
 * 先于最终展示截断被模式匹配到——先截断会把长密钥拦腰切断、脱离匹配
 * 形状后真实令牌材料落盘（本包的立场：漏一个 secret 的代价高于多脱敏
 * 一条诊断）。预扫上限只为兜住超长字符串的正则成本，非安全边界。
 */
const REDACTION_SCAN_LIMIT = 16_000;

function sanitizeString(value: string): string {
  const flattened = value.replace(/[\r\n\t]+/gu, " ");
  let sanitized = flattened.slice(0, REDACTION_SCAN_LIMIT);
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[REDACTED]");
  }
  return sanitized.slice(0, 500);
}

function correlationValue(value: unknown, botIdentity = false): string | null {
  return typeof value === "string" && (IDENTIFIER_PATTERN.test(value) || (botIdentity && /^[A-Za-z0-9_]{3,16}$/u.test(value)))
    ? value
    : null;
}

function withoutReservedFields(
  fields: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const output = { ...fields };
  delete output.traceId;
  delete output.taskId;
  delete output.botId;
  delete output.skillId;
  delete output.modelName;
  return output;
}

function writeConsoleRecord(record: StructuredLogRecord): void {
  const output = JSON.stringify(record);
  if (record.level === "error") console.error(output);
  else if (record.level === "warn") console.warn(output);
  else console.log(output);
}
