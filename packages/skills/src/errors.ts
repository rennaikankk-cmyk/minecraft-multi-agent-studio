import { skillErrorCodeSchema } from "@minecraft-studio/protocol";

export type SkillFrameworkErrorCode =
  | "INVALID_SKILL_DEFINITION"
  | "DUPLICATE_SKILL_VERSION"
  | "INVALID_SKILL_INVOCATION";

export class SkillFrameworkError extends Error {
  readonly code: SkillFrameworkErrorCode;

  constructor(code: SkillFrameworkErrorCode, message: string) {
    super(message);
    this.name = "SkillFrameworkError";
    this.code = code;
  }
}

/**
 * `SkillFault` 不带说明时的占位文本。诊断侧要能把它和真正的原因区分开：
 * 它读起来像一句解释，实际什么都没说，当成 reason 记下去就是凭空造证据。
 */
export const SKILL_FAULT_DEFAULT_MESSAGE = "Skill execution failed.";

export class SkillFault extends Error {
  readonly code: string;

  constructor(code: string, message = SKILL_FAULT_DEFAULT_MESSAGE) {
    skillErrorCodeSchema.parse(code);
    super(message);
    this.name = "SkillFault";
    this.code = code;
  }
}

export class SkillAbortError extends SkillFault {
  constructor(code: "SKILL_CANCELLED" | "SKILL_TIMEOUT") {
    super(code, code === "SKILL_TIMEOUT" ? "Skill timed out." : "Skill cancelled.");
    this.name = "SkillAbortError";
  }
}
