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

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const METRIC_LABEL_PATTERN = /^[a-z][a-z0-9_]{0,31}$/u;
const SENSITIVE_KEY_PATTERN = /(?:authorization|cookie|password|secret|token|api[_-]?key|appsecret|private[_-]?key|server(?:address|host|ip)|position|coordinates)/iu;
const SENSITIVE_VALUE_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+\/-]+=*/giu,
  /\bgho_[A-Za-z0-9]{20,}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
  /\bsk-[A-Za-z0-9]{20,}\b/gu,
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
    const sanitized = sanitizeFields(fields);
    sink({
      timestamp: timestamp.toISOString(),
      level,
      service: options.service,
      instanceId: options.instanceId,
      event,
      traceId: correlationValue(sanitized.traceId),
      taskId: correlationValue(sanitized.taskId),
      botId: correlationValue(sanitized.botId),
      skillId: correlationValue(sanitized.skillId),
      modelName: correlationValue(sanitized.modelName),
      ...withoutReservedFields(sanitized),
    });
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
        SENSITIVE_KEY_PATTERN.test(key) ||
        !IDENTIFIER_PATTERN.test(value)
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
  for (const [key, value] of Object.entries(fields).slice(0, 64)) {
    if (CORE_FIELDS.has(key)) continue;
    output[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? "[REDACTED]"
      : sanitizeValue(value, 0, new WeakSet<object>());
  }
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
    return value.slice(0, 20).map((item) => sanitizeValue(item, depth + 1, seen));
  }
  if (value instanceof Error) {
    return { name: sanitizeString(value.name) };
  }
  const record: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 32)) {
    record[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? "[REDACTED]"
      : sanitizeValue(item, depth + 1, seen);
  }
  return record;
}

function sanitizeString(value: string): string {
  let sanitized = value.replace(/[\r\n\t]+/gu, " ").slice(0, 500);
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[REDACTED]");
  }
  return sanitized;
}

function correlationValue(value: unknown): string | null {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value)
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
