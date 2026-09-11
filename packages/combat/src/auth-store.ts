// ---------------------------------------------------------------------------
// AuthCredentialStore —— Bot 自管的服务器认证密码存储。
//
// 用户需求：每个 bot 对每个服务器自动生成并记住自己的密码——不需要人
// 手动配环境变量。首次进服自动注册（生成随机密码），后续自动登录（从
// 本地存储读取）。可选接 Local AI 生成可记忆密码（但安全性不如随机）。
//
// 存储：JSON 文件按 botId 命名，每条记录 {serverHost, serverPort, password}。
// 绝不进 git；绝不进 profile。
//
// 落盘保护（真实、按平台、fail-closed）：
//   - Windows：chmod 是 no-op，继承的 ACL 通常给 Users/沙箱组读权限。因此
//     必须显式收紧 ACL 并**回读校验**：目录 = 属主(仅本账户)；
//     文件 = 属主 + 继承已断开。校验不过 → 拒绝落盘（不留下可读明文）。
//   - POSIX：chmod 0600 之后回读 stat 校验，失败按错误处理（不再吞掉）。
//   - 无法收紧权限时 fail-closed，抛稳定错误码；只有显式 opt-out
//     （STUDIO_AUTH_STORE_ALLOW_UNPROTECTED=1）才降级为「大声告警后仍落盘」。
//
// 运行时凭据（不落盘）：
//   - STUDIO_BOT_AUTH_PASSWORD_<BOT_ID> 已在调用点优先于本存储（见
//     mineflayer-client.ts）——即「运行期提供密码」模式本就存在。
//   - STUDIO_AUTH_STORE_DISABLE_PERSIST=1 时本存储完全内存化：不创建目录、
//     不写文件，等价于「凭据只在运行时存在」。
//
// 存储位置优先级：
//   1. STUDIO_AUTH_STORE_DIR 环境变量（桌面启动器注入）
//   2. ~/.studio-auth/（用户目录，单机手动模式默认）
// ---------------------------------------------------------------------------

import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  lstatSync,
  mkdtempSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/** 凭据文件无法取得真实落盘保护时的稳定错误码（fail-closed，不落盘）。 */
export const AUTH_STORE_INSECURE_CODE = "AUTH_STORE_INSECURE_PERMISSIONS";

/** 关闭落盘保护的唯一显式开关（必须配大声告警；默认路径不读取）。 */
export const AUTH_STORE_ALLOW_UNPROTECTED_ENV = "STUDIO_AUTH_STORE_ALLOW_UNPROTECTED";

/** 关闭持久化（凭据仅存在于运行时内存）的显式开关。 */
export const AUTH_STORE_DISABLE_PERSIST_ENV = "STUDIO_AUTH_STORE_DISABLE_PERSIST";

export class AuthStoreSecurityError extends Error {
  readonly code = AUTH_STORE_INSECURE_CODE;
  constructor(message: string) {
    super(message);
    this.name = "AuthStoreSecurityError";
  }
}

export type StoredCredential = Readonly<{
  serverHost: string;
  serverPort: number;
  password: string;
  registeredAt: string;
  lastUsedAt: string;
}>;

type StoreFile = Readonly<{
  schemaVersion: "1.0";
  botId: string;
  credentials: readonly StoredCredential[];
}>;

/** 目录不存在时的创建权限（POSIX 有效；Windows 由 ACL 脚本接管）。 */
export const AUTH_STORE_DIR_MODE = 0o700;
/** 凭据文件权限（POSIX 有效；Windows 由 ACL 脚本接管）。 */
export const AUTH_STORE_FILE_MODE = 0o600;

/**
 * Windows ACL 收紧脚本（随包分发，绝不拼接用户输入）。
 * 用 -File 调用固定脚本 + 参数数组传路径：argv 固定，无字符串插值，
 * 满足 SECURITY.md §2「execFile + shell:false」。
 */
export function aclScriptPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "win-acl-restrict.ps1");
}

