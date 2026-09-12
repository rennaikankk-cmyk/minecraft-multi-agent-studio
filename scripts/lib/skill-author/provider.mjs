// ---------------------------------------------------------------------------
// Skill Author 的模型接入。
//
// 纪律：
//   1. **复用既有 AI provider 通道**，不新开密钥路径。档案来自 Studio Manager 写下的
//      <runtimeRoot>/ai-providers.json（激活时同一份档案也会注入 AI_* 环境变量），
//      密钥只在该文件里，本模块只读取、只作为 Authorization 头使用，**任何日志、
//      错误信息与返回值都不得包含密钥**。
//   2. 端点构造与 packages/ai-router 的 compatibleChatEndpoint 同一套规则
//      （强制 HTTPS，HTTP 仅限回环夹具；不接受内嵌凭据或 query；自动补
//      /chat/completions 与 /v1 前缀）。这里是刻意的重复实现：本脚本是 .mjs，
//      不引入 TS 包的构建产物依赖；两处规则必须同步修改。
// ---------------------------------------------------------------------------

import { readFile } from "node:fs/promises";
import path from "node:path";

/** 云端 OpenAI 兼容档案 + API key 才可用于自动改代码。 */
export const REQUIRED_PROFILE_TYPE = "openai-compatible";

export class SkillAuthorProviderError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "SkillAuthorProviderError";
    this.code = code;
  }
}

function isLoopbackHostname(hostname) {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  return host === "::1" || host === "localhost" || host.startsWith("127.");
}

/**
 * 与 packages/ai-router/src/adapters/openai-compatible-adapter.ts 的
 * compatibleChatEndpoint 同规则。返回完整 URL 字符串。
 */
export function compatibleChatEndpoint(baseUrl) {
  let url;
  try {
    url = new URL(String(baseUrl));
  } catch {
    throw new SkillAuthorProviderError("AI_CONFIG_INVALID", "provider baseUrl is not a valid URL");
  }
  const httpsOk = url.protocol === "https:";
  const loopbackHttp = url.protocol === "http:" && isLoopbackHostname(url.hostname);
  if (!httpsOk && !loopbackHttp) {
    throw new SkillAuthorProviderError(
      "AI_CONFIG_INVALID",
      "cloud endpoint requires HTTPS (HTTP is allowed only for a loopback fixture)",
    );
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new SkillAuthorProviderError("AI_CONFIG_INVALID", "cloud endpoint must not embed credentials");
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new SkillAuthorProviderError("AI_CONFIG_INVALID", "cloud endpoint must not carry query or fragment");
  }
  const prefix = url.pathname.replace(/\/+$/u, "");
  url.pathname = prefix.endsWith("/chat/completions") ? prefix : `${prefix || "/v1"}/chat/completions`;
  return url.toString();
}

/**
 * 读取当前激活的 AI 档案。返回 `{ profileId, name, type, baseUrl, model, apiKey }`。
 * 缺失/未激活/类型不符/无密钥一律抛错（fail-closed），不做任何静默回退。
 */
