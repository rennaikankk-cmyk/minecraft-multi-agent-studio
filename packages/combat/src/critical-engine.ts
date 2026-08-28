// ---------------------------------------------------------------------------
// CriticalHitEngine —— 近战暴击策略选择与执行（干净室重写）。
//
// 参考实现学习来源（仅算法思想，无代码复制；AstraPlus 无许可证，全部
// 重新实现）：
//   - AstraPlus Criticals.java 的三模式（NCP 微上移双包 / Grim 三包 /
//     物理跳跃）与暂停-恢复状态机
//   - Minecraft-PVP-ROBO 的 cooldown ≥ 0.85 攻击闸与控制帧节奏
//
// 五种策略（Combat Planner 按 ping/TPS/距离/Combo 状态选择）：
//   NORMAL_JUMP_CRIT  完整物理跳跃（0.42 motionY），下落段攻击
//   LOW_HOP_CRIT      低跳（0.2 motionY），短空中窗口
//   MINI_JUMP_CRIT    微跳（0.05 motionY，AstraPlus Mini 默认值）
//   PACKET_CRIT       不跳：攻击前发 [y+ε, y] 双移动包（ε=2.71875e-7），
//                     onGround=false，伪造"下落中"状态
//   NO_CRIT           普通攻击（冲刺/Combo 优先时不破坏节奏）
//
// 策略选择原则（来自参考项目 + 任务书）：
//   追击中（速度>0.2）: PACKET_CRIT 或 MINI_JUMP（不打断移动）
//   贴脸 Combo 中:      MINI_JUMP_CRIT
//   高延迟（ping>150ms）: NORMAL_JUMP（物理包服务器必收）
//   水中/岩浆/梯子/蛛网: NO_CRIT（物理状态不可控）
// ---------------------------------------------------------------------------

/** 结构化 bot 视图：combat 包不依赖 mineflayer（与包内其余模块一致）。 */
type BotPhysicsView = {
  entity: {
    position: { x: number; y: number; z: number };
    velocity: { x: number; y: number; z: number };
    onGround: boolean;
  } | null;
};

type BotControlView = {
  setControlState: (name: string, state: boolean) => void;
};

export const CRITICAL_STRATEGIES = [
  "NORMAL_JUMP_CRIT",
  "LOW_HOP_CRIT",
  "MINI_JUMP_CRIT",
  "PACKET_CRIT",
  "NO_CRIT",
] as const;

export type CriticalStrategy = (typeof CRITICAL_STRATEGIES)[number];

/** 物理跳跃的 motionY 值。 */
const MOTION_Y = {
  NORMAL_JUMP: 0.42,
  LOW_HOP: 0.2,
  MINI_JUMP: 0.05,
} as const;

/** PACKET_CRIT 的微上移量（NCP 类反作弊认可的离散步进以下）。 */
const PACKET_CRIT_OFFSET = 2.71875e-7;

export type CriticalContext = Readonly<{
  /** 当前 ping（ms）。 */
  pingMs: number;
  /** 自身水平速度（blocks/tick）。 */
  selfSpeed: number;
  /** 与目标距离（blocks）。 */
  targetDistance: number;
  /** 是否在水中/岩浆/梯子/蛛网（物理状态不可靠）。 */
  inCompromisedPhysics: boolean;
  /** 目标是否在移动（Combo 保持价值高）。 */
  targetMoving: boolean;
  /** 头顶 2 格是否有方块（LowHop 会被天花板截断——正好是 AstraPlus 用法）。 */
  ceilingAbove: boolean;
  /** 服务器兼容档（ANARCHY 下允许 PACKET_CRIT；保守档只用物理跳）。 */
  allowPacketCrit: boolean;
}>;

export type CriticalOutcome = Readonly<{
  strategy: CriticalStrategy;
  /** 下一击是否应等待暴击窗口（物理跳的下落段）。 */
  awaitFallWindow: boolean;
}>;

