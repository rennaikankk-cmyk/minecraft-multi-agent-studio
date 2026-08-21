import { describe, expect, it } from "vitest";

import {
  CombatIdentityError,
  CombatIdentityRegistry,
  type CombatEntity,
  type CombatWhitelistSource,
} from "../src/identity.js";

const SERVER = "local-isolated-test";
const TEAMMATE_UUID = "8f5a1c2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";

function source(
  overrides: Partial<CombatWhitelistSource> = {},
): CombatWhitelistSource {
  return {
    provenance: "operator-config",
    serverProfileId: SERVER,
    selfUsername: "StudioBot",
    usernames: ["Renna"],
    uuids: [TEAMMATE_UUID],
    ...overrides,
  };
}

function entity(overrides: Partial<CombatEntity> = {}): CombatEntity {
  return {
    entityId: 1,
    kind: "player",
    username: "Stranger",
    uuid: null,
    ...overrides,
  };
}

describe("CombatIdentityRegistry", () => {
  it("treats every player outside the whitelist as hostile", () => {
    const registry = CombatIdentityRegistry.fromOperatorConfig(source());
    expect(registry.classify(entity(), SERVER)).toBe("hostile");
    expect(registry.isHostile(entity(), SERVER)).toBe(true);
  });

  it("recognises the whitelist by case-folded username and by UUID", () => {
    const registry = CombatIdentityRegistry.fromOperatorConfig(source());
    // 白名单写 "Renna"，进来的是 "renna" —— 大小写不能造成误伤。
    expect(registry.classify(entity({ username: "renna" }), SERVER)).toBe(
      "whitelisted",
    );
    // UUID 去连字符写法等价。
    expect(
      registry.classify(
        entity({ username: null, uuid: TEAMMATE_UUID.replaceAll("-", "") }),
        SERVER,
      ),
    ).toBe("whitelisted");
    expect(registry.classify(entity({ username: "StudioBot" }), SERVER)).toBe(
      "self",
    );
    expect(registry.whitelistSize).toBe(2);
  });

  it("classifies mobs deterministically and unknown kinds as hostile", () => {
    const registry = CombatIdentityRegistry.fromOperatorConfig(source());
    expect(
      registry.classify(entity({ kind: "monster", username: null }), SERVER),
    ).toBe("hostile");
    expect(
      registry.classify(entity({ kind: "animal", username: null }), SERVER),
    ).toBe("neutral");
    expect(
      registry.classify(entity({ kind: "object", username: null }), SERVER),
    ).toBe("neutral");
    // 认不出类型不是"无害"：fail-closed 到敌对。
    expect(
      registry.classify(entity({ kind: "unknown", username: null }), SERVER),
    ).toBe("hostile");
    // 用户名与 UUID 全缺的玩家无法核实身份，同样敌对。
    expect(
      registry.classify(entity({ username: null, uuid: null }), SERVER),
    ).toBe("hostile");
  });

  it("refuses any whitelist that is not explicitly operator-configured", () => {
    expect(() =>
      CombatIdentityRegistry.fromOperatorConfig(
        source({
          provenance: "model-inferred" as CombatWhitelistSource["provenance"],
        }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "WHITELIST_PROVENANCE_REJECTED" }),
    );
  });

  it("rejects the whole whitelist when a single entry is malformed", () => {
    expect(() =>
      CombatIdentityRegistry.fromOperatorConfig(
        source({ usernames: ["Renna", "no"] }),
      ),
    ).toThrowError(expect.objectContaining({ code: "WHITELIST_ENTRY_INVALID" }));
    expect(() =>
      CombatIdentityRegistry.fromOperatorConfig(source({ uuids: ["zzzz"] })),
    ).toThrowError(expect.objectContaining({ code: "WHITELIST_ENTRY_INVALID" }));
    expect(() =>
      CombatIdentityRegistry.fromOperatorConfig(source({ selfUsername: "" })),
    ).toThrowError(expect.objectContaining({ code: "WHITELIST_SELF_REQUIRED" }));
    expect(() =>
      CombatIdentityRegistry.fromOperatorConfig(
        source({ serverProfileId: "  " }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "WHITELIST_SERVER_PROFILE_REQUIRED" }),
    );
  });

  it("refuses to classify on a different server instead of guessing", () => {
    const registry = CombatIdentityRegistry.fromOperatorConfig(source());
    // 跨服不能默默把队友当敌人 —— 拒绝分类才是 fail-closed 的正确方向。
    let thrown: unknown;
    try {
      registry.classify(entity({ username: "Renna" }), "other-server");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CombatIdentityError);
    expect(thrown).toMatchObject({
      code: "IDENTITY_SERVER_PROFILE_MISMATCH",
    });
  });

  it("exposes no mutation path for the whitelist", () => {
    const registry = CombatIdentityRegistry.fromOperatorConfig(source());
    // AI 无权增删：注册表上不存在任何写入方法。
    for (const forbidden of ["add", "remove", "allow", "trust", "set"]) {
      expect(forbidden in registry).toBe(false);
    }
  });
});
