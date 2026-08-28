// ---------------------------------------------------------------------------
// ServerAuthHandler —— 服务器注册/登录自动认证（AuthMe 等）。
//
// 大量离线/破解/无政府服使用 AuthMe/xAuth 类插件：进服后必须发
//   /register <密码> <密码>   （首次）
//   /login <密码>              （后续）
// 否则无法移动/交互，几秒到几分钟后被踢。
//
// 本模块：
//   1. 监听 spawn 后的系统消息，识别注册/登录提示（中英双语常见格式）
//   2. 从环境变量读取密码（与正版认证同纪律：绝不入 profile JSON）
//   3. 首次进服自动注册，后续自动登录
//   4. 超时/失败如实上报（不假装已认证）
//
// 密码环境变量：STUDIO_BOT_AUTH_PASSWORD_<BOT_ID>（同 STUDIO_BOT_PASSWORD 模式）
// ---------------------------------------------------------------------------

/** 结构化 bot 视图（包不依赖 mineflayer）。 */
interface BotView {
  on: (event: string, listener: (...args: never[]) => void) => unknown;
  removeListener: (event: string, listener: (...args: never[]) => void) => unknown;
  chat: (message: string) => void;
}

/** 提示语关键词 → 匹配到即认为需要该类认证。 */
const REGISTER_PROMPTS = /register|\/reg\b|注册|请注册|please register/iu;
const LOGIN_PROMPTS = /login|\/l\b|登录|请登录|please log ?in/iu;
const SUCCESS_PROMPTS = /logged in|authenticated|registered successfully|已登录|注册成功|登录成功/iu;
const ALREADY_REGISTERED = /already registered|已经注册|已注册/iu;
const WRONG_PASSWORD = /wrong password|密码错误|incorrect password/iu;

export type AuthState =
  | "idle" // 尚未检测到提示
  | "awaiting-prompt" // 已连接，等待服务器提示
  | "registering" // 正在发注册命令
  | "logging-in" // 正在发登录命令
  | "authenticated" // 认证成功
  | "failed-no-password" // 环境变量里没有密码
  | "failed-timeout" // 超时未收到成功确认
  | "failed-wrong-password"; // 服务器拒绝

export type ServerAuthConfig = Readonly<{
  /** 认证密码（从环境变量解析，绝不进 profile）。 */
  password: string;
  /** 等服务器提示的超时（ms）。 */
  promptTimeoutMs: number;
  /** 命令发出后等待确认的超时（ms）。 */
  confirmTimeoutMs: number;
}>;

export const DEFAULT_AUTH_CONFIG: ServerAuthConfig = Object.freeze({
  password: "",
  promptTimeoutMs: 10_000,
  confirmTimeoutMs: 8_000,
});

/**
 * 从环境变量解析指定 bot 的服务器认证密码。
 * botId 同正版密码规则：非字母数字折下划线大写。
 */
export function serverAuthPasswordEnvVar(botId: string): string {
  return `STUDIO_BOT_AUTH_PASSWORD_${botId.replace(/[^A-Za-z0-9]/gu, "_").toUpperCase()}`;
}

export function resolveServerAuthPassword(
  botId: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return env[serverAuthPasswordEnvVar(botId)]?.trim() ?? "";
}

/**
 * 挂载自动认证：监听系统消息，识别提示并发命令。
 * 返回清理函数（断线时调用）。
 */
export function attachServerAuth(
  bot: BotView,
  config: ServerAuthConfig,
  onStateChange?: (state: AuthState, detail: string) => void,
): () => void {
  let state: AuthState = "awaiting-prompt";
  let attempted = false;
  let promptTimer: ReturnType<typeof setTimeout> | null = null;
  let confirmTimer: ReturnType<typeof setTimeout> | null = null;
  const listeners: Array<[string, (...args: unknown[]) => void]> = [];

  const setState = (next: AuthState, detail = "") => {
    state = next;
    onStateChange?.(next, detail);
  };

  const clearTimers = () => {
    if (promptTimer) clearTimeout(promptTimer);
    if (confirmTimer) clearTimeout(confirmTimer);
    promptTimer = null;
    confirmTimer = null;
  };

  const sendAuth = (register: boolean) => {
    if (attempted) return;
    attempted = true;
    if (!config.password) {
      setState("failed-no-password", "No STUDIO_BOT_AUTH_PASSWORD env var set");
      return;
    }
    const command = register
      ? `/register ${config.password} ${config.password}`
      : `/login ${config.password}`;
    setState(register ? "registering" : "logging-in", command.replace(config.password, "***"));
    bot.chat(command);
    // 等确认
    confirmTimer = setTimeout(() => {
      if (state !== "authenticated") {
        setState("failed-timeout", `No success confirmation within ${config.confirmTimeoutMs}ms`);
      }
    }, config.confirmTimeoutMs);
  };

  // AuthMe 提示走 message 事件（含系统广播）。
  const onMessage = (jsonMsg: unknown) => {
    const text =
      typeof jsonMsg === "string"
        ? jsonMsg
        : typeof (jsonMsg as { toString?: () => string })?.toString === "function"
          ? (jsonMsg as { toString: () => string }).toString()
          : "";
    if (!text || state === "authenticated") return;

    if (SUCCESS_PROMPTS.test(text)) {
      clearTimers();
      setState("authenticated", text.slice(0, 100));
      return;
    }
    if (WRONG_PASSWORD.test(text)) {
      clearTimers();
      setState("failed-wrong-password", text.slice(0, 100));
      return;
    }
    // 服务器提示注册或登录
    if (REGISTER_PROMPTS.test(text) && !ALREADY_REGISTERED.test(text)) {
      sendAuth(true);
    } else if (LOGIN_PROMPTS.test(text) || ALREADY_REGISTERED.test(text)) {
      sendAuth(false);
    }
  };

  bot.on("message", onMessage as never);
  listeners.push(["message", onMessage as never]);

  // 超时：如果 prompt 一直没来（服务器没有 auth 插件），静默回 idle。
  promptTimer = setTimeout(() => {
    if (state === "awaiting-prompt") {
      setState("idle", "No auth prompt detected (server may not require auth)");
    }
  }, config.promptTimeoutMs);

  return () => {
    clearTimers();
    for (const [event, listener] of listeners) {
      bot.removeListener(event, listener as never);
    }
  };
}

/** 消息文本是否包含注册提示（供测试直接消费）。 */
export function isRegisterPrompt(text: string): boolean {
  return REGISTER_PROMPTS.test(text) && !ALREADY_REGISTERED.test(text);
}

/** 消息文本是否包含登录提示。 */
export function isLoginPrompt(text: string): boolean {
  return LOGIN_PROMPTS.test(text) || ALREADY_REGISTERED.test(text);
}

/** 消息文本是否包含成功确认。 */
export function isSuccessPrompt(text: string): boolean {
  return SUCCESS_PROMPTS.test(text);
}
