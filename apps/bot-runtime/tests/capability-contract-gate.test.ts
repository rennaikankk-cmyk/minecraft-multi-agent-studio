import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import minecraftData from "minecraft-data";

import {
  builtinSkills,
  SkillRegistry,
  type SkillCompatibilityEnvironment,
} from "@minecraft-studio/skills";

// ---------------------------------------------------------------------------
// 契约闸 G3：registered Skill 的 requiredCapabilities 必须有 runtime 能力分发。
// 反面事故：mineflayer-client 若删掉一个 operation，技能要到运行期才以
// SKILL_CAPABILITY_UNAVAILABLE 暴露——本闸让它在 CI 就红。
// 用 SkillRegistry.listCompatibility（生产同源）解析 portable 变体。
// ---------------------------------------------------------------------------

// 能力分发分布在 mineflayer-client 与 runtime（combat.control 等在 runtime 层拦截）
const RUNTIME_SOURCES = ["mineflayer-client.ts", "runtime.ts"]
  .map((file) =>
    readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", file), "utf8"),
  )
  .join("\n");

const data = minecraftData("1.21.11");
const resources = { item: data.itemsByName, block: data.blocksByName, entity: data.entitiesByName };
const TEST_ENVIRONMENT: SkillCompatibilityEnvironment = {
  minecraftVersion: "1.21.11",
  protocolVersion: 774,
  supportsFeature: () => undefined,
  hasResource: (kind, name) => Object.hasOwn(resources[kind], name),
  serverCapability: () => undefined,
};

describe("contract gate G3 — skill capabilities have runtime dispatchers", () => {
  const registry = new SkillRegistry();
  for (const skill of builtinSkills) registry.register(skill);

  it("every builtin skill resolves available under a representative environment", () => {
    const resolutions = registry.listCompatibility(TEST_ENVIRONMENT);
    const available = new Set(
      resolutions.filter((r) => r.availability === "available").map((r) => r.skillId),
    );
    for (const skill of builtinSkills) {
      expect(available.has(skill.id), skill.id).toBe(true);
    }
  });

  it.each([false, undefined])("keeps elytra unavailable when its resource is %s", (present) => {
    const resolution = registry.listCompatibility({ ...TEST_ENVIRONMENT, hasResource: () => present })
      .find((entry) => entry.skillId === "movement.elytra");
    expect(resolution?.availability).toBe("unavailable");
  });

  for (const skill of builtinSkills) {
    it(`${skill.id}: capabilities [${skill.requiredCapabilities.join(", ")}] dispatched`, () => {
      for (const capability of skill.requiredCapabilities as readonly string[]) {
        expect(RUNTIME_SOURCES).toContain(`"${capability}"`);
      }
    });
  }
});
