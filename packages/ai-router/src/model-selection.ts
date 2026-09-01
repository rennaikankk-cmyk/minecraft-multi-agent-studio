// ---------------------------------------------------------------------------
// Local AI（Spark）模型发现与选择 —— 统一规则（fail-closed，绝不 models[0]）
//
//   显式配置且精确存在      → 使用配置模型
//   显式配置但不存在        → AI_CONFIGURED_MODEL_NOT_FOUND（fail closed）
//   无配置且恰好一个模型    → 允许自动选择（唯一合法的自动路径）
//   无配置且零个模型        → AI_MODEL_DISCOVERY_FAILED（AI unavailable）
//   无配置且多个模型        → AI_MODEL_AMBIGUOUS（fail closed）
//   节点不可达              → AI_NODE_UNREACHABLE（AI unavailable）
// ---------------------------------------------------------------------------

export type ModelSelectionErrorCode =
  | "AI_NODE_UNREACHABLE"
  | "AI_MODEL_DISCOVERY_FAILED"
  | "AI_CONFIGURED_MODEL_NOT_FOUND"
  | "AI_MODEL_AMBIGUOUS";

export class ModelSelectionError extends Error {
  constructor(
    readonly code: ModelSelectionErrorCode,
    message: string,
    readonly models: readonly string[] = [],
  ) {
    super(message);
    this.name = "ModelSelectionError";
  }
}

export type ModelSelectionResult = Readonly<{
  model: string;
  selection: "configured" | "single-auto";
  discoveredModels: readonly string[];
  source: "explicit-match" | "only-model";
}>;

export interface DiscoverModelsOptions {
  readonly baseUrl: string;
  readonly apiKey?: string | null;
  readonly timeoutMs?: number;
  readonly fetchImplementation?: typeof fetch;
}

/** 发现 /v1/models 返回的模型 id 列表（bounded；失败抛 ModelSelectionError）。 */
export async function discoverModels(options: DiscoverModelsOptions): Promise<readonly string[]> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const doFetch = options.fetchImplementation ?? fetch;
  let response: Response;
  try {
    response = await doFetch(`${options.baseUrl}/v1/models`, {
      headers: {
        Accept: "application/json",
        ...(options.apiKey?.trim() ? { Authorization: `Bearer ${options.apiKey.trim()}` } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    throw new ModelSelectionError(
      "AI_NODE_UNREACHABLE",
      `Local AI hub unreachable at ${options.baseUrl}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (!response.ok) {
    throw new ModelSelectionError(
      "AI_NODE_UNREACHABLE",
      `Local AI hub /v1/models returned HTTP ${response.status}`,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ModelSelectionError(
      "AI_MODEL_DISCOVERY_FAILED",
      "Local AI hub /v1/models returned invalid JSON.",
    );
  }
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) {
    throw new ModelSelectionError(
      "AI_MODEL_DISCOVERY_FAILED",
      "Local AI hub /v1/models response is missing the data array.",
    );
  }
  const models = data
    .map((entry) => (entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string"
      ? (entry as { id: string }).id
      : null))
    .filter((id): id is string => id !== null && id.length > 0)
    .slice(0, 64);
  return models;
}

/**
 * 按统一规则选择模型。刻意不做任何"取第一个"的静默回退：
 * 多模型歧义必须 fail closed，由操作员显式配置 LOCAL_AI_MODEL。
 */
export async function resolveModel(
  options: DiscoverModelsOptions & { configuredModel?: string | null },
): Promise<ModelSelectionResult> {
  const models = await discoverModels(options);
  const configured = options.configuredModel?.trim() ?? "";
  if (configured) {
    if (!models.includes(configured)) {
      throw new ModelSelectionError(
        "AI_CONFIGURED_MODEL_NOT_FOUND",
        `Configured model '${configured}' is not advertised by ${options.baseUrl}. Advertised: ${models.slice(0, 8).join(", ")}${models.length > 8 ? "…" : ""}`,
        models,
      );
    }
    return { model: configured, selection: "configured", discoveredModels: models, source: "explicit-match" };
  }
  if (models.length === 0) {
    throw new ModelSelectionError(
      "AI_MODEL_DISCOVERY_FAILED",
      `Local AI hub ${options.baseUrl} advertises zero models.`,
      models,
    );
  }
  if (models.length > 1) {
    throw new ModelSelectionError(
      "AI_MODEL_AMBIGUOUS",
      `Local AI hub ${options.baseUrl} advertises ${models.length} models and no explicit LOCAL_AI_MODEL is configured; refusing to pick silently. Advertised: ${models.slice(0, 8).join(", ")}${models.length > 8 ? "…" : ""}`,
      models,
    );
  }
  return { model: models[0]!, selection: "single-auto", discoveredModels: models, source: "only-model" };
}
