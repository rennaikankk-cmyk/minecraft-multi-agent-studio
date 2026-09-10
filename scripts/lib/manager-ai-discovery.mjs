// AI 发现与选型（从 studio-local-manager.mjs 拆出；纯函数 + 有界探测）。
import { parseEnv } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { selectAdvertisedModel } from "../../packages/ai-router/dist/model-selection.js";
import { approvedDiscoveryHost, urlHost } from "./manager-net.mjs";

const DEFAULT_SPARK_HOSTS = Object.freeze([
  "192.168.100.2",
  "dgx-spark.local",
  "spark.local",
  "127.0.0.1",
]);
// Keep the historical loopback tunnels in the discovery set as well as the
// directly reachable Spark service ports. The endpoint probe still requires a
// real /v1/models or /api/tags response before any service is selected.
const DEFAULT_SPARK_PORTS = Object.freeze([
  18100,
  18102,
  8000,
  8001,
  11434,
  11435,
]);
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/u;
export async function loadLocalAIKeyFile(environment, configRoot) {
  if (environment.LOCAL_AI_API_KEY?.trim()) return environment;
  const configuredPath = environment.LOCAL_AI_API_KEY_FILE?.trim();
  if (!configuredPath) return environment;

  const keyPath = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(configRoot, configuredPath);
  let values;
  try {
    values = parseEnv(await readFile(keyPath, "utf8"));
  } catch (cause) {
    const detail = cause?.code === "ENOENT" ? "does not exist" : "could not be read";
    throw new Error(`Local AI API key file ${detail}.`);
  }
  const apiKey = (values.LOCAL_AI_API_KEY ?? values.VLLM_API_KEY ?? "").trim();
  if (!apiKey || apiKey.length > 4_096) {
    throw new Error("Local AI API key file does not contain a valid key.");
  }
  return { ...environment, LOCAL_AI_API_KEY: apiKey };
}

export async function discoverLocalAI(environment = process.env) {
  const checkedAt = new Date().toISOString();
  // AI_* 是统一新名（本地/云端/中转站），LOCAL_AI_* 为旧名兼容；AI_* 优先。
  const rawUrl = (environment.AI_BASE_URL ?? environment.LOCAL_AI_HUB_URL)?.trim() ?? "";
  const preferredModel = (environment.AI_MODEL ?? environment.LOCAL_AI_MODEL)?.trim() ?? "";
  const apiKey = (environment.AI_API_KEY ?? environment.LOCAL_AI_API_KEY)?.trim() || undefined;
  const configuredProvider = normalizedProvider(
    environment.AI_PROVIDER ?? (environment.AI_BASE_URL ? "openai-compatible" : environment.LOCAL_AI_PROVIDER),
  );
  if (rawUrl) {
    const explicit = await probeExplicitEndpoint(
      rawUrl,
      configuredProvider,
      preferredModel,
      apiKey,
      "explicit",
    );
    return explicit ?? {
      config: null,
      status: unavailableAiStatus(
        "explicit",
        configuredProvider,
        safeOrigin(rawUrl),
        preferredModel || null,
        checkedAt,
        "已配置的 Local AI 地址不可用。",
      ),
    };
  }

  if (environment.STUDIO_SPARK_AUTO_DISCOVERY?.trim() === "0") {
    return {
      config: null,
      status: {
        state: "disabled",
        source: "disabled",
        provider: null,
        baseUrl: null,
        model: null,
        models: [],
        latencyMs: null,
        lastCheckedAt: checkedAt,
        message: "Spark 自动发现已关闭。",
      },
    };
  }

  const hosts = discoveryHosts(environment.STUDIO_SPARK_HOSTS);
  const ports = discoveryPorts(environment.STUDIO_SPARK_PORTS);
  const candidates = [];
  for (const host of hosts) {
    for (const port of ports) {
      const provider = port === 11434 || port === 11435 ? "ollama" : "vllm";
      candidates.push({
        provider,
        baseUrl: `http://${urlHost(host)}:${port}`,
      });
    }
  }

  const results = await Promise.all(
    candidates.map(async (candidate) => {
      const probe = await probeAIEndpoint({ ...candidate, apiKey }, 1_200);
      return probe ? { candidate, probe } : null;
    }),
  );
  let selectionFailure = null;
  for (const result of results) {
    if (!result) continue;
    const selection = selectModel(result.probe.models, preferredModel);
    if (selection.error) {
      // 该候选模型选型失败（歧义/配置不存在）：记录首个原因并继续探测
      // 其余健康候选，不因第一个候选的选型问题短路整个发现流程。
      if (!selectionFailure) {
        selectionFailure = {
          probe: result.probe,
          reason: selection.error,
          candidate: result.candidate,
        };
      }
      continue;
    }
    const model = selection.model;
    if (!model) continue;
    return {
      config: {
        provider: result.candidate.provider,
        baseUrl: result.candidate.baseUrl,
        model,
      },
      status: {
        state: "connected",
        source: "discovered",
        provider: result.candidate.provider,
        baseUrl: result.candidate.baseUrl,
        model,
        models: result.probe.models,
        latencyMs: result.probe.latencyMs,
        lastCheckedAt: result.probe.checkedAt,
        message: "已自动发现并连接 DGX Spark 推理服务。",
      },
    };
  }

  if (selectionFailure) {
    // 所有可达候选的选型都失败：如实报告首个原因（来源是发现流程，
    // 不是 explicit 配置）。
    return {
      config: null,
      probe: selectionFailure.probe,
      reason: selectionFailure.reason,
      status: {
        state: "unavailable",
        source: "discovered",
        provider: selectionFailure.candidate.provider,
        baseUrl: selectionFailure.candidate.baseUrl,
        model: null,
        models: [],
        latencyMs: selectionFailure.probe.latencyMs ?? null,
        lastCheckedAt: new Date().toISOString(),
        message: selectionFailure.reason,
      },
    };
  }

  return {
    config: null,
    status: unavailableAiStatus(
      "discovered",
      null,
      null,
      preferredModel || null,
      checkedAt,
      "未在已批准的 Spark 主机和端口上发现推理服务。",
    ),
  };
}

