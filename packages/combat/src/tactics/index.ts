// ---------------------------------------------------------------------------
// tactics/ —— 战术决策核心（研究轮产物 docs/research/PVP_SYSTEM_RESEARCH.md §7-§17）。
//
// 零 AI、零 mineflayer、纯函数：Reflex FSM（既有 R 档）之上加"比较器层"——
// belief（区间血量）→ utility（18 动作有界评分）→ selector（滞回/承诺）→
// evidence（确定性解释）。生产接线由 feature flag 控制（默认关），
// 未校准 profile（tactics-v0-uncalibrated）只允许在 PvP Lab 内生效。
// ---------------------------------------------------------------------------

export * from "./mechanics.js";
export * from "./profile.js";
export * from "./belief.js";
export * from "./snapshot.js";
export * from "./utility.js";
export * from "./selector.js";
export * from "./evidence.js";
