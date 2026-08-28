/**
 * ACK-gated interaction sequencing for combat actions.
 *
 * The sequencer never owns a timer and never assumes a packet was executed.
 * Callers request one ready step, execute it through their runtime boundary,
 * then record the server/runtime acknowledgement before asking for another.
 */

import { DeterministicJitter } from "./deterministic-jitter.js";
import {
  CombatReflexNotClearedError,
  REFLEX_BUDGET_MS,
  type CombatReflexDecision,
} from "./reflex-clearance.js";

export type CombatInteractionClass = "use" | "attack";

export type CombatChainStep = Readonly<{
  label: string;
  interactionClass: CombatInteractionClass;
  /** Minimum gap after the previous ACK. Class cadence can make it longer. */
  minimumGapMs?: number;
  /** Optional per-step override; otherwise the measured RTT budget is used. */
  ackBudgetMs?: number;
}>;

export type CombatChainContext = Readonly<{
  retreatInProgress: boolean;
  clearance?: CombatReflexDecision | null;
  chainLifetimeMs?: number;
}>;

export type CombatChainRefusalCode =
  | "CLEARANCE_REQUIRED"
  | "RETREAT_IN_PROGRESS"
  | "THROTTLED"
  | "STEP_UNACKED"
  | "CHAIN_EXPIRED";

export type CombatChainStepRecord = Readonly<{
  label: string;
  interactionClass: CombatInteractionClass;
  requestedAtMs: number;
  executedAtMs: number | null;
  ackDeadlineAtMs: number;
  ackRttMs: number | null;
  acknowledgedWithinBudget: boolean | null;
}>;

export type CombatChainDecision = Readonly<{
  state: "STEP_READY" | "AWAITING_ACK" | "COMPLETE" | "REFUSED";
  refusal: CombatChainRefusalCode | null;
  step: CombatChainStepRecord | null;
  nextLegalAtMs: number | null;
  records: readonly CombatChainStepRecord[];
}>;

export type CombatChainSequencerPolicy = Readonly<{
  useIntervalMs: number;
  attackIntervalMs: number;
  cadenceJitterMaxMs: number;
  stepJitterMaxMs: number;
  initialAckBudgetMs: number;
  minimumMeasuredAckBudgetMs: number;
  ackBudgetMultiplier: number;
  ackSampleLimit: number;
  defaultChainLifetimeMs: number;
}>;

export const DEFAULT_CHAIN_SEQUENCER_POLICY: CombatChainSequencerPolicy = {
  // Four game ticks. This is a design cadence and remains unverified on a
  // live isolated server until the M3 timing run is performed.
  useIntervalMs: 200,
  // Entity attacks do not share the client use-item delay. WeaponManager owns
  // attack cooldown and i-frame timing.
  attackIntervalMs: 0,
  cadenceJitterMaxMs: 40,
  stepJitterMaxMs: 20,
  initialAckBudgetMs: 1_000,
  minimumMeasuredAckBudgetMs: 100,
  ackBudgetMultiplier: 3,
  ackSampleLimit: 16,
  defaultChainLifetimeMs: 5_000,
};

type MutableStepRecord = {
  label: string;
  interactionClass: CombatInteractionClass;
  requestedAtMs: number;
  executedAtMs: number | null;
  ackDeadlineAtMs: number;
  ackRttMs: number | null;
  acknowledgedWithinBudget: boolean | null;
};

type ActiveChain = {
  steps: readonly CombatChainStep[];
  scheduledGapsMs: readonly number[];
  index: number;
  startedAtMs: number;
  expiresAtMs: number;
  previousAckAtMs: number | null;
  pending: MutableStepRecord | null;
  records: MutableStepRecord[];
  requiresClearance: boolean;
  terminalRefusal: CombatChainRefusalCode | null;
};

export class ChainSequencer {
  private jitter: DeterministicJitter;
  private active: ActiveChain | null = null;
  private lastRecords: CombatChainStepRecord[] = [];
  private lastTerminalRefusal: CombatChainRefusalCode | null = null;
  private lastObservedAtMs: number | null = null;
  private readonly nextLegalByClass = new Map<CombatInteractionClass, number>();
  private readonly ackSamples = new Map<CombatInteractionClass, number[]>();

  constructor(
    private readonly policy: CombatChainSequencerPolicy =
      DEFAULT_CHAIN_SEQUENCER_POLICY,
    private readonly seed = 0x4348_4149,
  ) {
    validatePolicy(policy);
    this.jitter = new DeterministicJitter(seed);
  }