/**
 * Spark is often brought up a few seconds before or after the desktop
 * launcher. Give the configured/discovered endpoint a bounded startup window
 * so a transient boot race does not permanently disable the Coordinator for
 * the whole Studio process.
 */
export async function discoverLocalAIWithRetry(
  environment = process.env,
  options = {},
) {
  const startupWaitMs = boundedDiscoveryWait(
    options.startupWaitMs ?? environment.STUDIO_SPARK_STARTUP_WAIT_MS,
    15_000,
    "STUDIO_SPARK_STARTUP_WAIT_MS",
  );
  const retryIntervalMs = boundedDiscoveryWait(
    options.retryIntervalMs,
    1_000,
    "Spark discovery retry interval",
  );
  let latest = await discoverLocalAI(environment);
  if (
    latest.config ||
    latest.status.state === "disabled" ||
    startupWaitMs === 0
  ) {
    return latest;
  }

  const deadline = Date.now() + startupWaitMs;
  while (Date.now() < deadline) {
    await delay(Math.min(retryIntervalMs, deadline - Date.now()));
    latest = await discoverLocalAI(environment);
    if (latest.config) return latest;
  }
  return latest;
}

export async function probeAIEndpoint(candidate, timeoutMs = 1_200) {
  const startedAt = Date.now();
  // OpenAI 风格 base 常以 /v1 结尾（直接拼 /v1/models 会变成 /v1/v1）；
  // GLM 开放平台则是 <base>/models。两种约定都试，第一个成功即用（尽力探测，
  // 生成链路不依赖它）。
  const ollama = candidate.provider === "ollama";
  const candidates = ollama
    ? ["/api/tags"]
    : (() => {
        const base = new URL(candidate.baseUrl);
        const stripped = base.pathname.replace(/\/+$/u, "").replace(/\/v1$/u, "");
        const first = `${base.origin}${stripped}/v1/models`;
        const second = `${base.origin}${base.pathname.replace(/\/+$/u, "")}/models`;
        return first === second ? [first] : [first, second];
      })();
  for (const endpoint of candidates) {
    const probe = await probeJsonList(
      endpoint,
      candidate.apiKey,
      ollama,
      timeoutMs,
    );
    if (probe) return probe;
  }
  return null;
}

