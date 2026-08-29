import { z } from "zod";

/**
 * NoHunger 不是修改客户端显示值，而是减少服务端认可的移动消耗。
 *
 * maximum：经典 AntiHunger，隐藏冲刺状态并在安全的地面位移包中声明
 * onGround=false。adaptive：同样从 maximum 开始；若观察到反作弊告警或
 * 连续 setback，则依次退到 ground-only、低占空比 pulse，最后回到原版。
 */
export const noHungerModeSchema = z.enum(["adaptive", "maximum"]);

export const serverProfileNoHungerConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: noHungerModeSchema.optional(),
  })
  .strict();

export type ServerProfileNoHungerConfig = z.infer<
  typeof serverProfileNoHungerConfigSchema
>;
export type NoHungerMode = z.infer<typeof noHungerModeSchema>;

export type ResolvedNoHungerConfig = Readonly<{
  enabled: boolean;
  mode: NoHungerMode;
}>;

export const DEFAULT_NO_HUNGER_CONFIG: ResolvedNoHungerConfig = Object.freeze({
  enabled: true,
  mode: "adaptive",
});

export function resolveNoHungerConfig(
  configured: ServerProfileNoHungerConfig | undefined,
): ResolvedNoHungerConfig {
  return Object.freeze({
    enabled: configured?.enabled ?? DEFAULT_NO_HUNGER_CONFIG.enabled,
    mode: configured?.mode ?? DEFAULT_NO_HUNGER_CONFIG.mode,
  });
}

export type NoHungerStage =
  | "maximum"
  | "ground-only"
  | "pulse"
  | "vanilla";

export type NoHungerTransitionReason =
  | "initial"
  | "remembered-server-capability"
  | "anticheat-message"
  | "server-setback"
  | "anticheat-kick";

export type NoHungerSnapshot = Readonly<{
  enabled: boolean;
  mode: NoHungerMode;
  stage: NoHungerStage;
  transitionReason: NoHungerTransitionReason;
  spoofedGroundPackets: number;
  suppressedSprintPackets: number;
  observedSetbacks: number;
}>;

type WireWrite = (name: string, payload: unknown) => unknown;

type NoHungerWireClient = {
  write: WireWrite;
  on?: (event: string, listener: (payload: unknown) => void) => unknown;
  off?: (event: string, listener: (payload: unknown) => void) => unknown;
  removeListener?: (
    event: string,
    listener: (payload: unknown) => void,
  ) => unknown;
};

type NoHungerEntity = Readonly<{
  id?: unknown;
  onGround?: unknown;
  isInWater?: unknown;
  isInLava?: unknown;
  elytraFlying?: unknown;
  velocity?: Readonly<{ y?: unknown }>;
}>;

export type NoHungerBot = {
  _client?: NoHungerWireClient;
  entity?: NoHungerEntity;
  targetDigBlock?: unknown;
  vehicle?: unknown;
  getControlState?: (control: string) => boolean;
  on?: (event: string, listener: (payload: unknown) => void) => unknown;
  off?: (event: string, listener: (payload: unknown) => void) => unknown;
  removeListener?: (
    event: string,
    listener: (payload: unknown) => void,
  ) => unknown;
};

export class NoHungerCapabilityMemory {
  private readonly stages = new Map<string, NoHungerStage>();

  read(serverKey: string): NoHungerStage | undefined {
    return this.stages.get(serverKey);
  }

  remember(serverKey: string, stage: NoHungerStage): void {
    this.stages.set(serverKey, stage);
  }
}

const processCapabilityMemory = new NoHungerCapabilityMemory();

const MOVEMENT_PACKETS = new Set(["position", "position_look"]);
const CORRECTION_WINDOW_MS = 8_000;
const CORRECTION_THRESHOLD = 2;
const RECENT_SPOOF_WINDOW_MS = 1_500;
const SPAWN_CORRECTION_GRACE_MS = 5_000;
const PULSE_MIN_INTERVAL_PACKETS = 110;
const PULSE_JITTER_PACKETS = 31;
const VERTICAL_EPSILON = 1e-5;

const ANTICHEAT_SIGNAL_PATTERN =
  /(?:anti[- ]?cheat|grim|vulcan|matrix|intave|spartan|watchdog|ground\s*spoof|no\s*fall|bad\s*packets?|failed\s+(?:a\s+)?check|violation|非法移动|移动检测|作弊检测|反作弊)/iu;

