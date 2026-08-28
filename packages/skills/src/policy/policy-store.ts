import { identifierSchema } from "@minecraft-studio/protocol";

import {
  baselineServerPolicy,
  DEFAULT_UNKNOWN_SERVER_PROFILE,
  isAtLeastAsConservative,
  serverPolicySchema,
  type BaselineAntiCheatProfile,
  type ServerPolicy,
} from "./server-policy.js";

// ---------------------------------------------------------------------------
// ServerPolicyStore —— 按 serverProfileId 硬隔离的策略存放点。
//
// 三条不可绕过的规则：
//   1. **按服隔离**：查询必须带 serverProfileId，A 服的策略在 B 服查不到。
//      这与 AGENTS.md §0.1 的世界记忆隔离同源——反作弊表现同样不可跨服平移。
//   2. **未知即最保守**：没有该服记录时返回 STRICT baseline，而不是报错或
//      沿用上一个服的值。fail-closed，且明确标注 origin: "baseline"。
//   3. **只能收紧**：写入一个比现存记录更宽松的策略会被拒绝，除非显式
//      `reset`（对应"回退到最后稳定值"与人工重置两种合法路径）。
// ---------------------------------------------------------------------------

export type ServerPolicyWriteRejection = Readonly<{
  accepted: false;
  errorCode:
    | "SERVER_POLICY_PROFILE_ID_INVALID"
    | "SERVER_POLICY_INVALID"
    | "SERVER_POLICY_WOULD_RELAX";
}>;

export type ServerPolicyWriteAcceptance = Readonly<{
  accepted: true;
  stored: ServerPolicy;
}>;

export type ServerPolicyWriteResult =
  | ServerPolicyWriteAcceptance
  | ServerPolicyWriteRejection;

function frozenPolicy(policy: ServerPolicy): ServerPolicy {
  return Object.freeze({
    ...policy,
    limits: Object.freeze({ ...policy.limits }),
    evidenceIds: Object.freeze([...policy.evidenceIds]),
  }) as ServerPolicy;
}

export class ServerPolicyStore {
  private readonly policies = new Map<string, ServerPolicy>();

  constructor(
    /**
     * 未知服的兜底档。默认 STRICT；无规则服（purpose=anarchy）的运行时
     * 用 ANARCHY 构造——那里没有反作弊，STRICT 的禁疾跑/低速率只会
     * 削弱自己。显式 upsert 的实测记录仍然优先于兜底档。
     */
    private readonly fallbackProfile: BaselineAntiCheatProfile = DEFAULT_UNKNOWN_SERVER_PROFILE,
  ) {}

  /**
   * 当前生效策略。未知服返回兜底 baseline（不写入缓存——未知就是未知，
   * 不因为查过一次就变成"已知记录"）。
   */
  resolve(serverProfileId: string): ServerPolicy {
    const parsed = identifierSchema.safeParse(serverProfileId);
    if (!parsed.success) {
      // 连 ID 都不合法时不能猜，返回一个不绑定任何真实服的最保守策略。
      return frozenPolicy(
        baselineServerPolicy("unknown-server", this.fallbackProfile),
      );
    }
    const stored = this.policies.get(parsed.data);
    return (
      stored ??
      frozenPolicy(baselineServerPolicy(parsed.data, this.fallbackProfile))
    );
  }

  /** 是否已有该服的实测记录（区别于 baseline 兜底）。 */
  hasVerifiedPolicy(serverProfileId: string): boolean {
    const parsed = identifierSchema.safeParse(serverProfileId);
    if (!parsed.success) return false;
    return this.policies.get(parsed.data)?.origin === "probed";
  }

  /**
   * 写入策略。只接受"不比现存更宽松"的值；放宽必须走 `reset`（人工/回退），
   * 避免探测过程或调用方逐步把边界推上去。
   */
  upsert(candidate: unknown): ServerPolicyWriteResult {
    const parsed = serverPolicySchema.safeParse(candidate);
    if (!parsed.success) {
      return Object.freeze({
        accepted: false as const,
        errorCode: "SERVER_POLICY_INVALID" as const,
      });
    }
    const policy = parsed.data;
    if (!identifierSchema.safeParse(policy.serverProfileId).success) {
      return Object.freeze({
        accepted: false as const,
        errorCode: "SERVER_POLICY_PROFILE_ID_INVALID" as const,
      });
    }
    const existing = this.policies.get(policy.serverProfileId);
    if (existing && !isAtLeastAsConservative(policy.limits, existing.limits)) {
      return Object.freeze({
        accepted: false as const,
        errorCode: "SERVER_POLICY_WOULD_RELAX" as const,
      });
    }
    const stored = frozenPolicy(policy);
    this.policies.set(policy.serverProfileId, stored);
    return Object.freeze({ accepted: true as const, stored });
  }

  /**
   * 显式重置为给定策略（或删除记录回到 STRICT baseline）。这是唯一允许
   * "放宽"的入口，对应探测失败后回退到最后稳定值、以及 R4 人工干预。
   */
  reset(serverProfileId: string, policy?: unknown): ServerPolicyWriteResult {
    const parsedId = identifierSchema.safeParse(serverProfileId);
    if (!parsedId.success) {
      return Object.freeze({
        accepted: false as const,
        errorCode: "SERVER_POLICY_PROFILE_ID_INVALID" as const,
      });
    }
    if (policy === undefined) {
      this.policies.delete(parsedId.data);
      return Object.freeze({
        accepted: true as const,
        stored: frozenPolicy(
          baselineServerPolicy(parsedId.data, DEFAULT_UNKNOWN_SERVER_PROFILE),
        ),
      });
    }
    const parsed = serverPolicySchema.safeParse(policy);
    if (!parsed.success || parsed.data.serverProfileId !== parsedId.data) {
      return Object.freeze({
        accepted: false as const,
        errorCode: "SERVER_POLICY_INVALID" as const,
      });
    }
    const stored = frozenPolicy(parsed.data);
    this.policies.set(parsedId.data, stored);
    return Object.freeze({ accepted: true as const, stored });
  }

  /** 已记录的服务器 ID（排序，便于稳定日志与断言）。 */
  knownServerProfileIds(): readonly string[] {
    return Object.freeze([...this.policies.keys()].sort());
  }
}