async function probeJsonList(endpoint, apiKey, ollama, timeoutMs) {
  const startedAt = Date.now();
  try {
    const response = await fetch(endpoint, {
      headers: {
        Accept: "application/json",
        ...(apiKey?.trim()
          ? { Authorization: `Bearer ${apiKey.trim()}` }
          : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const input = await response.json();
    const models = ollama
      ? Array.isArray(input?.models)
        ? input.models.map((entry) => entry?.name)
        : []
      : Array.isArray(input?.data)
        ? input.data.map((entry) => entry?.id)
        : [];
    const validModels = [...new Set(models.filter(
      (model) => typeof model === "string" && MODEL_PATTERN.test(model),
    ))].slice(0, 64);
    if (validModels.length === 0) return null;
    return {
      models: validModels,
      latencyMs: Math.max(0, Date.now() - startedAt),
      checkedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function boundedDiscoveryWait(raw, fallback, name) {
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 120_000) {
    throw new Error(`${name} must be between 0 and 120000.`);
  }
  return value;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function discoveryHosts(raw) {
  const values = raw?.trim()
    ? raw.split(",").map((value) => value.trim()).filter(Boolean)
    : DEFAULT_SPARK_HOSTS;
  return [...new Set(values)].filter(approvedDiscoveryHost).slice(0, 16);
}

function discoveryPorts(raw) {
  const values = raw?.trim()
    ? raw.split(",").map((value) => Number(value.trim()))
    : DEFAULT_SPARK_PORTS;
  return [...new Set(values)]
    .filter((port) => Number.isSafeInteger(port) && port >= 1 && port <= 65_535)
    .slice(0, 16);
}

function normalizedProvider(value) {
  const provider = value?.trim().toLowerCase();
  if (provider === "ollama") return "ollama";
  if (provider === "openai-compatible" || provider === "openai" || provider === "cloud") return "openai-compatible";
  return "vllm";
}

// ---------------------------------------------------------------------------
// AI provider profiles：校验 / 脱敏 / .env.local 重写（纯函数，供单测直接使用）
// ---------------------------------------------------------------------------

export function selectModel(models, preferred) {
  const result = selectAdvertisedModel(models, preferred);
  if (result.error === undefined) return { model: result.model };
  return {
    error: result.error === "AI_MODEL_AMBIGUOUS" ? "MODEL_SELECTION_REQUIRED" : "MODEL_NOT_AVAILABLE",
    models: result.models,
  };
}

function safeOrigin(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "http:" &&
      url.protocol !== "https:"
    ) return null;
    if (
      !url.hostname ||
      !url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "")
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function unavailableAiStatus(source, provider, baseUrl, model, checkedAt, message) {
  return {
    state: "unavailable",
    source,
    provider,
    baseUrl,
    model,
    models: [],
    latencyMs: null,
    lastCheckedAt: checkedAt,
    message,
  };
}


async function probeExplicitEndpoint(rawUrl, provider, preferredModel, apiKey, source) {
  const baseUrl = safeOrigin(rawUrl);
  if (!baseUrl) return null;
  const probe = await probeAIEndpoint({ provider, baseUrl, apiKey }, 2_000);
  if (!probe) return null;
  const selection = selectModel(probe.models, preferredModel);
  if (selection.error) {
    return {
      config: null,
      status: {
        state: "unavailable",
        source,
        provider,
        baseUrl,
        model: null,
        models: selection.models ?? [],
        latencyMs: probe.latencyMs,
        lastCheckedAt: probe.checkedAt,
        message: selection.error,
      },
    };
  }
  const model = selection.model;
  if (!model) return null;
  return {
    config: { provider, baseUrl, model },
    status: {
      state: "connected",
      source,
      provider,
      baseUrl,
      model,
      models: probe.models,
      latencyMs: probe.latencyMs,
      lastCheckedAt: probe.checkedAt,
      message: "已连接配置的 Local AI 服务。",
    },
  };
}
