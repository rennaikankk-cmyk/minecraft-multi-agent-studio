import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import {
  baselineLimits,
  serverPolicyLimitsSchema,
  serverPolicySchema,
  type ServerPolicy,
  type ServerPolicyLimits,
} from "./server-policy.js";

// ---------------------------------------------------------------------------
// ServerPolicyDetector —— 有上限、可随时停止的边界探测。
//
// 这个模块**自己不发包、不碰网络**：它是一台确定性状态机，只负责"下一步该
// 试哪个值"和"收到观测后边界怎么收敛"。真正的动作由反射层通过 capability
// 适配器执行，观测结果回灌进来。因此它可以完全离线单测，也不可能偷偷探测。
//
// 四条硬约束，逐条落在代码结构上而不是注释里：
//   1. **只对隔离测试服**：授权对象必须自证 loopback + isolated-test + 人工
//      确认，且只对一个 serverProfileId 生效。第三方服连不进这道门。
//   2. **有上限**：每个维度的阶梯终点是 NORMAL 基线（reach 再被 Schema 钉在
//      原版值内），所以探测**永远不可能**产出比内置最宽档更宽的边界。
//   3. **可停止**：阶梯是预先算好的有限队列，operator 可随时 stop()。
//   4. **异常即停**：任何 correction/warning/kick/disconnect/异常都立刻终止
//      整个会话并回退——不是"跳过这个维度继续试下一个"。kick/disconnect 更
//      进一步：连之前已确认的放宽也一并丢弃（见 outcome()）。
// ---------------------------------------------------------------------------

/** 可探测的维度。布尔项（sprint/jump/strafe）不在此列：它们不是连续边界，
 *  只能由人工按服确认，自动阶梯没有意义。 */
export const probeDimensions = [
  "blockInteractionReach",
  "entityAttackReach",
  "maxYawDeltaPerTick",
  "maxPitchDeltaPerTick",
  "maxAttacksPerSecond",
  "maxPlacementsPerSecond",
  "maxDigStartsPerSecond",
  "maxHotbarSwitchesPerSecond",
  "minActionIntervalMs",
] as const;

export type ProbeDimension = (typeof probeDimensions)[number];

/** 每维度探几级；总步数还有 MAX_PROBE_STEPS 兜底。 */
export const PROBE_STEPS_PER_DIMENSION = 4;
export const MAX_PROBE_STEPS = 64;

/** 探测的外界上限：内置最宽档。越过这条线的值一律不进阶梯。 */
const OUTER_BOUND: ServerPolicyLimits = baselineLimits("NORMAL");

/** 该维度"更宽松"是往小走的字段（间隔越短越激进）。 */
const WIDENS_DOWNWARD: ReadonlySet<ProbeDimension> = new Set<ProbeDimension>([
  "minActionIntervalMs",
]);

/** reach 用 0.1 格精度，其余用整数——避免产出 8.333333 这种无法复现的值。 */
const DECIMALS: Readonly<Record<ProbeDimension, 0 | 1>> = Object.freeze({
  blockInteractionReach: 1,
  entityAttackReach: 1,
  maxYawDeltaPerTick: 0,
  maxPitchDeltaPerTick: 0,
  maxAttacksPerSecond: 0,
  maxPlacementsPerSecond: 0,
  maxDigStartsPerSecond: 0,
  maxHotbarSwitchesPerSecond: 0,
  minActionIntervalMs: 0,
});

function roundTo(value: number, decimals: 0 | 1): number {
  const factor = decimals === 1 ? 10 : 1;
  return Math.round(value * factor) / factor;
}

/**
 * 生成某维度从当前稳定值走到外界上限的有限阶梯。已经贴住上限时返回空数组
 * （没有可探测空间，不该白跑一步）。
 */