/**
 * 策略选择器（纯函数，可单测）。规则从高到低：
 * 1. 物理不可靠（水/岩浆/梯/网）→ NO_CRIT
 * 2. 高延迟 → NORMAL_JUMP（物理包服务器必收，packet 类易被丢）
 * 3. 追击中（速度快 + 目标移动）→ PACKET_CRIT（若允许）否则 MINI_JUMP
 * 4. 贴脸（<1.5 格）→ MINI_JUMP_CRIT（最短空中窗口，不打断 Combo）
 * 5. 有天花板 → LOW_HOP_CRIT（天花板把跳截断成短窗口）
 * 6. 默认 → NORMAL_JUMP_CRIT
 */
export function selectCriticalStrategy(
  context: CriticalContext,
): CriticalOutcome {
  if (context.inCompromisedPhysics) {
    return { strategy: "NO_CRIT", awaitFallWindow: false };
  }
  if (context.pingMs > 150) {
    return { strategy: "NORMAL_JUMP_CRIT", awaitFallWindow: true };
  }
  const chasing = context.selfSpeed > 0.2 && context.targetMoving;
  if (chasing) {
    if (context.allowPacketCrit && context.targetDistance > 2) {
      return { strategy: "PACKET_CRIT", awaitFallWindow: false };
    }
    return { strategy: "MINI_JUMP_CRIT", awaitFallWindow: true };
  }
  if (context.targetDistance < 1.5) {
    return { strategy: "MINI_JUMP_CRIT", awaitFallWindow: true };
  }
  if (context.ceilingAbove) {
    return { strategy: "LOW_HOP_CRIT", awaitFallWindow: true };
  }
  return { strategy: "NORMAL_JUMP_CRIT", awaitFallWindow: true };
}

/** 判断当前是否处于暴击窗口（下落中且 fallDistance > 0）。 */
export function inCriticalWindow(bot: BotPhysicsView): boolean {
  const entity = bot.entity;
  if (!entity) return false;
  if (entity.onGround) return false;
  return entity.velocity.y < -0.08;
}

/**
 * 执行暴击前置动作。返回 true 表示已注入（物理跳已设 control / 包已发）。
 * PACKET_CRIT 直接写移动包（微型 y 偏移双包，onGround=false）；
 * 物理跳通过 controlState jump + motionY 覆盖实现 LowHop/MiniJump。
 */
export function primeCritical(
  bot: BotPhysicsView & BotControlView,
  strategy: CriticalStrategy,
): boolean {
  const entity = bot.entity;
  if (!entity) return false;
  switch (strategy) {
    case "NO_CRIT":
      return true;
    case "PACKET_CRIT": {
      const client = (
        bot as unknown as {
          _client: {
            write: (channel: string, payload: unknown) => void;
          };
        }
      )._client;
      if (!client) return false;
      const { x, y, z } = entity.position;
      // 双包：微上移 + 归位，均 onGround=false——服务器侧看到"下落中"。
      client.write("position", {
        x,
        y: y + PACKET_CRIT_OFFSET,
        z,
        onGround: false,
      });
      client.write("position", { x, y, z, onGround: false });
      return true;
    }
    case "MINI_JUMP_CRIT":
    case "LOW_HOP_CRIT":
    case "NORMAL_JUMP_CRIT": {
      if (!entity.onGround) return false; // 空中不重复起跳
      const motionY =
        strategy === "MINI_JUMP_CRIT"
          ? MOTION_Y.MINI_JUMP
          : strategy === "LOW_HOP_CRIT"
            ? MOTION_Y.LOW_HOP
            : MOTION_Y.NORMAL_JUMP;
      bot.setControlState("jump", true);
      // mineflayer 物理会在下一 tick 计算 0.42 跳；低跳通过直接覆盖
      // velocity 实现（在 setControlState 之后写，物理 tick 前生效）。
      if (motionY !== MOTION_Y.NORMAL_JUMP) {
        (entity.velocity as { y: number }).y = motionY;
      }
      return true;
    }
  }
}

/** 攻击后清理（松开 jump）。 */
export function releaseCriticalPriming(bot: BotControlView): void {
  bot.setControlState("jump", false);
}
