import { describe, expect, it } from "vitest";

import { builtinSkills } from "@minecraft-studio/skills";

import { LOCAL_PLANNER_PROMPT_VERSION, LOCAL_PLANNER_SYSTEM_PROMPT } from "../src/planner-prompts.js";

// ---------------------------------------------------------------------------
// 契约闸 G1：prompt 明确引用的技能必须真实存在于 advertised catalog。
// 事故背景：v12 prompt 两条规则要求模型选择 goal.ensure-item——一个从未注册
// 的技能；模型永远无法满足，物品目标的引导自相矛盾（v13 已改为 plan_items
// 归属声明）。本闸保证再出现"prompt 提及未挂牌技能"时测试直接红。
// ---------------------------------------------------------------------------

describe("contract gate G1 — prompt skill references exist in the advertised catalog", () => {
  const catalogIds = new Set(builtinSkills.map((skill) => skill.id));

  it("every dotted skill id mentioned in the system prompt is advertised", () => {
    // 抓 prompt 文本里的技能形态 id（family.name）；排除占位/否定语境的
    // 显式禁止列表由负向断言覆盖。
    const mentioned = [...LOCAL_PLANNER_SYSTEM_PROMPT.matchAll(/\b([a-z]+(?:\.[a-z-]+)+)\b/gu)]
      .map((match) => match[1]!)
      .filter((id) => !id.startsWith("minecraft:"));
    const unique = [...new Set(mentioned)];
    const missing = unique.filter((id) => !catalogIds.has(id));
    // 允许的例外必须显式列出并给出理由；出现新例外时人工确认后加入。
    const allowedNonSkill = new Set([
      // 协议/文档形态词，不是技能引用
      "e.g", "no.op", "bot.inventory",
    ]);
    const unexplained = missing.filter((id) => !allowedNonSkill.has(id));
    expect(unexplained).toEqual([]);
  });

  it("prompt no longer instructs the model to select goal.ensure-item (dead skill removed)", () => {
    expect(LOCAL_PLANNER_SYSTEM_PROMPT).not.toContain("goal.ensure-item");
  });

  it("prompt version was bumped with the semantic change", () => {
    expect(LOCAL_PLANNER_PROMPT_VERSION).toBe("minecraft-local-planner-v13");
  });
});