export function candidateLadder(
  dimension: ProbeDimension,
  stableValue: number,
): readonly number[] {
  const bound = OUTER_BOUND[dimension];
  const down = WIDENS_DOWNWARD.has(dimension);
  if (!Number.isFinite(stableValue)) return Object.freeze([]);
  if (down ? stableValue <= bound : stableValue >= bound) {
    return Object.freeze([]);
  }
  const span = bound - stableValue;
  const rungs: number[] = [];
  for (let step = 1; step <= PROBE_STEPS_PER_DIMENSION; step += 1) {
    const raw = stableValue + (span * step) / PROBE_STEPS_PER_DIMENSION;
    const rounded = roundTo(raw, DECIMALS[dimension]);
    // 四舍五入不得把候选值推过上限。
    const clamped = down ? Math.max(rounded, bound) : Math.min(rounded, bound);
    if (clamped === stableValue) continue;
    if (rungs.at(-1) === clamped) continue;
    rungs.push(clamped);
  }
  return Object.freeze(rungs);
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "::1",
  "localhost",
]);

/**
 * 探测授权。字段刻意与 configs/servers/isolated-test.example.json 对齐：
 * 想探测就得先有一份自证"回环 + 隔离测试用途 + 人工已确认"的目标描述。
 */
export const probeAuthorizationSchema = z
  .object({
    serverProfileId: identifierSchema,
    host: z.string().min(1).max(255),
    networkScope: z.string().min(1).max(32),
    purpose: z.string().min(1).max(64),
    operatorAcknowledged: z.boolean(),
  })
  .strict();

export type ProbeAuthorization = z.infer<typeof probeAuthorizationSchema>;

function isIsolatedTarget(auth: ProbeAuthorization): boolean {
  return (
    auth.networkScope === "loopback" &&
    auth.purpose === "isolated-test" &&
    LOOPBACK_HOSTS.has(auth.host) &&
    auth.operatorAcknowledged
  );
}

export const probeObservationKinds = [
  /** 服务器接受了这个值，没有任何纠正或告警。 */
  "accepted",
  /** 位置/朝向被服务端纠正（teleport correction 等）。 */
  "correction",
  /** 反作弊告警但未断开。 */
  "warning",
  "kick",
  "disconnect",
  /** 其它异常：超时、异常回包、状态不一致。 */
  "anomaly",
] as const;

export type ProbeObservationKind = (typeof probeObservationKinds)[number];

export const probeEvidenceSchema = z
  .object({
    evidenceId: identifierSchema,
    serverProfileId: identifierSchema,
    dimension: z.enum(probeDimensions),
    /** 本次实际尝试的值。 */
    candidateValue: z.number().finite(),
    /** 尝试之前该维度的稳定值——回退目标，必须一并留档。 */
    stableValue: z.number().finite(),
    observation: z.enum(probeObservationKinds),
    observedAtMs: z.number().int().min(0),
    note: z.string().max(200).default(""),
  })
  .strict();

export type ProbeEvidence = z.infer<typeof probeEvidenceSchema>;

export type ProbeSessionState =
  /** 已授权、有剩余阶梯，可以 nextStep()。 */
  | "running"
  /** 阶梯跑完，正常收敛结束。 */
  | "completed"
  /** 因异常观测提前终止。 */
  | "halted"
  /** operator 主动停止。 */
  | "stopped";

export type ProbeHaltReason =
  | "correction"
  | "warning"
  | "kick"
  | "disconnect"
  | "anomaly"
  | "operator-stop"
  | "step-budget-exhausted";

export type ProbeStep = Readonly<{
  dimension: ProbeDimension;
  candidateValue: number;
  stableValue: number;
  /** 第几步（1 起），便于日志对齐证据。 */
  stepIndex: number;
}>;

export type ProbeStartResult =
  | Readonly<{ started: true; session: ServerPolicyProbeSession }>
  | Readonly<{
      started: false;
      errorCode:
        | "PROBE_TARGET_NOT_ISOLATED"
        | "PROBE_AUTHORIZATION_INVALID"
        | "PROBE_ALREADY_RUNNING";
    }>;

export type ProbeSubmitResult =
  | Readonly<{ accepted: true; state: ProbeSessionState }>
  | Readonly<{
      accepted: false;
      errorCode:
        | "PROBE_NOT_RUNNING"
        | "PROBE_OBSERVATION_MISMATCH"
        | "PROBE_EVIDENCE_INVALID";
    }>;

/**
 * "必须立刻停"的观测。用类型守卫而非 boolean，让编译器确认这一类观测确实都
 * 是合法的 ProbeHaltReason——新增观测种类时忘了配套 halt 原因会直接编译失败。
 */