  reset(): void {
    this.active = null;
    this.lastRecords = [];
    this.lastTerminalRefusal = null;
    this.lastObservedAtMs = null;
    this.nextLegalByClass.clear();
    this.ackSamples.clear();
    this.jitter = new DeterministicJitter(this.seed);
  }

  nextLegalAtMs(
    interactionClass: CombatInteractionClass,
    nowMs: number,
  ): number {
    validateInteractionClass(interactionClass);
    validateTime(nowMs, "nowMs");
    return Math.max(nowMs, this.nextLegalByClass.get(interactionClass) ?? nowMs);
  }

  measuredAckRttMs(interactionClass: CombatInteractionClass): number | null {
    validateInteractionClass(interactionClass);
    const samples = this.ackSamples.get(interactionClass) ?? [];
    if (samples.length === 0) return null;
    return samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
  }

  beginChain(
    steps: readonly CombatChainStep[],
    nowMs: number,
    context: CombatChainContext,
  ): CombatChainDecision {
    this.observeClock(nowMs);
    validateContext(context, this.policy);
    validateSteps(steps);

    if (this.active !== null) {
      return this.nextStep(nowMs, context);
    }

    const requiresClearance = chainRequiresClearance(steps, this.policy);
    assertClearance(requiresClearance, context.clearance);
    if (context.retreatInProgress) {
      return refusal("RETREAT_IN_PROGRESS", null, this.lastRecords);
    }

    const first = steps[0]!;
    const legalAtMs = this.nextLegalAtMs(first.interactionClass, nowMs);
    if (legalAtMs > nowMs) {
      return refusal("THROTTLED", legalAtMs, this.lastRecords);
    }

    const lifetimeMs = context.chainLifetimeMs ??
      this.policy.defaultChainLifetimeMs;
    this.lastRecords = [];
    this.lastTerminalRefusal = null;
    this.active = {
      steps: steps.map((step) => ({ ...step })),
      scheduledGapsMs: steps.map((step, index) =>
        index === 0 ? 0 : this.scheduledGap(step)
      ),
      index: 0,
      startedAtMs: nowMs,
      expiresAtMs: nowMs + lifetimeMs,
      previousAckAtMs: null,
      pending: null,
      records: [],
      requiresClearance,
      terminalRefusal: null,
    };
    return this.requestCurrentStep(nowMs);
  }

  nextStep(nowMs: number, context: CombatChainContext): CombatChainDecision {
    this.observeClock(nowMs);
    validateContext(context, this.policy);
    const chain = this.active;
    if (chain === null) {
      return this.lastTerminalRefusal === null
        ? complete(this.lastRecords)
        : refusal(this.lastTerminalRefusal, null, this.lastRecords);
    }

    // The order is deliberate: a fast chain cannot use retreat or another
    // refusal path to bypass the timing clearance check.
    assertClearance(chain.requiresClearance, context.clearance);
    if (context.retreatInProgress) {
      this.archiveActive("RETREAT_IN_PROGRESS");
      return refusal("RETREAT_IN_PROGRESS", null, this.lastRecords);
    }

    if (chain.terminalRefusal !== null) {
      return refusal(chain.terminalRefusal, null, chain.records);
    }
    if (chain.pending !== null) {
      if (nowMs > chain.pending.ackDeadlineAtMs) {
        chain.terminalRefusal = "STEP_UNACKED";
        return refusal("STEP_UNACKED", null, chain.records);
      }
      return decision("AWAITING_ACK", null, chain.pending, null, chain.records);
    }

    const step = chain.steps[chain.index];
    if (step === undefined) {
      this.archiveActive(null);
      return complete(this.lastRecords);
    }
    const classLegalAtMs = this.nextLegalAtMs(step.interactionClass, nowMs);
    const chainLegalAtMs = chain.previousAckAtMs === null
      ? nowMs
      : chain.previousAckAtMs + chain.scheduledGapsMs[chain.index]!;
    const legalAtMs = Math.max(classLegalAtMs, chainLegalAtMs);
    if (legalAtMs > nowMs) {
      return refusal("THROTTLED", legalAtMs, chain.records);
    }
    if (nowMs > chain.expiresAtMs) {
      chain.terminalRefusal = "CHAIN_EXPIRED";
      return refusal("CHAIN_EXPIRED", null, chain.records);
    }
    return this.requestCurrentStep(nowMs);
  }