export async function loadActiveAiProfile(runtimeRoot) {
  const file = path.join(runtimeRoot, "ai-providers.json");
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new SkillAuthorProviderError("AI_PROVIDER_NOT_CONFIGURED", `no AI provider store at ${file}`);
  }
  let store;
  try {
    store = JSON.parse(raw);
  } catch {
    throw new SkillAuthorProviderError("AI_PROVIDER_STORE_INVALID", "ai-providers.json is not valid JSON");
  }
  const activeId = store?.activeProfileId;
  if (typeof activeId !== "string" || activeId.length === 0) {
    throw new SkillAuthorProviderError("AI_PROVIDER_NOT_ACTIVATED", "no active AI provider profile");
  }
  const profile = Array.isArray(store.profiles)
    ? store.profiles.find((entry) => entry?.id === activeId)
    : undefined;
  if (profile === undefined) {
    throw new SkillAuthorProviderError("AI_PROVIDER_NOT_FOUND", "active profile id is not in the store");
  }
  if (profile.type !== REQUIRED_PROFILE_TYPE) {
    throw new SkillAuthorProviderError(
      "AI_PROVIDER_TYPE_UNSUPPORTED",
      `skill authoring needs a ${REQUIRED_PROFILE_TYPE} (cloud) profile; active profile is ${String(profile.type)}`,
    );
  }
  const apiKey = typeof profile.apiKey === "string" && profile.apiKey.length > 0 ? profile.apiKey : null;
  if (apiKey === null) {
    throw new SkillAuthorProviderError("AI_PROVIDER_KEY_MISSING", "active profile has no API key");
  }
  return {
    profileId: activeId,
    name: typeof profile.name === "string" ? profile.name : activeId,
    type: profile.type,
    baseUrl: String(profile.baseUrl ?? ""),
    model: typeof profile.model === "string" ? profile.model.trim() : "",
    apiKey,
  };
}

/** 模型留空时按既有优先级自动选定（与 dashboard 的提示一致）。 */
export const MODEL_PREFERENCE = Object.freeze(["deepseek-flash", "deepseek-chat", "deepseek-reasoner"]);

export function selectModel(models, configured) {
  const list = Array.isArray(models) ? models.filter((item) => typeof item === "string") : [];
  const preferred = typeof configured === "string" ? configured.trim() : "";
  if (preferred.length > 0) {
    if (!list.includes(preferred)) {
      throw new SkillAuthorProviderError("MODEL_NOT_AVAILABLE", `configured model ${preferred} is not offered`);
    }
    return preferred;
  }
  for (const candidate of MODEL_PREFERENCE) {
    if (list.includes(candidate)) return candidate;
  }
  if (list.length === 1) return list[0];
  throw new SkillAuthorProviderError(
    list.length === 0 ? "MODEL_NOT_AVAILABLE" : "MODEL_SELECTION_REQUIRED",
    "could not pick a model automatically; set it on the Models page",
  );
}

/** 探测 /v1/models（失败抛错，不吞）。 */
export async function probeModels({ profile, fetchImpl = fetch }) {
  const endpoint = compatibleChatEndpoint(profile.baseUrl).replace(/\/chat\/completions$/u, "/models");
  const response = await fetchImpl(endpoint, {
    method: "GET",
    headers: { Authorization: `Bearer ${profile.apiKey}`, Accept: "application/json" },
  });
  if (!response.ok) {
    throw new SkillAuthorProviderError("MODEL_PROBE_FAILED", `GET /models returned ${response.status}`);
  }
  const body = await response.json().catch(() => null);
  const models = Array.isArray(body?.data) ? body.data.map((item) => item?.id) : [];
  return models.filter((item) => typeof item === "string");
}

/**
 * 调用 chat/completions，返回助手文本。
 * 注意：抛出的错误只含状态码与稳定码，**不含响应体**（响应体可能回显请求头内容）。
 */
export async function callChatCompletions({ profile, model, messages, fetchImpl = fetch, timeoutMs = 300_000 }) {
  const endpoint = compatibleChatEndpoint(profile.baseUrl);
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${profile.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ model, messages, temperature: 0.2, stream: false }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new SkillAuthorProviderError("COMPLETION_FAILED", `chat/completions returned ${response.status}`);
  }
  const body = await response.json().catch(() => null);
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new SkillAuthorProviderError("COMPLETION_EMPTY", "chat/completions returned no usable content");
  }
  return content;
}

/** 解析 profile 的模型：留空则探测后按优先级选定。 */
export async function resolveModel({ profile, fetchImpl = fetch, logger }) {
  if (profile.model.length > 0) return profile.model;
  const models = await probeModels({ profile, fetchImpl });
  const chosen = selectModel(models, "");
  logger?.info?.("skill_author_model_selected", { model: chosen, candidates: models.length });
  return chosen;
}