type HaltingObservation = Exclude<ProbeObservationKind, "accepted">;

function isHaltingObservation(
  kind: ProbeObservationKind,
): kind is HaltingObservation {
  return kind !== "accepted";
}

/** kick/disconnect 说明我们已经踩到线，连之前确认过的放宽都不再可信。 */
function discardsConfirmedWidening(kind: ProbeObservationKind): boolean {
  return kind === "kick" || kind === "disconnect";
}

/**
 * 一次探测会话。**不发包**：调用方 nextStep() 拿到该试的值，自己去执行，
 * 再把观测 submit() 回来。任何非 accepted 观测都会立刻终止整个会话。
 */
export class ServerPolicyProbeSession {
  private state: ProbeSessionState = "running";
  private haltReason: ProbeHaltReason | null = null;
  private readonly queue: ProbeStep[];
  private cursor = 0;
  private pending: ProbeStep | null = null;
  private stepsIssued = 0;
  /** 已被该服接受的放宽（维度 → 值）。kick/disconnect 时整份丢弃。 */
  private readonly confirmed = new Map<ProbeDimension, number>();
  private readonly collected: ProbeEvidence[] = [];

  constructor(
    readonly serverProfileId: string,
    /** 会话开始时的稳定边界，也是任何失败情况下的回退目标。 */
    private readonly stableLimits: ServerPolicyLimits,
    dimensions: readonly ProbeDimension[] = probeDimensions,
  ) {
    const queue: ProbeStep[] = [];
    for (const dimension of dimensions) {
      for (const candidateValue of candidateLadder(
        dimension,
        stableLimits[dimension],
      )) {
        if (queue.length >= MAX_PROBE_STEPS) break;
        queue.push(
          Object.freeze({
            dimension,
            candidateValue,
            stableValue: stableLimits[dimension],
            stepIndex: queue.length + 1,
          }),
        );
      }
    }
    this.queue = queue;
    if (queue.length === 0) this.state = "completed";
  }

  get totalSteps(): number {
    return this.queue.length;
  }

  get sessionState(): ProbeSessionState {
    return this.state;
  }

  get haltedBecause(): ProbeHaltReason | null {
    return this.haltReason;
  }

  get evidence(): readonly ProbeEvidence[] {
    return Object.freeze([...this.collected]);
  }

  /** 下一个待试的值；会话已结束或上一步还没回报观测时返回 null。 */
  nextStep(): ProbeStep | null {
    if (this.state !== "running") return null;
    if (this.pending !== null) return this.pending;
    if (this.stepsIssued >= MAX_PROBE_STEPS) {
      this.state = "halted";
      this.haltReason = "step-budget-exhausted";
      return null;
    }
    const step = this.queue[this.cursor];
    if (step === undefined) {
      this.state = "completed";
      return null;
    }
    this.cursor += 1;
    this.stepsIssued += 1;
    this.pending = step;
    return step;
  }

  /** operator 主动停止。已确认的放宽保留（它们各自都被接受过）。 */
  stop(): void {
    if (this.state !== "running") return;
    this.state = "stopped";
    this.haltReason = "operator-stop";
    this.pending = null;
  }

  /**
   * 回报上一步的观测。accepted 则记下该维度的放宽并继续；其余一律立刻终止
   * 会话——不继续试同维度的更高阶梯，也不跳到下一个维度。
   */
  submit(candidate: unknown): ProbeSubmitResult {
    if (this.state !== "running" || this.pending === null) {
      return Object.freeze({
        accepted: false as const,
        errorCode: "PROBE_NOT_RUNNING" as const,
      });
    }
    const parsed = probeEvidenceSchema.safeParse(candidate);
    if (!parsed.success) {
      return Object.freeze({
        accepted: false as const,
        errorCode: "PROBE_EVIDENCE_INVALID" as const,
      });
    }
    const evidence = parsed.data;
    const step = this.pending;
    if (
      evidence.serverProfileId !== this.serverProfileId ||
      evidence.dimension !== step.dimension ||
      evidence.candidateValue !== step.candidateValue
    ) {
      return Object.freeze({
        accepted: false as const,
        errorCode: "PROBE_OBSERVATION_MISMATCH" as const,
      });
    }
    this.collected.push(evidence);
    this.pending = null;

    if (isHaltingObservation(evidence.observation)) {
      this.state = "halted";
      this.haltReason = evidence.observation;
      if (discardsConfirmedWidening(evidence.observation)) {
        this.confirmed.clear();
      } else {
        // correction/warning/anomaly：本维度回退到稳定值，其余已确认项保留。
        this.confirmed.delete(evidence.dimension);
      }
      return Object.freeze({ accepted: true as const, state: this.state });
    }

    this.confirmed.set(evidence.dimension, evidence.candidateValue);
    if (this.cursor >= this.queue.length) this.state = "completed";
    return Object.freeze({ accepted: true as const, state: this.state });
  }

