/**
 * CombatSurvivalStance —— 一个 bot 的存活立场。零 AI，纯配置。
 *
 * 这个类型存在的原因：「没有图腾就撤退」原本硬编码在 TotemManager、
 * RetreatController、TargetSelector 三处，于是一个**本就被设计成可弃**的 bot
 * （只穿铁甲、从不带图腾、允许死亡）会被永久钉在撤退状态，一枪都开不出来。
 * 与其在三个模块各加一个语义相同、命名不同的布尔开关，不如把「这个 bot 允不
 * 允许死」这一个概念定义一次，三个模块共同消费。
 *
 * 纪律：
 *   1. **默认必须是 `preserve-life`**。保命是默认值而不是可选项；只有运维显式
 *      声明 `expendable` 才放开。缺省即保命，配置错了也偏向活着。
 *   2. `expendable` **只放开图腾这一条轴**。生命阈值、寡不敌众、水晶自伤红线
 *      一概不受影响 —— 那些各自有独立的数值旋钮，被一个立场悄悄一起关掉会很
 *      意外。水晶自伤红线尤其不受任何立场影响（见 crystal-engine.ts 头部）：
 *      「可以死」不等于「可以自杀」，前者是接受战损，后者是白给。
 *   3. 立场是**人给的配置**，不是 AI 能推断的结论（AGENTS.md §0.2）。AI 只能在
 *      既有立场下调阈值，不能自己把 bot 改成可弃的。
 */

export type CombatSurvivalStance =
  /** 保命优先：无图腾即失败降级，立即撤退。 */
  | "preserve-life"
  /** 可弃：无图腾属于正常状态，允许在没有图腾的情况下继续交战直到死亡。 */
  | "expendable"
  /**
   * 主动出击：expendable 的全部语义 + 更低的交战门槛（4 血才收手、
   * 敌对数不再设限）。无规则服对开挂对手的进攻性立场，由神谕或
   * 运维显式切换，不是默认。
   */
  | "aggressive";

export const DEFAULT_SURVIVAL_STANCE: CombatSurvivalStance = "preserve-life";

/**
 * 该立场是否把「完全没有图腾」当成必须撤退的紧急状态。
 * 三个模块都走这一个判定，避免各自 `=== "expendable"` 写歪。
 */
export function totemAbsenceForcesRetreat(
  stance: CombatSurvivalStance,
): boolean {
  return stance === "preserve-life";
}

/** 主动出击立场：交战阈值全面压低（TargetSelector/RetreatController 消费）。 */
export function isAggressiveStance(stance: CombatSurvivalStance): boolean {
  return stance === "aggressive";
}

export function validateSurvivalStance(
  stance: CombatSurvivalStance,
): CombatSurvivalStance {
  if (
    stance !== "preserve-life" &&
    stance !== "expendable" &&
    stance !== "aggressive"
  ) {
    throw new TypeError("存活立场只能是 preserve-life、expendable 或 aggressive。");
  }
  return stance;
}
