import { z } from "zod";
import { clearAreaInputSchema, workAreaPositions, SkillFault, type WorkPosition } from "@minecraft-studio/skills";

export type ClearCell = { name: string | null; safe: boolean };
export async function clearWorkArea(input: z.infer<typeof clearAreaInputSchema>, port: {
  assertActive(): void; inspect(position: WorkPosition): ClearCell; approach(position: WorkPosition): Promise<void>;
  dig(position: WorkPosition): Promise<void>; wait(): Promise<void>;
}) {
  const positions = workAreaPositions(input.area, true);
  const air = (name: string | null) => name !== null && ["air", "cave_air", "void_air"].includes(name);
  let broken = 0;
  for (let index = 0; index < positions.length; index++) {
    port.assertActive();
    if (index % 16 === 0) await port.wait();
    if (broken >= input.maxBlocks) break;
    const position = positions[index]!;
    const before = port.inspect(position);
    if (!before.name || air(before.name) || !before.safe || !input.blockNames.includes(before.name)) continue;
    await port.approach(position); port.assertActive();
    const fresh = port.inspect(position);
    if (fresh.name !== before.name || !fresh.safe) continue;
    await port.dig(position); port.assertActive();
    if (!air(port.inspect(position).name)) throw new SkillFault("CLEAR_READBACK_MISMATCH");
    broken++;
  }
  let remaining = 0, unknown = 0, blocked = 0;
  for (let index = 0; index < positions.length; index++) {
    if (index % 16 === 0) { await port.wait(); port.assertActive(); }
    const cell = port.inspect(positions[index]!);
    if (cell.name === null) unknown++;
    else if (!air(cell.name)) {
      remaining++;
      if (!cell.safe || !input.blockNames.includes(cell.name)) blocked++;
    }
  }
  const completed = remaining === 0 && unknown === 0;
  return { completed, status: completed ? "AREA_CLEAR" as const : unknown > 0 ? "WAITING_OBSERVATION" as const
    : blocked > 0 ? "BLOCKED" as const : "BATCH_LIMIT" as const,
    broken, remaining, unknown, blocked, observedAt: new Date().toISOString() };
}
