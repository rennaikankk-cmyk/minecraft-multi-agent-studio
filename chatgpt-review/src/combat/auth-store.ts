// ---------------------------------------------------------------------------
// AuthCredentialStore —— Bot 自管的服务器认证密码存储。
//
// 用户需求：每个 bot 对每个服务器自动生成并记住自己的密码——不需要人
// 手动配环境变量。首次进服自动注册（生成随机密码），后续自动登录（从
// 本地存储读取）。可选接 Local AI 生成可记忆密码（但安全性不如随机）。
//
// 存储：JSON 文件按 botId 命名，每条记录 {serverHost, serverPort, password}。
// 文件权限收紧（0600）；绝不进 git；绝不进 profile。
//
// 存储位置优先级：
//   1. STUDIO_AUTH_STORE_DIR 环境变量（桌面启动器注入）
//   2. ~/.studio-auth/（用户目录，单机手动模式默认）
// ---------------------------------------------------------------------------

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

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

export class AuthCredentialStore {
  private readonly dir: string;
  private readonly cache = new Map<string, readonly StoredCredential[]>();

  constructor(
    private readonly botId: string,
    dirPath?: string,
  ) {
    const base = dirPath ?? process.env.STUDIO_AUTH_STORE_DIR?.trim() ?? path.join(homedir(), ".studio-auth");
    this.dir = base;
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  private filePath(): string {
    // botId 已经过校验（identifier 模式），但防御性消毒文件名。
    const safe = this.botId.replace(/[^A-Za-z0-9_-]/gu, "_");
    return path.join(this.dir, `${safe}.json`);
  }

  private load(): readonly StoredCredential[] {
    const cached = this.cache.get(this.botId);
    if (cached) return cached;
    try {
      const raw = readFileSync(this.filePath(), "utf8");
      const parsed = JSON.parse(raw) as StoreFile;
      if (parsed.schemaVersion === "1.0" && Array.isArray(parsed.credentials)) {
        this.cache.set(this.botId, parsed.credentials);
        return [...parsed.credentials];
      }
    } catch {
      // 文件不存在或损坏 → 空存储
    }
    return [];
  }

  private save(credentials: readonly StoredCredential[]): void {
    this.cache.set(this.botId, credentials);
    const file: StoreFile = {
      schemaVersion: "1.0",
      botId: this.botId,
      credentials,
    };
    const fp = this.filePath();
    writeFileSync(fp, JSON.stringify(file, null, 2) + "\n", "utf8");
    try {
      chmodSync(fp, 0o600); // 凭据文件收紧权限
    } catch {
      // Windows 上 chmod 是 no-op，不报错
    }
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
   * 返回的密码**尚未持久化**（等注册成功后再存，避免存了没用上的垃圾）。
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
    return { password: generatePassword(), isNew: true };
  }

  /** 注册成功后持久化密码。 */
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
  }
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
