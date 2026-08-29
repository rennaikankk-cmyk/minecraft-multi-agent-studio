// ---------------------------------------------------------------------------
// WTapEngine —— 冲刺重置（W-Tap / S-Tap）自研实现。
//
// 三个参考项目都没有真正的 sprint reset（AstraPlus 只有全向疾跑），
// 本文件基于原版机制自研：
//
// 原版机制：攻击命中时，如果攻击者正在 sprint，被击者获得大幅击退
// （KB）。"W-Tap" = 在攻击前一瞬间松开 W（停止前进输入）→ 命中时非
// sprint 状态 → 被击者击退减小 → 攻击者不被弹开，保持贴脸连击。
// "S-Tap" = 攻击瞬间短暂按 S（后退）→ 主动贴回目标。
//
// 本实现把 W-Tap 做成"攻击前置动作"：在 MELEE_ATTACK 的 priming 阶段，
// 按策略短暂松开 forward（2 tick = 100ms），攻击后立即恢复。
// ---------------------------------------------------------------------------

export type WTapStrategy = "NONE" | "W_TAP" | "S_TAP";

export type WTapContext = Readonly<{
  /** 自身血量（低血不用 S-Tap——会把自己往目标脸上送）。 */
  health: number;
  /** 目标距离（远距离不用 W-Tap——需要持续追击速度）。 */
  targetDistance: number;
  /** 是否在 Combo 中（连续命中——W-Tap 保持 KB 压制的核心场景）。 */
  inCombo: boolean;
}>;

/**
 * 策略选择（纯函数）：
 * - 贴脸 Combo 中 → W_TAP（减少自身被弹开）
 * - 被贴脸且血量健康 → S_TAP（主动贴住对方）
 * - 远距离追击 / 低血 → NONE（不干预移动输入）
 */
export function selectWTapStrategy(context: WTapContext): WTapStrategy {
  if (context.inCombo && context.targetDistance < 2.0) {
    return "W_TAP";
  }
  if (context.targetDistance < 1.0 && context.health >= 10) {
    return "S_TAP";
  }
  return "NONE";
}

/** W-Tap 松开时长（ms）：2 tick。 */
export const W_TAP_RELEASE_MS = 100;

/** S-Tap 按住时长（ms）：1 tick。 */
export const S_TAP_PRESS_MS = 50;

/**
 * 执行 W-Tap 前置（在攻击前调用）：
 * - W_TAP: 松开 forward（clearControlState("forward")），等待释放窗
 * - S_TAP: 短暂按 back
 * 返回恢复函数（攻击完成后调用，恢复 forward=true）。
 */
export function primeWTap(
  bot: {
    setControlState: (name: string, state: boolean) => void;
  },
  strategy: WTapStrategy,
): () => void {
  if (strategy === "NONE") return () => undefined;
  if (strategy === "W_TAP") {
    bot.setControlState("forward", false);
    return () => bot.setControlState("forward", true);
  }
  // S_TAP
  bot.setControlState("back", true);
  return () => bot.setControlState("back", false);
}