  recordStepAcked(label: string, nowMs: number): CombatChainStepRecord {
    this.observeClock(nowMs);
    const chain = this.active;
    if (chain === null) {
      throw new TypeError("Chain ACK does not match the pending step label.");
    }
    const pending = chain.pending;
    if (pending === null || pending.label !== label) {
      throw new TypeError("Chain ACK does not match the pending step label.");
    }
    if (nowMs < pending.requestedAtMs) {
      throw new RangeError("Chain ACK precedes its request.");
    }

    const ackRttMs = nowMs - pending.requestedAtMs;
    const withinBudget = nowMs <= pending.ackDeadlineAtMs;
    pending.executedAtMs = nowMs;
    pending.ackRttMs = ackRttMs;
    pending.acknowledgedWithinBudget = withinBudget;
    this.recordAckSample(pending.interactionClass, ackRttMs);
    this.recordClassCadence(pending.interactionClass, nowMs);

    chain.previousAckAtMs = nowMs;
    chain.pending = null;
    chain.index += 1;
    if (!withinBudget) chain.terminalRefusal = "STEP_UNACKED";

    const result = cloneRecord(pending);
    if (chain.terminalRefusal !== null || chain.index >= chain.steps.length) {
      this.archiveActive(chain.terminalRefusal);
    }
    return result;
  }

  /** Preserve the request audit while preventing a failed action from advancing. */
  abandonChain(): void {
    if (this.active === null) return;
    this.archiveActive(null);
  }

  records(): readonly CombatChainStepRecord[] {
    const records = this.active?.records ?? this.lastRecords;
    return records.map(cloneRecord);
  }

  private requestCurrentStep(nowMs: number): CombatChainDecision {
    const chain = this.active;
    if (chain === null) return complete(this.lastRecords);
    const step = chain.steps[chain.index];
    if (step === undefined) {
      this.archiveActive(null);
      return complete(this.lastRecords);
    }
    const ackBudgetMs = step.ackBudgetMs ??
      this.measuredAckBudgetMs(step.interactionClass);
    const record: MutableStepRecord = {
      label: step.label,
      interactionClass: step.interactionClass,
      requestedAtMs: nowMs,
      executedAtMs: null,
      ackDeadlineAtMs: nowMs + ackBudgetMs,
      ackRttMs: null,
      acknowledgedWithinBudget: null,
    };
    chain.pending = record;
    chain.records.push(record);
    return decision("STEP_READY", null, record, nowMs, chain.records);
  }

  private measuredAckBudgetMs(interactionClass: CombatInteractionClass): number {
    const measured = this.measuredAckRttMs(interactionClass);
    return measured === null
      ? this.policy.initialAckBudgetMs
      : Math.max(
          this.policy.minimumMeasuredAckBudgetMs,
          Math.ceil(measured * this.policy.ackBudgetMultiplier),
        );
  }

  private scheduledGap(step: CombatChainStep): number {
    const minimumGapMs = step.minimumGapMs ?? 0;
    if (minimumGapMs === 0) return 0;
    return minimumGapMs + this.nonNegativeJitter(this.policy.stepJitterMaxMs);
  }

  private recordClassCadence(
    interactionClass: CombatInteractionClass,
    ackedAtMs: number,
  ): void {
    const interval = interactionClass === "use"
      ? this.policy.useIntervalMs
      : this.policy.attackIntervalMs;
    const jitter = interval === 0
      ? 0
      : this.nonNegativeJitter(this.policy.cadenceJitterMaxMs);
    this.nextLegalByClass.set(interactionClass, ackedAtMs + interval + jitter);
  }

  private recordAckSample(
    interactionClass: CombatInteractionClass,
    ackRttMs: number,
  ): void {
    const samples = this.ackSamples.get(interactionClass) ?? [];
    samples.push(ackRttMs);
    if (samples.length > this.policy.ackSampleLimit) {
      samples.splice(0, samples.length - this.policy.ackSampleLimit);
    }
    this.ackSamples.set(interactionClass, samples);
  }

  private nonNegativeJitter(maxMs: number): number {
    if (maxMs === 0) return 0;
    return Math.floor(((this.jitter.next() + 1) / 2) * (maxMs + 1));
  }

  private archiveActive(refusalCode: CombatChainRefusalCode | null): void {
    if (this.active !== null) {
      this.lastRecords = this.active.records.map(cloneRecord);
    }
    this.lastTerminalRefusal = refusalCode;
    this.active = null;
  }

  private observeClock(nowMs: number): void {
    validateTime(nowMs, "nowMs");
    if (this.lastObservedAtMs !== null && nowMs < this.lastObservedAtMs) {
      throw new RangeError("Chain sequencer clock moved backwards.");
    }
    this.lastObservedAtMs = nowMs;
  }
}