function removeListener(
  emitter: Pick<NoHungerBot, "off" | "removeListener">,
  event: string,
  listener: (payload: unknown) => void,
): void {
  if (typeof emitter.off === "function") {
    emitter.off(event, listener);
    return;
  }
  emitter.removeListener?.(event, listener);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function packetClaimsOnGround(payload: unknown): boolean | null {
  const packet = asRecord(payload);
  if (!packet) return null;
  if (typeof packet.onGround === "boolean") return packet.onGround;
  const flags = asRecord(packet.flags);
  return typeof flags?.onGround === "boolean" ? flags.onGround : null;
}

function withOnGround(payload: unknown, onGround: boolean): unknown {
  const packet = asRecord(payload);
  if (!packet) return payload;
  const flags = asRecord(packet.flags);
  return {
    ...packet,
    onGround,
    ...(flags ? { flags: { ...flags, onGround } } : {}),
  };
}

function sprintAction(payload: unknown): "start" | "stop" | null {
  const actionId = asRecord(payload)?.actionId;
  if (actionId === "start_sprinting" || actionId === 3) return "start";
  if (actionId === "stop_sprinting" || actionId === 4) return "stop";
  return null;
}

function signalText(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 1_024);
  const record = asRecord(value);
  if (typeof record?.text === "string") return record.text.slice(0, 1_024);
  try {
    return String(value).slice(0, 1_024);
  } catch {
    return "";
  }
}

