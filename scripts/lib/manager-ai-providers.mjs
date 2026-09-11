// AI provider 档案（校验/脱敏/env 重写；从 studio-local-manager.mjs 拆出的纯函数）。
import { managedError } from "./manager-errors.mjs";

const AI_PROVIDER_TYPES = new Set(["local-vllm", "local-ollama", "openai-compatible"]);
const AI_PROFILE_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/u;
const LOOPBACK_HOST_PATTERN = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/iu;
/** 激活时由 Studio 托管的键：重写前整体清除，避免新旧两套（AI_* / LOCAL_AI_*）混用。 */
const AI_ENV_MANAGED_KEYS = new Set([
  "AI_PROVIDER", "AI_BASE_URL", "AI_MODEL", "AI_API_KEY", "AI_API_KEY_ENV",
  "AI_STRUCTURED_OUTPUT", "AI_MAX_OUTPUT_TOKENS", "AI_MAX_ATTEMPTS",
  "LOCAL_AI_PROVIDER", "LOCAL_AI_HUB_URL", "LOCAL_AI_MODEL", "LOCAL_AI_API_KEY",
]);

export function validateAiProviderProfile(input, { requireCloudKey = true } = {}) {
  if (!input || typeof input !== "object") {
    throw managedError("INVALID_REQUEST", "AI provider 档案格式无效。", 400);
  }
  const name = String(input.name ?? "").trim();
  if (name.length < 1 || name.length > 64 || /[\r\n]/u.test(name)) {
    throw managedError("INVALID_REQUEST", "AI provider 名称无效（1-64 字符，不含换行）。", 400);
  }
  const type = String(input.type ?? "").trim();
  if (!AI_PROVIDER_TYPES.has(type)) {
    throw managedError("INVALID_REQUEST", "AI provider 类型必须是 local-vllm / local-ollama / openai-compatible。", 400);
  }
  const cloud = type === "openai-compatible";
  const rawBaseUrl = String(input.baseUrl ?? "").trim();
  let url;
  try {
    url = new URL(rawBaseUrl);
  } catch {
    throw managedError("INVALID_REQUEST", "AI provider baseUrl 无效。", 400);
  }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw managedError("INVALID_REQUEST", "baseUrl 必须是显式 HTTP(S) 地址，不带凭据或查询串。", 400);
  }
  let baseUrl;
  if (cloud) {
    if (url.protocol !== "https:" && !LOOPBACK_HOST_PATTERN.test(url.hostname)) {
      throw managedError("INVALID_REQUEST", "云端/中转地址必须 HTTPS（本机回环 HTTP 仅用于受控测试）。", 400);
    }
    baseUrl = rawBaseUrl.replace(/\/+$/u, "");
  } else {
    if (!url.port) throw managedError("INVALID_REQUEST", "本地推理地址必须带显式端口。", 400);
    if (url.pathname !== "/" && url.pathname !== "") {
      throw managedError("INVALID_REQUEST", "本地推理地址不能带路径。", 400);
    }
    baseUrl = url.origin;
  }
  const model = String(input.model ?? "").trim();
  // 云端 model 可留空：激活时按 API key 自动探测 /v1/models 并按优先级
  // 选定（探测失败且未手填时激活被拒——绝不写一个假模型名进 env）。
  if (model && !AI_PROFILE_MODEL_PATTERN.test(model)) {
    throw managedError("INVALID_REQUEST", "AI provider 模型 ID 无效。", 400);
  }
  if (!cloud && model && !AI_PROFILE_MODEL_PATTERN.test(model)) {
    throw managedError("INVALID_REQUEST", "AI provider 模型 ID 无效。", 400);
  }
  const apiKey = String(input.apiKey ?? "").trim();
  if (cloud && requireCloudKey && !apiKey) {
    throw managedError("INVALID_REQUEST", "云端/中转 API 必须提供 API Key。", 400);
  }
  if (apiKey && (apiKey.length > 4_096 || /[\r\n]/u.test(apiKey))) {
    throw managedError("INVALID_REQUEST", "API Key 无效（过长或含换行）。", 400);
  }
  const structuredOutput = String(input.structuredOutput ?? "none").trim() || "none";
  if (!["none", "json_object", "json_schema", "tool"].includes(structuredOutput)) {
    throw managedError("INVALID_REQUEST", "structuredOutput 必须是 none / json_object / json_schema / tool。", 400);
  }
  if (!cloud && structuredOutput !== "none") {
    throw managedError("INVALID_REQUEST", "structuredOutput 仅适用于 openai-compatible 供应商。", 400);
  }
  const id = input.id === undefined || input.id === null || String(input.id).trim() === ""
    ? null
    : String(input.id).trim();
  if (id !== null && !/^aip-[0-9a-f]{4,32}$/u.test(id)) {
    throw managedError("INVALID_REQUEST", "AI provider 档案 ID 无效。", 400);
  }
  return {
    id,
    name,
    type,
    baseUrl,
    model: model || null,
    apiKey: apiKey || null,
    structuredOutput: cloud ? structuredOutput : "none",
  };
}

