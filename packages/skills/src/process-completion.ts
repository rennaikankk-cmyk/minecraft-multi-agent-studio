import { farmMaintainOutputSchema } from "./farm-maintenance.js";
import { clearAreaOutputSchema, exploreOutputSchema, followEntityOutputSchema } from "./baritone-processes.js";

/** Transport completion means the bounded call returned, not that its world objective is satisfied. */
export function processContinuationCode(skillId: string, output: unknown): string | null {
  if (skillId === "farm.maintain") {
    const result = farmMaintainOutputSchema.parse(output);
    return result.status === "PASS_COMPLETE" ? null : `PROCESS_${result.status}`;
  }
  const schema = skillId === "build.clear-area" ? clearAreaOutputSchema : skillId === "world.explore" ? exploreOutputSchema
    : skillId === "movement.follow" ? followEntityOutputSchema : null;
  if (!schema) return null;
  const result = schema.parse(output);
  return result.completed ? null : `PROCESS_${result.status}`;
}