function stableHash(value: string): number {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function nextStage(stage: NoHungerStage): NoHungerStage {
  switch (stage) {
    case "maximum":
      return "ground-only";
    case "ground-only":
      return "pulse";
    case "pulse":
    case "vanilla":
      return "vanilla";
  }
}

export type NoHungerControllerOptions = Readonly<{
  config?: ServerProfileNoHungerConfig;
  serverKey: string;
  now?: () => number;
  capabilityMemory?: NoHungerCapabilityMemory;
}>;

export class NoHungerController {
  private readonly config: ResolvedNoHungerConfig;
  private readonly now: () => number;
  private readonly memory: NoHungerCapabilityMemory;
  private readonly client: NoHungerWireClient | null;
  private readonly originalWrite: WireWrite | null;
  private stage: NoHungerStage;
  private transitionReason: NoHungerTransitionReason;
  private attached = false;
  private spawned = false;
  private spawnAtMs = Number.NEGATIVE_INFINITY;
  private lastSpoofAtMs = Number.NEGATIVE_INFINITY;
  private lastActualOnGround: boolean | null = null;
  private desiredSprint = false;
  private lastStartSprintPayload: unknown = null;
  private correctionTimes: number[] = [];
  private eligibleGroundPackets = 0;
  private nextPulsePacket = PULSE_MIN_INTERVAL_PACKETS;
  private spoofedGroundPackets = 0;
  private suppressedSprintPackets = 0;
  private observedSetbacks = 0;

  private readonly onSpawn = () => this.startSession();
  private readonly onEnd = () => this.stop();
  private readonly onMessage = (message: unknown) =>
    this.observeServerSignal(message, "message");
  private readonly onKicked = (reason: unknown) =>
    this.observeServerSignal(reason, "kick");
  private readonly onPositionCorrection = () => this.observePositionCorrection();

  constructor(
    private readonly bot: NoHungerBot,
    private readonly options: NoHungerControllerOptions,
  ) {
    this.config = resolveNoHungerConfig(options.config);
    this.now = options.now ?? Date.now;
    this.memory = options.capabilityMemory ?? processCapabilityMemory;
    this.client = bot._client ?? null;
    this.originalWrite = this.client?.write ?? null;

    const remembered = this.config.mode === "adaptive"
      ? this.memory.read(options.serverKey)
      : undefined;
    this.stage = !this.config.enabled
      ? "vanilla"
      : this.config.mode === "maximum"
        ? "maximum"
        : remembered ?? "maximum";
    this.transitionReason = remembered
      ? "remembered-server-capability"
      : "initial";
  }

  attach(): this {
    if (this.attached) return this;
    if (!this.client || !this.originalWrite) return this;
    this.attached = true;
    const controller = this;
    this.client.write = function write(name, payload) {
      return controller.interceptWrite(name, payload);
    };
    this.bot.on?.("spawn", this.onSpawn);
    this.bot.on?.("end", this.onEnd);
    this.bot.on?.("messagestr", this.onMessage);
    this.bot.on?.("kicked", this.onKicked);
    this.client.on?.("position", this.onPositionCorrection);
    return this;
  }

  startSession(): void {
    this.spawned = true;
    this.spawnAtMs = this.now();
    this.lastActualOnGround = this.actualOnGround();
    this.correctionTimes = [];
  }

  stop(): void {
    if (!this.attached) return;
    this.attached = false;
    this.spawned = false;
    if (this.client && this.originalWrite) this.client.write = this.originalWrite;
    removeListener(this.bot, "spawn", this.onSpawn);
    removeListener(this.bot, "end", this.onEnd);
    removeListener(this.bot, "messagestr", this.onMessage);
    removeListener(this.bot, "kicked", this.onKicked);
    if (this.client) {
      removeListener(this.client, "position", this.onPositionCorrection);
    }
  }

  snapshot(): NoHungerSnapshot {
    return Object.freeze({
      enabled: this.config.enabled,
      mode: this.config.mode,
      stage: this.stage,
      transitionReason: this.transitionReason,
      spoofedGroundPackets: this.spoofedGroundPackets,
      suppressedSprintPackets: this.suppressedSprintPackets,
      observedSetbacks: this.observedSetbacks,
    });
  }

  observeServerSignal(value: unknown, source: "message" | "kick"): void {
    if (!this.canAdapt()) return;
    const text = signalText(value);
    const recentSpoof = this.now() - this.lastSpoofAtMs <= 3_000;
    if (!ANTICHEAT_SIGNAL_PATTERN.test(text) && !(source === "kick" && recentSpoof)) {
      return;
    }
    if (source === "kick") {
      this.transitionTo("vanilla", "anticheat-kick");
      return;
    }
    this.transitionTo(nextStage(this.stage), "anticheat-message");
  }

  private interceptWrite(name: string, payload: unknown): unknown {
    if (!this.attached || !this.spawned || this.stage === "vanilla") {
      return this.forward(name, payload);
    }

    if (name === "entity_action") {
      const action = sprintAction(payload);
      if (action) {
        this.desiredSprint = action === "start";
        if (action === "start") this.lastStartSprintPayload = payload;
        if (this.stage === "maximum") {
          this.suppressedSprintPackets += 1;
          return undefined;
        }
      }
    }

    if (!MOVEMENT_PACKETS.has(name)) return this.forward(name, payload);
    const actualOnGround = this.actualOnGround();
    const justLanded = actualOnGround === true && this.lastActualOnGround === false;
    this.lastActualOnGround = actualOnGround;

    if (
      packetClaimsOnGround(payload) !== true ||
      actualOnGround !== true ||
      justLanded ||
      !this.isSafeGroundMovement()
    ) {
      return this.forward(name, payload);
    }

    this.eligibleGroundPackets += 1;
    if (!this.shouldSpoofThisPacket()) return this.forward(name, payload);

    this.spoofedGroundPackets += 1;
    this.lastSpoofAtMs = this.now();
    return this.forward(name, withOnGround(payload, false));
  }

  private forward(name: string, payload: unknown): unknown {
    if (!this.client || !this.originalWrite) return undefined;
    return this.originalWrite.call(this.client, name, payload);
  }

  private actualOnGround(): boolean | null {
    const value = this.bot.entity?.onGround;
    return typeof value === "boolean" ? value : null;
  }

  private isSafeGroundMovement(): boolean {
    const entity = this.bot.entity;
    if (!entity || entity.isInWater === true || entity.isInLava === true) return false;
    if (entity.elytraFlying === true || this.bot.vehicle != null) return false;
    if (this.bot.targetDigBlock != null) return false;
    const velocityY = entity.velocity?.y;
    if (typeof velocityY === "number" && Math.abs(velocityY) > VERTICAL_EPSILON) {
      return false;
    }
    if (this.control("jump")) return false;
    return ["forward", "back", "left", "right"].some((control) =>
      this.control(control),
    );
  }

  private control(name: string): boolean {
    try {
      return this.bot.getControlState?.(name) === true;
    } catch {
      return false;
    }
  }

  private shouldSpoofThisPacket(): boolean {
    if (this.stage !== "pulse") return true;
    if (this.eligibleGroundPackets < this.nextPulsePacket) return false;
    const jitter = stableHash(
      `${this.options.serverKey}:${this.spoofedGroundPackets}`,
    ) % PULSE_JITTER_PACKETS;
    this.nextPulsePacket =
      this.eligibleGroundPackets + PULSE_MIN_INTERVAL_PACKETS + jitter;
    return true;
  }

  private observePositionCorrection(): void {
    if (!this.canAdapt() || !this.spawned || this.stage === "vanilla") return;
    const now = this.now();
    if (now - this.spawnAtMs < SPAWN_CORRECTION_GRACE_MS) return;
    if (now - this.lastSpoofAtMs > RECENT_SPOOF_WINDOW_MS) return;

    this.observedSetbacks += 1;
    this.correctionTimes = this.correctionTimes.filter(
      (at) => now - at <= CORRECTION_WINDOW_MS,
    );
    this.correctionTimes.push(now);
    if (this.correctionTimes.length < CORRECTION_THRESHOLD) return;

    this.correctionTimes = [];
    this.transitionTo(nextStage(this.stage), "server-setback");
  }

  private canAdapt(): boolean {
    return this.config.enabled && this.config.mode === "adaptive";
  }

  private transitionTo(
    next: NoHungerStage,
    reason: NoHungerTransitionReason,
  ): void {
    if (next === this.stage) return;
    const previous = this.stage;
    this.stage = next;
    this.transitionReason = reason;
    this.memory.remember(this.options.serverKey, next);
    if (next === "pulse") {
      const jitter = stableHash(this.options.serverKey) % PULSE_JITTER_PACKETS;
      this.nextPulsePacket =
        this.eligibleGroundPackets + PULSE_MIN_INTERVAL_PACKETS + jitter;
    }
    if (previous === "maximum" && next !== "maximum") {
      this.resyncSprintState();
    }
  }

  private resyncSprintState(): void {
    if (!this.spawned || !this.desiredSprint || this.lastStartSprintPayload == null) {
      return;
    }
    this.forward("entity_action", this.lastStartSprintPayload);
  }
}

export function attachNoHunger(
  bot: NoHungerBot,
  options: NoHungerControllerOptions,
): NoHungerController {
  return new NoHungerController(bot, options).attach();
}
