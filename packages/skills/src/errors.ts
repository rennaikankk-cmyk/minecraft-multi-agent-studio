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

export class SkillFault extends Error {
  readonly code: string;

  constructor(code: string, message = "Skill execution failed.") {
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
