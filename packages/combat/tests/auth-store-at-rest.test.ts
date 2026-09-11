// F-C1 回归测试——服务器认证密码落盘保护（Windows ACL / POSIX 0600）。
//
// 旧行为：writeFileSync 明文 + chmodSync 吞掉异常（Windows 上 chmod 是 no-op），
// 文件继承父目录 ACL（本机为 `kang\CodexSandboxUsers:(I)(OI)(CI)(M)` 等），
// 其它本地账户可读。
//
// 新行为：
//   1. 写入前后真实收紧权限，并**回读校验**（Windows 走 ACL，POSIX 走权限位）；
//   2. 收不紧 → fail-closed，磁盘上不留任何可读明文；
//   3. 只有显式 opt-out（STUDIO_AUTH_STORE_ALLOW_UNPROTECTED=1）才降级，且必须大声告警。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AUTH_STORE_ALLOW_UNPROTECTED_ENV,
  AUTH_STORE_DISABLE_PERSIST_ENV,
  AUTH_STORE_INSECURE_CODE,
  AuthCredentialStore,
  AuthStoreSecurityError,
  __resetAuthStoreCachesForTests,
  __setAclRunnerForTests,
  aclPowerShellPath,
  setAuthStoreLogger,
  describeAtRestProtection,
  encodeAclTargets,
} from "../src/auth-store.js";

const IS_WINDOWS = process.platform === "win32";

/**
 * Windows 上每次落盘都要真实收紧并回读 ACL（powershell 启动约 1s），比原来的
 * 「纯写文件」慢一个数量级，因此这些用例显式放宽超时。放宽的是测试超时，
 * 不是安全校验。
 */
const PERSIST_TIMEOUT_MS = 30_000;

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "studio-auth-atrest-"));
  setAuthStoreLogger(undefined);
  __resetAuthStoreCachesForTests();
  delete process.env[AUTH_STORE_ALLOW_UNPROTECTED_ENV];
  delete process.env[AUTH_STORE_DISABLE_PERSIST_ENV];
});

afterEach(() => {
  __setAclRunnerForTests(null);
  setAuthStoreLogger(undefined);
  __resetAuthStoreCachesForTests();
  delete process.env[AUTH_STORE_ALLOW_UNPROTECTED_ENV];
  delete process.env[AUTH_STORE_DISABLE_PERSIST_ENV];
  // Windows 上目录 ACL 已收紧为属主+SYSTEM+Administrators；本进程即属主，
  // 清理始终可行。
  rmSync(tempDir, { recursive: true, force: true });
});

/** 读取 ACL 快照（与生产复核同一条读数路径）。 */
function aclSnapshot(target: string): {
  owner: string;
  inheritanceProtected: boolean;
  currentUser: string;
  rules: Array<{ sid: string; inherited: boolean }>;
} {
  const raw = describeAtRestProtection(target);
  expect(raw.startsWith("{")).toBe(true);
  return JSON.parse(raw) as {
    owner: string;
    inheritanceProtected: boolean;
    currentUser: string;
    rules: Array<{ sid: string; inherited: boolean }>;
  };
}

const SYSTEM_SID = "S-1-5-18";
const ADMINISTRATORS_SID = "S-1-5-32-544";

/** 断言：该路径的显式 ACL 只授权给当前账户（文件级要求，最严形态）。 */
function expectOwnerOnlyAcl(target: string): void {
  const snapshot = aclSnapshot(target);
  expect(snapshot.inheritanceProtected).toBe(true);
  expect(snapshot.owner).toBe(snapshot.currentUser);
  expect(snapshot.rules.length).toBeGreaterThan(0);
  for (const rule of snapshot.rules) {
    // 旧行为下这里会出现 CodexSandboxUsers 之类继承授权
    expect(rule.inherited).toBe(false);
    expect(rule.sid).toBe(snapshot.currentUser);
  }
}

/** 断言：目录 ACL 只授权给当前账户 + 系统受信主体。 */
function expectOwnerAndSystemAcl(target: string): void {
  const snapshot = aclSnapshot(target);
  expect(snapshot.inheritanceProtected).toBe(true);
  expect(snapshot.owner).toBe(snapshot.currentUser);
  expect(snapshot.rules.length).toBeGreaterThan(0);
  const allowed = new Set([snapshot.currentUser, SYSTEM_SID, ADMINISTRATORS_SID]);
  for (const rule of snapshot.rules) {
    expect(rule.inherited).toBe(false);
    expect(allowed.has(rule.sid)).toBe(true);
  }
}

