// ---------------------------------------------------------------------------
// MeleeController —— 战斗局部移动控制（追击防抽搐）。
//
// 学习来源（MIT，思想与结构直接借鉴 Minecraft-PVP-ROBO）：
//   战斗期间完全不碰 pathfinder——每控制帧（100ms）直接设置
//   forward/back/left/right/jump/sprint 控制位，超时自动清。
//   这从根上消灭 cancel path → goto → cancel path 的抽搐。
//
// 距离带启发式（PVP-ROBO expert 策略同源）：
//   > 2.7 格  冲刺追击（forward + sprint）
//   1.2-2.7   步进接近（forward，不冲刺——防冲过头）
//   < 1.2 格  交替横移（8 帧 left/right 摆动 = strafe）
//   被贴脸    back + strafe 拉开距离
// ---------------------------------------------------------------------------

export type MeleeControlFrame = Readonly<{
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  sprint: boolean;
  jump: boolean;
}>;

export const IDLE_CONTROL_FRAME: MeleeControlFrame = Object.freeze({
  forward: false,
  back: false,
  left: false,
  right: false,
  sprint: false,
  jump: false,
});

export type MeleeMovementContext = Readonly<{
  distance: number;
  /** 目标水平速度（判断对方是否在跑）。 */
  targetSpeed: number;
  /** 自身血量（低血偏好拉开距离）。 */
  health: number;
  /** strafe 相位（由调用方维护的帧计数器驱动交替）。 */
  frameIndex: number;
}>;

/**
 * 距离带控制帧决策（纯函数）。每 100ms 调用一次，结果直接写
 * bot.setControlState。
 */
export function meleeControlFrame(
  context: MeleeMovementContext,
): MeleeControlFrame {
  const strafePhase = Math.floor(context.frameIndex / 8) % 2 === 0;
  if (context.distance > 2.7) {
    // 追击：冲刺 + 前进。目标也在跑时加小幅 strafe 预判走位。
    return Object.freeze({
      forward: true,
      back: false,
      left: context.targetSpeed > 0.2 && strafePhase,
      right: context.targetSpeed > 0.2 && !strafePhase,
      sprint: true,
      jump: false,
    });
  }
  if (context.distance > 1.2) {
    // 步进接近：不冲刺防冲过头，保持 strafe。
    return Object.freeze({
      forward: true,
      back: false,
      left: strafePhase,
      right: !strafePhase,
      sprint: false,
      jump: false,
    });
  }
  if (context.health < 8) {
    // 低血贴脸：后撤 + strafe 拉开。
    return Object.freeze({
      forward: false,
      back: true,
      left: strafePhase,
      right: !strafePhase,
      sprint: false,
      jump: false,
    });
  }
  // 正常贴脸 Combo：交替 strafe + 保持贴脸。
  return Object.freeze({
    forward: false,
    back: false,
    left: strafePhase,
    right: !strafePhase,
    sprint: false,
    jump: false,
  });
}

/** 控制帧周期（ms）。与 PVP-ROBO 的 actionRepeatTicks=2 一致。 */
export const MELEE_CONTROL_FRAME_MS = 100;

/** 应用一帧控制位到 bot，返回清理函数（帧超时后清空全部控制）。 */
export function applyMeleeControlFrame(
  bot: {
    setControlState: (name: string, state: boolean) => void;
    clearControlStates: () => void;
  },
  frame: MeleeControlFrame,
): () => void {
  bot.setControlState("forward", frame.forward);
  bot.setControlState("back", frame.back);
  bot.setControlState("left", frame.left);
  bot.setControlState("right", frame.right);
  bot.setControlState("sprint", frame.sprint);
  if (frame.jump) bot.setControlState("jump", true);
  let cleared = false;
  return () => {
    if (cleared) return;
    cleared = true;
    bot.clearControlStates();
  };
}
