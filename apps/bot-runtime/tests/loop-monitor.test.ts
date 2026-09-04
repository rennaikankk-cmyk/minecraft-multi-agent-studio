// Phase 2 单测：旋钮严格解析（门语义对齐 === "1"，无效值显式降级）。
import { describe, expect, it } from "vitest";
import { probeBooleanKnob } from "../src/loop-monitor.js";

describe("probeBooleanKnob", () => {
  it('enables only on exactly "1"', () => {
    expect(probeBooleanKnob("1")).toEqual({ effective: true, source: "env", raw: "1", invalid: false });
  });

  it('disables on "0", empty and unset without flagging invalid', () => {
    expect(probeBooleanKnob("0")).toMatchObject({ effective: false, source: "env", invalid: false });
    expect(probeBooleanKnob("")).toMatchObject({ effective: false, source: "env", invalid: false });
    expect(probeBooleanKnob(undefined)).toEqual({ effective: false, source: "default", raw: null, invalid: false });
  });

  it("flags plausible-but-wrong values as invalid degradation (typo visibility)", () => {
    for (const bad of ["true", "yes", "on", "enabled", " 1 ", "TRUE"]) {
      const probed = probeBooleanKnob(bad);
      expect(probed.effective, bad).toBe(false);
      expect(probed.invalid, bad).toBe(true);
    }
  });
});

// Phase 2a 回归（§9）：编程错误不得伪装成可重试寻路失败。
// ESM 事故病理：ReferenceError 被包装成 PATHFINDER_GOTO_FAILED →
// 三连 transient 重试。现在意外异常走 MOVEMENT_INTERNAL_ERROR/CONTRACT_BUG。
import { classifyFailure } from "@minecraft-studio/skills";

describe("movement error taxonomy regression", () => {
  it("programming errors are CONTRACT_BUG, not transient-retryable", () => {
    expect(classifyFailure("MOVEMENT_INTERNAL_ERROR").category).toBe("CONTRACT_BUG");
  });

  it("genuine pathfinder rejections (NoPath family) stay transient for chunk catch-up", () => {
    expect(classifyFailure("PATHFINDER_GOTO_FAILED").category).toBe("TRANSIENT");
  });

  it("rust route codes carry their own semantics instead of collapsing to GOTO_FAILED", () => {
    expect(classifyFailure("RUST_PATH_NOT_FOUND").category).toBe("OUT_OF_REACH");
    expect(classifyFailure("RUST_PATH_STUCK").category).toBe("STALE_WORLD");
    expect(classifyFailure("RUST_PATH_NO_STATS").category).toBe("CONTRACT_BUG");
  });
});