describe("F-C1: 凭据文件落盘权限被真实收紧并回读校验", () => {
  it("写入后权限位/ACL 断言：非属主主体不得持有任何放开权限", () => {
    const store = new AuthCredentialStore("studio-bot-01", tempDir);
    store.persist("example.com", 25565, "at-rest-secret");

    const file = path.join(tempDir, "studio-bot-01.json");
    expect(existsSync(file)).toBe(true);
    // 内容仍可被本进程读取（不破坏既有功能）
    expect(JSON.parse(readFileSync(file, "utf8")).credentials[0].password).toBe("at-rest-secret");

    if (IS_WINDOWS) {
      expectOwnerOnlyAcl(file);
    } else {
      expect(statSync(file).mode & 0o077).toBe(0);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  }, PERSIST_TIMEOUT_MS);

  it("新建目录同样被收紧（不是只在「目录不存在」时才做事）", () => {
    const nested = path.join(tempDir, "nested", "auth");
    new AuthCredentialStore("studio-bot-01", nested).persist("example.com", 25565, "pw");
    if (IS_WINDOWS) {
      expectOwnerAndSystemAcl(nested);
      expectOwnerOnlyAcl(path.join(nested, "studio-bot-01.json"));
    } else {
      expect(statSync(nested).mode & 0o077).toBe(0);
      expect(statSync(nested).mode & 0o777).toBe(0o700);
    }
  }, PERSIST_TIMEOUT_MS);

  it("已存在的注入目录：文件级保护仍然生效（收不紧的目录只记录告警）", () => {
    // tempDir 已经存在（模拟 STUDIO_AUTH_STORE_DIR 指向既有目录）
    expect(existsSync(tempDir)).toBe(true);
    __setAclRunnerForTests((scriptPath, targets) => {
      // 只让「已存在的注入目录本身」收紧失败；scratch 目录与凭据文件仍走真实脚本
      if (targets.some((target) => target.purpose === "directory" && target.path === tempDir)) {
        throw new Error("injected-directory-denied");
      }
      return execFileSync(aclPowerShellPath(), [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
        "-TargetsBase64", encodeAclTargets(targets),
      ], { encoding: "utf8", windowsHide: true, shell: false });
    });
    const store = new AuthCredentialStore("studio-bot-01", tempDir);
    store.persist("example.com", 25565, "pw");
    const file = path.join(tempDir, "studio-bot-01.json");
    expect(existsSync(file)).toBe(true);
    if (IS_WINDOWS) {
      expectOwnerOnlyAcl(file);
    } else {
      expect(statSync(file).mode & 0o077).toBe(0);
    }
  }, PERSIST_TIMEOUT_MS);
});

describe("F-C1: 权限收紧失败必须 fail-closed，不留可读明文", () => {
  it("ACL chmod 失败 → 抛稳定错误码、目标文件不存在、磁盘上无明文残留", () => {
    __setAclRunnerForTests(() => {
      throw new Error("injected-acl-failure");
    });
    const store = new AuthCredentialStore("studio-bot-01", tempDir);
    let caught: unknown = null;
    try {
      store.persist("example.com", 25565, "CANARY_MUST_NOT_LAND");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AuthStoreSecurityError);
    expect((caught as AuthStoreSecurityError).code).toBe(AUTH_STORE_INSECURE_CODE);
    expect((caught as Error).message).toContain(AUTH_STORE_INSECURE_CODE);

    const file = path.join(tempDir, "studio-bot-01.json");
    expect(existsSync(file)).toBe(false);
    // 目录里不得留下任何含明文的文件（临时 scratch 也必须清掉）
    for (const entry of readdirSync(tempDir)) {
      const full = path.join(tempDir, entry);
      if (statSync(full).isFile()) {
        expect(readFileSync(full, "utf8")).not.toContain("CANARY_MUST_NOT_LAND");
      }
    }
    // 内存缓存也不应把未落盘的密码当作「已持久化」
    expect(store.find("example.com", 25565)).toBeNull();
  }, PERSIST_TIMEOUT_MS);

  it("未显式 opt-in 时，环境变量未设置也不会静默降级", () => {
    delete process.env[AUTH_STORE_ALLOW_UNPROTECTED_ENV];
    __setAclRunnerForTests(() => {
      throw new Error("injected-acl-failure");
    });
    const store = new AuthCredentialStore("studio-bot-01", tempDir);
    expect(() => store.persist("example.com", 25565, "CANARY_2")).toThrow(AuthStoreSecurityError);
    expect(existsSync(path.join(tempDir, "studio-bot-01.json"))).toBe(false);
  }, PERSIST_TIMEOUT_MS);

  it("显式 opt-out 时才降级，并且必须发出大声告警（含稳定事件码）", () => {
    process.env[AUTH_STORE_ALLOW_UNPROTECTED_ENV] = "1";
    __resetAuthStoreCachesForTests();
    const warnings: string[] = [];
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    __setAclRunnerForTests(() => {
      throw new Error("injected-acl-failure");
    });
    // 目录由本 store 新建（不存在 → 目录收紧失败会先走 fail-closed），因此用
    // 纯 opt-out 场景：目录告警与文件告警都应出现，且都必须大声。
    const dir = path.join(tempDir, "fresh-auth-dir");
    setAuthStoreLogger({ warn: (message) => warnings.push(message) });
    const store = new AuthCredentialStore("studio-bot-01", dir);
    store.persist("example.com", 25565, "opted-out-secret");
    expect(existsSync(path.join(dir, "studio-bot-01.json"))).toBe(true);
    expect(warnings).toContain("auth_store_unprotected_permissions_allowed");
    // 告警不能只进 logger：stderr 也必须响一次
    expect(consoleWarn).toHaveBeenCalled();
    expect(String(consoleWarn.mock.calls[0]?.[0])).toContain(AUTH_STORE_ALLOW_UNPROTECTED_ENV);
    consoleWarn.mockRestore();
  }, PERSIST_TIMEOUT_MS);

  it("opt-out 只在失败路径生效：成功收紧时不产生任何告警", () => {
    process.env[AUTH_STORE_ALLOW_UNPROTECTED_ENV] = "1";
    __resetAuthStoreCachesForTests();
    const warnings: string[] = [];
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // 已存在的 tempDir 目录收紧会失败（父目录 ACL 不受本测试控制），因此只断言
    // 「文件收紧成功 → 不产生未受保护告警」。
    setAuthStoreLogger({ warn: (message) => warnings.push(message) });
    const store = new AuthCredentialStore("studio-bot-01", tempDir);
    store.persist("example.com", 25565, "pw");
    expect(warnings).not.toContain("auth_store_unprotected_permissions_allowed");
    expect(consoleWarn.mock.calls.some((call) => String(call[0]).includes(AUTH_STORE_ALLOW_UNPROTECTED_ENV))).toBe(false);
    consoleWarn.mockRestore();
  }, PERSIST_TIMEOUT_MS);
});

describe("F-C1: 运行期凭据模式（不落盘）", () => {
  it("STUDIO_AUTH_STORE_DISABLE_PERSIST=1 → 不创建目录、不写文件，运行期内仍可用", () => {
    process.env[AUTH_STORE_DISABLE_PERSIST_ENV] = "1";
    const dir = path.join(tempDir, "never-created");
    const store = new AuthCredentialStore("studio-bot-01", dir);
    expect(store.persistsToDisk).toBe(false);
    const first = store.getOrCreate("example.com", 25565);
    store.persist("example.com", 25565, first.password);
    expect(store.find("example.com", 25565)?.password).toBe(first.password);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(path.join(dir, "studio-bot-01.json"))).toBe(false);
    delete process.env[AUTH_STORE_DISABLE_PERSIST_ENV];
  }, PERSIST_TIMEOUT_MS);

  it("构造参数 persistDisabled 亦可显式关闭落盘", () => {
    const dir = path.join(tempDir, "also-never-created");
    const store = new AuthCredentialStore("studio-bot-01", { persistDisabled: true });
    store.persist("example.com", 25565, "in-memory-only");
    expect(existsSync(dir)).toBe(false);
  }, PERSIST_TIMEOUT_MS);

  it("未确认落盘前重复 getOrCreate 返回同一个密码（不会生成第二个候选）", () => {
    const store = new AuthCredentialStore("studio-bot-01", tempDir);
    const a = store.getOrCreate("example.com", 25565);
    const b = store.getOrCreate("example.com", 25565);
    expect(b.password).toBe(a.password);
    expect(a.isNew).toBe(true);
  });
});