function chainRequiresClearance(
  steps: readonly CombatChainStep[],
  policy: CombatChainSequencerPolicy,
): boolean {
  return steps.slice(1).some((step) => {
    const classInterval = step.interactionClass === "use"
      ? policy.useIntervalMs
      : policy.attackIntervalMs;
    return Math.max(classInterval, step.minimumGapMs ?? 0) < REFLEX_BUDGET_MS;
  });
}

function assertClearance(
  required: boolean,
  clearance: CombatReflexDecision | null | undefined,
): void {
  if (!required || clearance?.cleared === true) return;
  throw new CombatReflexNotClearedError(
    clearance?.denial ?? "NO_PROBE_DATA",
  );
}

function validatePolicy(policy: CombatChainSequencerPolicy): void {
  for (const value of [
    policy.useIntervalMs,
    policy.attackIntervalMs,
    policy.cadenceJitterMaxMs,
    policy.stepJitterMaxMs,
    policy.initialAckBudgetMs,
    policy.minimumMeasuredAckBudgetMs,
    policy.ackBudgetMultiplier,
    policy.defaultChainLifetimeMs,
  ]) {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError("Chain sequencer policy contains an invalid duration.");
    }
  }
  if (
    policy.useIntervalMs < REFLEX_BUDGET_MS ||
    policy.initialAckBudgetMs <= 0 ||
    policy.minimumMeasuredAckBudgetMs <= 0 ||
    policy.ackBudgetMultiplier < 1 ||
    !Number.isInteger(policy.ackSampleLimit) ||
    policy.ackSampleLimit < 1 ||
    policy.defaultChainLifetimeMs <= 0
  ) {
    throw new TypeError("Chain sequencer policy violates timing bounds.");
  }
}

function validateSteps(steps: readonly CombatChainStep[]): void {
  if (steps.length === 0 || steps.length > 64) {
    throw new TypeError("A combat chain needs between 1 and 64 steps.");
  }
  const labels = new Set<string>();
  for (const step of steps) {
    validateInteractionClass(step.interactionClass);
    if (step.label.trim().length === 0 || labels.has(step.label)) {
      throw new TypeError("Combat chain step labels must be unique and non-empty.");
    }
    labels.add(step.label);
    if (
      step.minimumGapMs !== undefined &&
      (!Number.isFinite(step.minimumGapMs) || step.minimumGapMs < 0)
    ) {
      throw new TypeError("Combat chain minimumGapMs must be non-negative.");
    }
    if (
      step.ackBudgetMs !== undefined &&
      (!Number.isFinite(step.ackBudgetMs) || step.ackBudgetMs <= 0)
    ) {
      throw new TypeError("Combat chain ackBudgetMs must be positive.");
    }
  }
}

function validateContext(
  context: CombatChainContext,
  policy: CombatChainSequencerPolicy,
): void {
  if (typeof context.retreatInProgress !== "boolean") {
    throw new TypeError("Combat chain retreatInProgress must be boolean.");
  }
  if (
    context.chainLifetimeMs !== undefined &&
    (!Number.isFinite(context.chainLifetimeMs) ||
      context.chainLifetimeMs <= 0 ||
      context.chainLifetimeMs > policy.defaultChainLifetimeMs)
  ) {
    throw new TypeError("Combat chain lifetime is out of bounds.");
  }
}

function validateInteractionClass(value: CombatInteractionClass): void {
  if (value !== "use" && value !== "attack") {
    throw new TypeError("Unknown combat interaction class.");
  }
}

function validateTime(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative finite number.`);
  }
}

function cloneRecord(record: CombatChainStepRecord): CombatChainStepRecord {
  return { ...record };
}

function decision(
  state: CombatChainDecision["state"],
  refusalCode: CombatChainRefusalCode | null,
  step: CombatChainStepRecord | null,
  nextLegalAtMs: number | null,
  records: readonly CombatChainStepRecord[],
): CombatChainDecision {
  return {
    state,
    refusal: refusalCode,
    step: step === null ? null : cloneRecord(step),
    nextLegalAtMs,
    records: records.map(cloneRecord),
  };
}

function refusal(
  refusalCode: CombatChainRefusalCode,
  nextLegalAtMs: number | null,
  records: readonly CombatChainStepRecord[],
): CombatChainDecision {
  return decision("REFUSED", refusalCode, null, nextLegalAtMs, records);
}

function complete(
  records: readonly CombatChainStepRecord[],
): CombatChainDecision {
  return decision("COMPLETE", null, null, null, records);
}