/** Windows 上用于收紧 ACL 的固定可执行文件（系统自带 powershell.exe）。 */
export function aclPowerShellPath(): string {
  const systemRoot = process.env.SystemRoot?.trim();
  const base = systemRoot && path.isAbsolute(systemRoot)
    ? systemRoot
    : process.env.windir?.trim();
  return path.join(base && path.isAbsolute(base) ? base : "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** ACL 收紧调用的可注入执行器（测试用；生产固定 execFileSync）。 */
export type AclRunner = (scriptPath: string, targets: readonly AclTarget[]) => string;

/** 一次 ACL 收紧请求：一个路径 + 它是目录还是文件。 */
export type AclTarget = Readonly<{ path: string; purpose: "directory" | "file" }>;

function defaultAclRunner(scriptPath: string, targets: readonly AclTarget[]): string {
  return execFileSync(
    aclPowerShellPath(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-TargetsBase64",
      // 目标列表以单个 base64 参数传入（见 win-acl-restrict.ps1 头部注释：
      // PowerShell 5.1 的 -File 解析会吞掉 JSON 需要的双引号）；argv 形状固定，
      // 路径绝不参与命令拼接（SECURITY.md §2）。
      encodeAclTargets(targets),
    ],
    { encoding: "utf8", timeout: 30_000, windowsHide: true, shell: false },
  );
}

/**
 * 序列化 ACL 目标（base64(UTF-8 JSON)）。
 * 路径统一转成正斜杠：JSON 里的 `\` 需要转义，而 base64 之后的载荷再经
 * argv 往返也不会被改写；正斜杠同时也是 .NET 路径 API 在 Windows 上接受的形态。
 */
export function encodeAclTargets(targets: readonly AclTarget[]): string {
  const json = JSON.stringify(
    targets.map((target) => ({ path: target.path.replace(/\\/gu, "/"), purpose: target.purpose })),
  );
  return Buffer.from(json, "utf8").toString("base64");
}

let aclRunner: AclRunner = defaultAclRunner;

/** 仅测试使用：替换/还原 ACL 执行器；传入 null 还原默认。 */
export function __setAclRunnerForTests(runner: AclRunner | null): void {
  aclRunner = runner ?? defaultAclRunner;
}

/** 诊断用：返回指定路径当前的 ACL 快照（Windows）/ 权限位（POSIX）。 */
export function describeAtRestProtection(target: string): string {
  if (process.platform !== "win32") {
    try {
      return `mode=${(lstatSync(target).mode & 0o777).toString(8)}`;
    } catch {
      return "mode=unreadable";
    }
  }
  const snapshot = readWindowsAcl(target);
  return snapshot === null ? "acl=unreadable" : JSON.stringify(snapshot);
}

let unprotectedWarningEmitted = false;

/** 显式 opt-out：只有值被显式设为 1/true/yes 才算（不把空串当同意）。 */
function allowUnprotectedRequested(): boolean {
  const raw = process.env[AUTH_STORE_ALLOW_UNPROTECTED_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function persistDisabledRequested(): boolean {
  const raw = process.env[AUTH_STORE_DISABLE_PERSIST_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function warnUnprotectedOnce(
  logger: AuthStoreLogger | undefined,
  reason: string,
): void {
  if (unprotectedWarningEmitted) return;
  unprotectedWarningEmitted = true;
  const message =
    `${AUTH_STORE_ALLOW_UNPROTECTED_ENV}=1：服务器认证密码将以未受保护的文件权限落盘。` +
    "本机其它账户/进程可能读取该明文，违反 SECURITY.md §1 与章程 OperationalSecurity 边界。" +
    "仅限一次性排障；排障后立即删除该环境变量并轮换密码。";
  logger?.warn?.("auth_store_unprotected_permissions_allowed", { code: AUTH_STORE_INSECURE_CODE, reason });
  // 告警必须真的响：logger 之外再走一次 stderr，避免「裸开关静默降级」。
  console.warn(`[auth-store] ${message}`);
}

export type AuthStoreLogger = { warn(message: string, meta?: unknown): void };

/**
 * 诊断告警出口。默认走 console.warn；运行时可注入（测试/宿主）。
 * 用模块级注入而不是构造函数第 N 个参数：本仓 TypeScript 版本在定长形参下会把
 * 第三个实参丢掉（实测编译结果只剩两个形参），模块级注入既避开该行为，也不
 * 改变 `new AuthCredentialStore(botId, dirPath)` 这个既有调用形态。
 */
let storeLogger: AuthStoreLogger | undefined;

/** 注入告警出口（返回还原函数）。 */
export function setAuthStoreLogger(logger: AuthStoreLogger | undefined): void {
  storeLogger = logger;
}

/** 显式关闭持久化（仅内存）：等价于运行期提供凭据。 */
export type AuthCredentialStoreOptions = Readonly<{
  /** 关闭持久化：等价于运行期提供凭据，不产生磁盘明文。 */
  readonly persistDisabled?: boolean | undefined;
}>;

export class AuthCredentialStore {
  private readonly botId: string;
  private readonly dir: string;
  private readonly cache = new Map<string, readonly StoredCredential[]>();
  /** 已生成但尚未确认落盘的密码（同一次运行内复用，避免重复注册换密码）。 */
  private readonly pendingGenerated = new Map<string, string>();
  readonly persistDisabled: boolean;
  private prepared = false;

  /**
   * 兼容既有调用 `new AuthCredentialStore(botId, dirPath)`；需要关闭落盘时把
   * 第二参数换成 `{ persistDisabled: true }`。
   */
  constructor(botId: string, dirPathOrOptions?: string | AuthCredentialStoreOptions) {
    this.botId = botId;
    const options: AuthCredentialStoreOptions =
      typeof dirPathOrOptions === "string" || dirPathOrOptions === undefined
        ? {}
        : dirPathOrOptions;
    this.dir =
      (typeof dirPathOrOptions === "string" ? dirPathOrOptions : undefined) ??
      process.env.STUDIO_AUTH_STORE_DIR?.trim() ??
      path.join(homedir(), ".studio-auth");
    this.persistDisabled = options.persistDisabled ?? persistDisabledRequested();
  }

  get directory(): string {
    return this.dir;
  }

  /** 是否会把凭据写入磁盘（false = 纯运行时凭据）。 */
  get persistsToDisk(): boolean {
    return !this.persistDisabled;
  }

  private filePath(): string {
    // botId 已经过校验（identifier 模式），但防御性消毒文件名。
    const sanitized = this.botId.replace(/[^A-Za-z0-9_-]/gu, "_");
    // Valid Minecraft names can be Windows devices; keep ordinary legacy paths.
    const safe = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/iu.test(sanitized)
      ? `player-${sanitized}` : sanitized;
    return path.join(this.dir, `${safe}.json`);
  }

  /**
   * 惰性准备目录：纯内存模式不碰磁盘。
   *
   * 已存在的目录也要收紧一次——否则「新建目录时收紧」在桌面启动器注入的
   * 自定义目录（STUDIO_AUTH_STORE_DIR 指向已存在目录）上等于没做，凭据文件
   * 会落进一个其它本地账户可读/可删的目录里。
   * 白名单门（Windows 上第一次 ACL 会顺带校验它归属本账户）失败即不落盘。
   * 已合规目录直接短路返回（见 win-acl-restrict.ps1 的幂等判定）。
   */
  private ensureDir(): void {
    if (this.prepared || this.persistDisabled) return;
    const existed = existsSync(this.dir);
    if (!existed) {
      mkdirSync(this.dir, { recursive: true, mode: AUTH_STORE_DIR_MODE });
    }
    try {
      if (process.platform === "win32") {
        // 目录 + 临时文件一次收紧（同一个 powershell 进程），读写路径不重复付
        // 进程启动成本。
        applyWindowsAclBatch([{ path: this.dir, purpose: "directory" }], storeLogger);
      } else {
        restrictDirectory(this.dir, storeLogger);
      }
    } catch (error) {
      if (!existed) {
        // 自己新建的目录却收不紧 → 无可信默认值，fail-closed（不写凭据）。
        throw error;
      }
      // 已存在的注入目录（桌面启动器/共享路径）无法收成「属主白名单」：
      // 不改动它，靠文件级保护扛住（失败同样 fail-closed），但必须记录。
      storeLogger?.warn?.("auth_store_directory_not_hardened", {
        code: AUTH_STORE_INSECURE_CODE,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    this.prepared = true;
  }

  private load(): readonly StoredCredential[] {
    const cached = this.cache.get(this.botId);
    if (cached) return cached;
    if (this.persistDisabled) return [];
    try {
      const raw = readFileSync(this.filePath(), "utf8");
      const parsed = JSON.parse(raw) as StoreFile;
      if (parsed.schemaVersion === "1.0" && parsed.botId === this.botId && Array.isArray(parsed.credentials)) {
        this.cache.set(this.botId, parsed.credentials);
        return [...parsed.credentials];
      }
    } catch {
      // 文件不存在或损坏 → 空存储
    }
    return [];
  }

  private save(credentials: readonly StoredCredential[]): void {
    if (this.persistDisabled) {
      // 运行期凭据：只进内存，绝不落盘。
      this.cache.set(this.botId, credentials);
      return;
    }
    this.ensureDir();
    const file: StoreFile = {
      schemaVersion: "1.0",
      botId: this.botId,
      credentials,
    };
    const payload = JSON.stringify(file, null, 2) + "\n";
    const fp = this.filePath();
    // 原子写 + 先收紧临时文件再改名：**最终位置**在任何时刻都不会以「可读路径 +
    // 宽松权限」的组合存在——目标文件只由"已收紧"的临时文件 rename 而来。
    //
    // ⚠ 已知残余窗口（Windows，未关闭）：writeFileSync 的 mode 在 Windows 上是
    // no-op，因此 scratch 里的临时文件在 ACL 收紧调用返回之前会继承父目录的 ACE
    // （本机实测含沙箱组），明文在该窗口内对继承主体可读。窗口长度 = 一次
    // powershell 调用（本机约 1–2s）；POSIX 无此窗口（创建即 0600）。彻底关闭需要
    // 把"写入 payload"也搬进 win-acl-restrict.ps1，使 收紧+写入+回读校验 成为单次
    // 调用（顺带把每次写入 3 次 spawn、约 2.5–5s 的成本降下来）。
    const parent = path.dirname(fp);
    const scratch = mkdtempSync(path.join(parent, ".studio-auth-tmp-"));
    const tmpFile = path.join(scratch, path.basename(fp));
    let restrictFailure: AuthStoreSecurityError | null = null;
    try {
      writeFileSync(tmpFile, payload, { encoding: "utf8", mode: AUTH_STORE_FILE_MODE });
      try {
        if (process.platform === "win32") {
          // scratch 目录 + 临时文件一次收紧：同一个 powershell 进程，两次 ACL
          // 之间不留「可读路径 + 宽松权限」的窗口。
          applyWindowsAclBatch(
            [
              { path: scratch, purpose: "directory" },
              { path: tmpFile, purpose: "file" },
            ],
            storeLogger,
          );
        } else {
          chmodSync(scratch, AUTH_STORE_DIR_MODE);
          restrictFile(tmpFile, storeLogger);
        }
      } catch (error) {
        restrictFailure = error instanceof AuthStoreSecurityError
          ? error
          : new AuthStoreSecurityError(String(error));
      }
      if (!restrictFailure) {
        rmSync(fp, { force: true });
        renameSync(tmpFile, fp);
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    if (restrictFailure) {
      // fail-closed：明文已被删除，缓存也不得声称这条凭据已持久化。
      throw restrictFailure;
    }
    this.cache.set(this.botId, credentials);
  }

  /** 查找指定服务器的已存密码。 */
  find(serverHost: string, serverPort: number): StoredCredential | null {
    return (
      this.load().find(
        (cred) =>
          cred.serverHost.toLowerCase() === serverHost.toLowerCase() &&
          cred.serverPort === serverPort,
      ) ?? null
    );
  }

  /**
   * 获取或生成密码：已有 → 返回（更新 lastUsedAt）；没有 → 生成随机密码。
   * 返回的密码**尚未持久化**（等注册成功后再存，避免存了没用上的垃圾）；
   * 同一进程内重复调用返回同一个密码，不会生成第二个候选。
   */
  getOrCreate(serverHost: string, serverPort: number): Readonly<{ password: string; isNew: boolean }> {
    const existing = this.find(serverHost, serverPort);
    if (existing) {
      // 只更新 lastUsedAt，不重写密码
      this.save(
        [...this.load()].map((cred) =>
          cred === existing
            ? { ...cred, lastUsedAt: new Date().toISOString() }
            : cred,
        ),
      );
      return { password: existing.password, isNew: false };
    }
    const key = credentialKey(serverHost, serverPort);
    const pending = this.pendingGenerated.get(key) ?? generatePassword();
    this.pendingGenerated.set(key, pending);
    return { password: pending, isNew: true };
  }

  /** 注册成功后持久化密码（内存模式下只留在本次运行内）。 */
  persist(serverHost: string, serverPort: number, password: string): void {
    const now = new Date().toISOString();
    const credentials: StoredCredential[] = [...this.load()].filter(
      (cred: StoredCredential) =>
        !(
          cred.serverHost.toLowerCase() === serverHost.toLowerCase() &&
          cred.serverPort === serverPort
        ),
    );
    credentials.push({
      serverHost,
      serverPort,
      password,
      registeredAt: now,
      lastUsedAt: now,
    });
    this.save(credentials);
    this.pendingGenerated.delete(credentialKey(serverHost, serverPort));
  }

  /** 删除指定服务器的凭据（密码错误时重置用）。 */
  forget(serverHost: string, serverPort: number): void {
    this.save(
      [...this.load()].filter(
        (cred) =>
          !(
            cred.serverHost.toLowerCase() === serverHost.toLowerCase() &&
            cred.serverPort === serverPort
          ),
      ),
    );
    this.pendingGenerated.delete(credentialKey(serverHost, serverPort));
  }
}

function credentialKey(serverHost: string, serverPort: number): string {
  return `${serverHost.toLowerCase()}:${serverPort}`;
}

/**
 * Windows：调用固定 PowerShell 脚本收紧并回读校验 ACL。
 * 一次调用可带多个目标（目录+文件），减少进程开销；脚本自身回读校验，
 * Node 侧再独立跑 icacls 断言无「非属主放开权限」授权。
 */
export function applyWindowsAclBatch(
  targets: readonly AclTarget[],
  logger?: AuthStoreLogger,
): void {
  if (targets.length === 0) return;
  const primary = targets[0]!;
  const script = aclScriptPath();
  if (!existsSync(script)) {
    throw insecure("Windows ACL 收紧脚本缺失", primary.path);
  }
  let stdout = "";
  try {
    stdout = aclRunner(script, targets);
  } catch (error) {
    degradeOrThrow("Windows ACL 收紧失败（powershell 调用未成功）", primary.path, logger, error);
    return;
  }
  const results: Array<{ status?: string; purpose?: string }> = [];
  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      results.push(JSON.parse(line) as { status?: string; purpose?: string });
    } catch {
      // 非 JSON 行（PowerShell 噪声）忽略；数量对不上会走下面的长度校验。
    }
  }
  if (results.length !== targets.length) {
    degradeOrThrow(`Windows ACL 校验未通过（响应行数=${results.length}/${targets.length}）`, primary.path, logger);
    return;
  }
  for (const [index, target] of targets.entries()) {
    const parsed = results[index]!;
    if (parsed.status !== "ok") {
      degradeOrThrow(`Windows ACL 校验未通过（status=${parsed.status ?? "unparsable"}）`, target.path, logger);
      return;
    }
    if (!verifyWindowsAcl(target.path)) {
      degradeOrThrow("Windows ACL 复核仍存在非属主放开权限或继承未断开", target.path, logger);
      return;
    }
  }
}

/** 目录收紧：Windows ACL，POSIX chmod；失败 fail-closed。 */
export function restrictDirectory(dir: string, logger?: AuthStoreLogger): void {
  if (process.platform === "win32") {
    applyWindowsAclBatch([{ path: dir, purpose: "directory" }], logger);
    return;
  }
  try {
    chmodSync(dir, AUTH_STORE_DIR_MODE);
  } catch (error) {
    throw insecure("目录权限收紧失败（chmod 0700）", dir, error);
  }
  if (!posixModeIsRestricted(dir)) {
    throw insecure("目录权限校验未通过（期望 0700，组/其它位非空）", dir);
  }
}

/** 文件收紧：Windows ACL，POSIX chmod；失败 fail-closed。 */
export function restrictFile(file: string, logger?: AuthStoreLogger): void {
  if (process.platform === "win32") {
    applyWindowsAclBatch([{ path: file, purpose: "file" }], logger);
    return;
  }
  try {
    chmodSync(file, AUTH_STORE_FILE_MODE);
  } catch (error) {
    throw insecure("凭据文件权限收紧失败（chmod 0600）", file, error);
  }
  if (!posixModeIsRestricted(file)) {
    throw insecure("凭据文件权限校验未通过（期望 0600，组/其它位非空）", file);
  }
}

/** 组/其它位必须为空（POSIX 侧回读校验，不信任 chmod 的返回值）。 */
function posixModeIsRestricted(target: string): boolean {
  try {
    const stat = lstatSync(target);
    return (stat.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function insecure(reason: string, target: string, cause?: unknown): AuthStoreSecurityError {
  const detail = cause instanceof Error ? `: ${cause.message}` : "";
  return new AuthStoreSecurityError(
    `${AUTH_STORE_INSECURE_CODE}: ${reason}${detail}（路径已脱敏，仅报告类型：${path.isAbsolute(target) ? "absolute" : "relative"}）`,
  );
}

/**
 * 收紧失败时的收敛点：默认 fail-closed 抛稳定错误码；只有显式 opt-out 才降级，
 * 且降级必须同时进 logger 与 stderr（绝不静默）。
 */
function degradeOrThrow(
  reason: string,
  target: string,
  logger: AuthStoreLogger | undefined,
  cause?: unknown,
): void {
  if (!allowUnprotectedRequested()) {
    throw insecure(reason, target, cause);
  }
  warnUnprotectedOnce(logger, reason);
}

/**
 * 独立复核：读取 DACL 并断言「继承已断开 + 只授权给可信托管主体」。
 *
 * 用 PowerShell 读 ACL 而不是解析 `icacls` 文本：icacls 以「空格分隔的主体名」
 * 输出，`NT AUTHORITY\SYSTEM` 这类含空格的主体名无法靠分词还原（会被切成
 * `AUTHORITY\SYSTEM` 而误判成品）；SID 形态与本地化无关，也不受代码页影响。
 * 读不出来 → 视为不可验证 → 判不合格（fail-closed）。
 */
function verifyWindowsAcl(target: string): boolean {
  const raw = readWindowsAcl(target);
  if (raw === null) return false;
  return raw.owner === raw.currentUser
    && raw.inheritanceProtected
    && raw.rules.length > 0
    && raw.rules.every((rule) => !rule.inherited && raw.allowed.includes(rule.sid));
}

type WindowsAclSnapshot = Readonly<{
  owner: string;
  inheritanceProtected: boolean;
  currentUser: string;
  rules: ReadonlyArray<{ sid: string; inherited: boolean }>;
  allowed: readonly string[];
}>;

/** 固定 argv 读取 ACL 快照（脚本调用之外唯一的 PowerShell 读数路径）。 */
function readWindowsAcl(target: string, allowedExtra: readonly string[] = []): WindowsAclSnapshot | null {
  // -EncodedCommand 固定命令文本：路径以 base64 字面量嵌入单引号字符串，既不
  // 参与 PowerShell 语法，也不受 argv/代码页影响，无需 shell（SECURITY.md §2）。
  const pathLiteral = Buffer.from(target, "utf8").toString("base64");
  const psCommand = [
    `$p=[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${pathLiteral}'))`,
    "$i=[System.Security.Principal.WindowsIdentity]::GetCurrent()",
    "$a=Get-Acl -LiteralPath $p",
    "$rules=@($a.Access|ForEach-Object{@{sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;inherited=[bool]$_.IsInherited}})",
    "$o=$a.Owner; try{$o=([System.Security.Principal.NTAccount]$o).Translate([System.Security.Principal.SecurityIdentifier]).Value}catch{}",
    "ConvertTo-Json -Compress -InputObject @{owner=$o;inheritanceProtected=[bool]$a.AreAccessRulesProtected;currentUser=$i.User.Value;rules=$rules}",
  ].join(";");
  let stdout = "";
  try {
    stdout = execFileSync(
      aclPowerShellPath(),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(psCommand, "utf16le").toString("base64")],
      { encoding: "utf8", timeout: 15_000, windowsHide: true, shell: false },
    );
  } catch {
    return null;
  }
  const line = stdout.split(/\r?\n/u).find((candidate) => candidate.trim().startsWith("{"));
  if (!line) return null;
  try {
    const parsed = JSON.parse(line) as {
      owner?: string;
      inheritanceProtected?: boolean;
      currentUser?: string;
      rules?: Array<{ sid?: string; inherited?: boolean }>;
    };
    if (!parsed.owner || !parsed.currentUser) return null;
    const rules = (parsed.rules ?? [])
      .filter((rule) => typeof rule.sid === "string")
      .map((rule) => ({ sid: rule.sid!, inherited: rule.inherited === true }));
    return {
      owner: parsed.owner,
      inheritanceProtected: parsed.inheritanceProtected === true,
      currentUser: parsed.currentUser,
      rules,
      allowed: [parsed.currentUser, SYSTEM_SID, ADMINISTRATORS_SID, ...allowedExtra],
    };
  } catch {
    return null;
  }
}

const SYSTEM_SID = "S-1-5-18";
const ADMINISTRATORS_SID = "S-1-5-32-544";

/** 供测试用：重置内部缓存（opt-out 告警）。 */
export function __resetAuthStoreCachesForTests(): void {
  unprotectedWarningEmitted = false;
}

/**
 * 生成安全随机密码：16 字符 base64（无歧义字符），够强且服务器 chat 能发。
 */
export function generatePassword(length = 16): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(length);
  let result = "";
  for (let i = 0; i < length; i += 1) {
    result += alphabet[bytes[i]! % alphabet.length];
  }
  return result;
}