  /**
   * 当前应当写回 store 的边界。只包含**被明确接受过**的放宽，其余字段一律
   * 保持会话开始时的稳定值——没试过、试失败、被丢弃的，都按稳定值算。
   */
  resolvedLimits(): ServerPolicyLimits {
    const draft: Record<string, unknown> = { ...this.stableLimits };
    for (const [dimension, value] of this.confirmed) {
      draft[dimension] = value;
    }
    return serverPolicyLimitsSchema.parse(draft);
  }

  /**
   * 会话结论。`policy` 为 null 表示没有任何可信放宽（一步都没被接受，或已被
   * kick 丢弃），调用方应保持原策略不动。
   */
  outcome(): Readonly<{
    state: ProbeSessionState;
    haltReason: ProbeHaltReason | null;
    policy: ServerPolicy | null;
    evidence: readonly ProbeEvidence[];
  }> {
    const evidence = this.evidence;
    if (this.confirmed.size === 0) {
      return Object.freeze({
        state: this.state,
        haltReason: this.haltReason,
        policy: null,
        evidence,
      });
    }
    const policy = serverPolicySchema.parse({
      schemaVersion: "1.0",
      serverProfileId: this.serverProfileId,
      profile: "CUSTOM_VERIFIED",
      limits: this.resolvedLimits(),
      origin: "probed",
      evidenceIds: evidence.map((entry) => entry.evidenceId).slice(0, 64),
    });
    return Object.freeze({
      state: this.state,
      haltReason: this.haltReason,
      policy,
      evidence,
    });
  }
}

/**
 * 探测入口。唯一职责：确认目标是隔离测试服、且一个服同时只有一个会话在跑。
 * 第三方服在这里就被拒绝，不存在"自动探测"路径。
 */
export class ServerPolicyDetector {
  private readonly sessions = new Map<string, ServerPolicyProbeSession>();

  start(
    authorization: unknown,
    stableLimits: ServerPolicyLimits,
    dimensions?: readonly ProbeDimension[],
  ): ProbeStartResult {
    const parsed = probeAuthorizationSchema.safeParse(authorization);
    if (!parsed.success) {
      return Object.freeze({
        started: false as const,
        errorCode: "PROBE_AUTHORIZATION_INVALID" as const,
      });
    }
    const auth = parsed.data;
    if (!isIsolatedTarget(auth)) {
      return Object.freeze({
        started: false as const,
        errorCode: "PROBE_TARGET_NOT_ISOLATED" as const,
      });
    }
    const running = this.sessions.get(auth.serverProfileId);
    if (running && running.sessionState === "running") {
      return Object.freeze({
        started: false as const,
        errorCode: "PROBE_ALREADY_RUNNING" as const,
      });
    }
    const session = new ServerPolicyProbeSession(
      auth.serverProfileId,
      serverPolicyLimitsSchema.parse(stableLimits),
      dimensions,
    );
    this.sessions.set(auth.serverProfileId, session);
    return Object.freeze({ started: true as const, session });
  }

  /** 该服当前会话（若有）。按 serverProfileId 隔离，不跨服共享。 */
  session(serverProfileId: string): ServerPolicyProbeSession | null {
    return this.sessions.get(serverProfileId) ?? null;
  }

  /** 停止该服正在跑的会话。 */
  stop(serverProfileId: string): void {
    this.sessions.get(serverProfileId)?.stop();
  }
}
