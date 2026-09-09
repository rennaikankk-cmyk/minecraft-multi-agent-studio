import { createRequire } from "node:module";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

const USERNAME = /^[A-Za-z0-9_]{3,16}$/u;
const ACCOUNT_REF = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const PROFILE_ID = /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/iu;
const WORKER_OPERATION = "studio-verify-managed-game-identity-v1";

function identityError(code, message, status = 400) {
  return Object.assign(new Error(message), { managerCode: code, httpStatus: status });
}

export function managedCredentialEnvNames(accountRef) {
  if (typeof accountRef !== "string" || !ACCOUNT_REF.test(accountRef)) {
    throw identityError("INVALID_REQUEST", "正版登录需要有效的受控账号引用。");
  }
  const suffix = accountRef.replace(/[^A-Za-z0-9]/gu, "_").toUpperCase();
  return { email: `STUDIO_BOT_EMAIL_${suffix}`, password: `STUDIO_BOT_PASSWORD_${suffix}` };
}

function credentialsFor(accountRef, environment) {
  const names = managedCredentialEnvNames(accountRef);
  const email = environment[names.email]?.trim();
  const password = environment[names.password]?.trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) || !password) {
    throw identityError("AUTH_REQUIRED", "受控账号凭据未配置完整，无法验证正版游戏身份。", 401);
  }
  return { email, password };
}

function verifiedProfile(profile) {
  if (!profile || profile.error || typeof profile.name !== "string" || !USERNAME.test(profile.name) ||
      typeof profile.id !== "string" || !PROFILE_ID.test(profile.id)) {
    throw identityError("AUTH_REQUIRED", "未取得有效的 Minecraft Java 游戏档案，无法绑定 BotID。", 401);
  }
  return { username: profile.name, gameProfileId: profile.id.replaceAll("-", "").toLowerCase() };
}

/** Resolve identity before allocating runtime credentials or writing a Bot profile.
 * accountRef is only a lookup key; email, password and tokens never enter the result.
 * The optional factory is a test seam and receives only backend-controlled credentials.
 */
export async function resolveManagedGameIdentity(input, options = {}) {
  const auth = input.auth ?? "offline";
  if (auth === "offline") {
    if (typeof input.username !== "string" || !USERNAME.test(input.username)) {
      throw identityError("INVALID_REQUEST", "离线用户名需为 3–16 位字母、数字或下划线。");
    }
    return { auth, botId: input.username, username: input.username };
  }
  if (auth !== "online") throw identityError("INVALID_REQUEST", "不支持的 Minecraft 登录方式。");
  const accountRef = input.accountRef;
  const credentials = credentialsFor(accountRef, options.environment ?? process.env);
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw identityError("INVALID_REQUEST", "正版身份验证超时配置无效。");
  }
  const controller = new AbortController();
  const timeoutError = identityError("AUTH_REQUIRED", "正版身份验证超时，请检查账号配置后重试。", 401);
  let timedOut = false;
  let timer;
  try {
    const response = await Promise.race([
      (async () => {
        const flow = await (options.createAuthflow ?? createWorkerAuthflow)({ ...credentials, signal: controller.signal });
        return flow.getMinecraftJavaToken({ fetchProfile: true });
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(timeoutError);
        }, timeoutMs);
      }),
    ]);
    const profile = verifiedProfile(response?.profile);
    return { auth, botId: profile.username, ...profile, accountRef };
  } catch {
    // Upstream errors may contain passwords, tokens or account email. Never attach
    // a cause or reuse upstream text in API responses, incidents or manifests.
    if (timedOut) throw timeoutError;
    throw identityError("AUTH_REQUIRED", "正版身份验证失败，未创建 Bot；请检查受控账号及 Java 游戏所有权。", 401);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function createWorkerAuthflow({ email, password, signal }) {
  return {
    getMinecraftJavaToken: () => new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error("AUTH_ABORTED"));
      // A worker bounds upstream requests (Authflow has no abort API) and keeps
      // dependency diagnostics containing authentication data out of manager logs.
      const worker = new Worker(new URL(import.meta.url), {
        workerData: { operation: WORKER_OPERATION, email, password },
        env: { ...process.env, DEBUG: "" },
        execArgv: [],
        stdout: true,
        stderr: true,
      });
      worker.stdout.resume();
      worker.stderr.resume();
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        void worker.terminate().catch(() => undefined);
        if (error) reject(new Error("AUTH_FAILED"));
        else resolve(result);
      };
      const abort = () => finish(true);
      signal.addEventListener("abort", abort, { once: true });
      worker.once("message", (message) => finish(message?.ok !== true, { profile: message?.profile }));
      worker.once("error", () => finish(true));
      worker.once("exit", () => finish(true));
    }),
  };
}

function memoryCacheFactory() {
  // Identity verification creates no additional persistent account/token store.
  // Runtime authentication remains responsible for its existing auth cache.
  const caches = new Map();
  return ({ cacheName }) => {
    if (!caches.has(cacheName)) {
      let value = {};
      caches.set(cacheName, {
        getCached: async () => value,
        setCached: async (next) => { value = next; },
        setCachedPartial: async (next) => { value = { ...value, ...next }; },
        reset: async () => { value = {}; return value; },
      });
    }
    return caches.get(cacheName);
  };
}

if (!isMainThread && workerData?.operation === WORKER_OPERATION) {
  try {
    const require = createRequire(new URL("../../apps/bot-runtime/package.json", import.meta.url));
    const { Authflow, Titles } = process.env.STUDIO_SEA_BUNDLE === "1"
      ? createRequire(import.meta.url)("./prismarine-auth.cjs")
      : require("prismarine-auth");
    const flow = new Authflow(workerData.email, memoryCacheFactory(), {
      flow: "live", authTitle: Titles.MinecraftNintendoSwitch, deviceType: "Nintendo", password: workerData.password,
    }, () => { throw new Error("INTERACTIVE_AUTH_REQUIRED"); });
    const response = await flow.getMinecraftJavaToken({ fetchProfile: true });
    const profile = verifiedProfile(response?.profile);
    parentPort.postMessage({ ok: true, profile: { name: profile.username, id: profile.gameProfileId } });
  } catch {
    parentPort.postMessage({ ok: false });
  }
}
