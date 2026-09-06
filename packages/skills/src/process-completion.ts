import { farmMaintainOutputSchema } from "./farm-maintenance.js";
import { farmSustainOutputSchema } from "./farm-sustain.js";
import { clearAreaOutputSchema, exploreOutputSchema, followEntityOutputSchema } from "./baritone-processes.js";
import { packShulkerOutputSchema, storeSortOutputSchema } from "./planning/stock-levels.js";
import { containerTransferOutputSchema } from "./builtin/container-transfer.js";
import { secureFoodOutputSchema } from "./builtin/secure-food.js";

/** Transport completion means the bounded call returned, not that its world objective is satisfied. */
export function processContinuationCode(skillId: string, output: unknown): string | null {
  if (skillId === "food.secure") {
    const result = secureFoodOutputSchema.parse(output);
    return result.targetReached ? null : `PROCESS_${result.reasonCode}`;
  }
  if (skillId === "container.transfer") {
    const result = containerTransferOutputSchema.parse(output);
    return result.movedCount === result.requestedCount ? null : "PROCESS_DELIVERY_PARTIAL";
  }
  if (skillId === "store.sort" || skillId === "pack.shulker") {
    const result = (skillId === "store.sort" ? storeSortOutputSchema : packShulkerOutputSchema).parse(output);
    return result.completed ? null : "PROCESS_DELIVERY_PARTIAL";
  }
  if (skillId === "farm.sustain") {
    const result = farmSustainOutputSchema.parse(output);
    return result.status === "PASS_COMPLETE" ? null : `PROCESS_${result.status}`;
  }
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
