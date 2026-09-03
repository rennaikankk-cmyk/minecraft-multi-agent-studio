// ---------------------------------------------------------------------------
// movement-sync.ts —— Grim 过闸整形器（movementSync clean-room v1）。
//
// 病灶（luv 2026-09-04 双向抓包实证）：
//   1. **位置战争**：服务端 setback 传送 → mineflayer 确认后立刻又发自预测
//      位置 → 再 setback（3s 内 141 次确认循环）。auth 冻结用 setback 钉人，
//      登录后静止包放行、移动包全打回。
//   2. **onGround 失真**：物理在 setback 战争中失同步——站在 y=90 稳定地面
//      却报 onGround=false，水平移动+悬空声明 = 飞行签名 → 反作弊全数拒绝。
//
// 整形三律（出站包为唯一真值 + 输入补偿 + tick 钳制的 clean-room 落地）：
//   A. **服从窗**：收到服务端 position（setback/传送）后 RESYNC_HOLD_MS 内，
//      一切出站移动包改写为服务端钉住位置——不打position战争，给信任恢复
//      留出干净窗口。
//   B. **onGround 重建**：声明悬空但脚下方块为实且垂直位移≈0 → 改写为
//      onGround=true（地面真值来自服务端方块状态，不来自本地物理预测）。
//   C. **速度钳制**：相邻出站位置的水平位移钳到原版可达上限
//      （疾跑 5.612 b/t 挡 × 1.25 容差），杜绝任何一包超速。
//
// 门控：STUDIO_MOVEMENT_SHAPER=1（验证期）；过闸后并入 ServerCompatibility
// 体系做 MOVEMENT_SHAPED 基线。
// ---------------------------------------------------------------------------

/** mc-protocol wire 最小面（真实客户端与测试替身同构）。 */
export interface MovementWire {
  on(event: string, listener: (...args: never[]) => void): unknown;
  off(event: string, listener: (...args: never[]) => void): unknown;
  write(channel: string, payload: unknown): unknown;
}

export interface MovementShaperOptions {
  /** setback 服从窗（ms）。 */
  readonly resyncHoldMs?: number;
  /** 出站单包水平位移上限（格）。默认 5.612*0.05*1.25 ≈ 0.35。 */
  readonly maxDeltaPerPacket?: number;
  /** onGround 重建的垂直位移阈值（格）。 */
  readonly groundProbeEpsilon?: number;
  readonly now?: () => number;
}

/** 地面探测：脚下方块是否为实（由调用方接 bot.blockAt）。 */
export type GroundProbe = (position: { x: number; y: number; z: number }) => boolean;

interface PositionPayload {
  x?: number;
  y?: number;
  z?: number;
  yaw?: number;
  pitch?: number;
  onGround?: boolean;
}

const DEFAULT_RESYNC_HOLD_MS = 1_200;
const DEFAULT_MAX_DELTA = 5.612 * 0.05 * 1.25;
const DEFAULT_GROUND_EPSILON = 0.001;

const SHAPED_CHANNELS = new Set(["position", "position_look", "flying"]);

export class MovementSyncShaper {
  private pinned: { x: number; y: number; z: number; atMs: number } | null = null;
  private lastSent: { x: number; y: number; z: number } | null = null;
  private setbackCount = 0;
  private rewrittenCount = 0;
  private readonly resyncHoldMs: number;
  private readonly maxDelta: number;
  private readonly groundEpsilon: number;
  private readonly now: () => number;

  constructor(
    private readonly probeGround: GroundProbe,
    options: MovementShaperOptions = {},
  ) {
    this.resyncHoldMs = options.resyncHoldMs ?? DEFAULT_RESYNC_HOLD_MS;
    this.maxDelta = options.maxDeltaPerPacket ?? DEFAULT_MAX_DELTA;
    this.groundEpsilon = options.groundProbeEpsilon ?? DEFAULT_GROUND_EPSILON;
    this.now = options.now ?? (() => Date.now());
  }

  get stats(): Readonly<{ setbacks: number; rewrites: number }> {
    return { setbacks: this.setbackCount, rewrites: this.rewrittenCount };
  }

  install(wire: MovementWire): () => void {
    const onServerPosition = (packet: PositionPayload) => {
      if (
        typeof packet?.x !== "number" ||
        typeof packet?.y !== "number" ||
        typeof packet?.z !== "number"
      ) {
        return;
      }
      this.pinned = { x: packet.x, y: packet.y, z: packet.z, atMs: this.now() };
      this.setbackCount += 1;
    };
    wire.on("position", onServerPosition as never);

    const origWrite = wire.write.bind(wire);
    const shapedWrite = (channel: string, payload: unknown): unknown => {
      if (SHAPED_CHANNELS.has(channel)) {
        const out = this.shape(channel, payload as PositionPayload);
        if (out !== null) {
          this.rewrittenCount += 1;
          return origWrite(channel, out);
        }
        return origWrite(channel, payload);
      }
      return origWrite(channel, payload);
    };
    wire.write = shapedWrite;

    return () => {
      wire.off("position", onServerPosition as never);
      wire.write = origWrite;
    };
  }

  /** 纯整形：返回 null = 原样放行；返回对象 = 改写后的载荷。 */
  private shape(channel: string, payload: PositionPayload): PositionPayload | null {
    if (typeof payload?.x !== "number" || typeof payload?.y !== "number" || typeof payload?.z !== "number") {
      // "flying"（仅状态包）没有坐标——用最后已知出站位置做地面探测
      if (channel === "flying" && payload?.onGround === false && this.lastSent !== null) {
        const rebuilt = this.rebuildGround(payload, this.lastSent);
        if (rebuilt !== null) return rebuilt;
      }
      return null;
    }
    const nowMs = this.now();

    // A. 服从窗：setback 后短窗内一切移动改写为钉住位置
    if (this.pinned !== null && nowMs - this.pinned.atMs < this.resyncHoldMs) {
      this.lastSent = { x: this.pinned.x, y: this.pinned.y, z: this.pinned.z };
      return {
        ...payload,
        x: this.pinned.x,
        y: this.pinned.y,
        z: this.pinned.z,
        onGround: this.probeGround(this.pinned) || payload.onGround === true,
      };
    }

    let out: PositionPayload = payload;

    // B. onGround 重建：声明悬空 + 脚下实方块 + 垂直静止 → true
    if (payload.onGround === false) {
      const pos = { x: payload.x, y: payload.y, z: payload.z };
      const rebuilt = this.rebuildGround(payload, pos);
      if (rebuilt !== null) out = { ...payload, onGround: true };
    }

    // C. 速度钳制：相对上次出站位置的水平位移
    if (this.lastSent !== null) {
      const dx = payload.x - this.lastSent.x;
      const dz = payload.z - this.lastSent.z;
      const horizontal = Math.hypot(dx, dz);
      if (horizontal > this.maxDelta) {
        const scale = this.maxDelta / horizontal;
        out = {
          ...out,
          x: this.lastSent.x + dx * scale,
          z: this.lastSent.z + dz * scale,
        };
      }
    }
    this.lastSent = { x: out.x ?? payload.x, y: out.y ?? payload.y, z: out.z ?? payload.z };
    return out === payload ? null : out;
  }

  private rebuildGround(payload: PositionPayload, pos: { x: number; y: number; z: number }): PositionPayload | null {
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return null;
    if (!this.probeGround(pos)) return null;
    if (this.lastSent !== null && Math.abs(pos.y - this.lastSent.y) > this.groundEpsilon) return null;
    return { ...payload, onGround: true };
  }
}