export function maskedAiProviderProfile(profile) {
  return {
    id: profile.id,
    name: profile.name,
    type: profile.type,
    baseUrl: profile.baseUrl,
    model: profile.model,
    hasApiKey: Boolean(profile.apiKey),
    structuredOutput: profile.structuredOutput ?? "none",
    createdAt: profile.createdAt ?? null,
    updatedAt: profile.updatedAt ?? null,
  };
}

export function aiProbeProvider(profileType) {
  if (profileType === "local-ollama") return "ollama";
  if (profileType === "openai-compatible") return "openai-compatible";
  return "vllm";
}

/** 保留无关行，清掉全部托管键，追加新档案的配置块（util.parseEnv 兼容的双引号转义）。 */
export function rewriteAiEnvironment(previous, profile) {
  const kept = previous.split(/\r?\n/u).filter((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/u);
    return !match || !AI_ENV_MANAGED_KEYS.has(match[1]);
  });
  while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
  const block = [
    "# --- AI provider: managed by Studio（模型与 API 页激活写入；手改会被下次激活覆盖） ---",
    ...(profile.type === "openai-compatible"
      ? [
          `AI_PROVIDER=${quoteEnvValue("openai-compatible")}`,
          `AI_BASE_URL=${quoteEnvValue(profile.baseUrl)}`,
          `AI_MODEL=${quoteEnvValue(profile.model ?? "")}`,
          ...(profile.apiKey ? [`AI_API_KEY=${quoteEnvValue(profile.apiKey)}`] : []),
          ...(profile.structuredOutput && profile.structuredOutput !== "none"
            ? [`AI_STRUCTURED_OUTPUT=${quoteEnvValue(profile.structuredOutput)}`]
            : []),
        ]
      : [
          `LOCAL_AI_PROVIDER=${quoteEnvValue(profile.type === "local-ollama" ? "ollama" : "vllm")}`,
          `LOCAL_AI_HUB_URL=${quoteEnvValue(profile.baseUrl)}`,
          ...(profile.model ? [`LOCAL_AI_MODEL=${quoteEnvValue(profile.model)}`] : []),
        ]),
  ];
  return `${[...kept, ...(kept.length > 0 ? [""] : []), ...block, ""].join("\n")}`;
}

function quoteEnvValue(value) {
  return `"${String(value).replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

/**
 * 模型选择（fail closed，禁止 fallback models[0]）：
 *  - preferred 明确配置且存在 → 使用之
 *  - preferred 配置但不存在 → MODEL_NOT_AVAILABLE（fail closed）
 *  - 未配置且恰好一个模型 → 自动使用当前模型
 *  - 未配置且多个模型 → MODEL_SELECTION_REQUIRED（要求用户选择）
 *  - 未配置且零个 → MODEL_NOT_AVAILABLE
 * 返回 { model } 或 { error: "MODEL_NOT_AVAILABLE" | "MODEL_SELECTION_REQUIRED", models }。
 */
// 纯选型规则单点权威在 ai-router（selectAdvertisedModel）；此处保留 manager
// 侧错误码别名（测试与调用方沿用 MODEL_NOT_AVAILABLE / MODEL_SELECTION_REQUIRED）。

/**
 * 探测结果 → 自动选定模型：优先级表精确匹配（数据驱动，新模型加表即可），
 * 无匹配取列表第一个。空列表返回 null（调用方拒绝激活）。
 */
const PREFERRED_MODEL_ORDER = [
  "deepseek-flash",
  "deepseek-chat",
  "deepseek-v4-pro",
  "deepseek-reasoner",
  "glm-4.7",
  "glm-4.6",
];

export function selectModelAutomatically(models) {
  const list = Array.isArray(models) ? models.filter((m) => typeof m === "string" && m.length > 0) : [];
  if (list.length === 0) return null;
  for (const preferred of PREFERRED_MODEL_ORDER) {
    if (list.includes(preferred)) return preferred;
  }
  return list[0];
}
