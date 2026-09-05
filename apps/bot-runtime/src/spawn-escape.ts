import { setTimeout as delay } from "node:timers/promises";
import { MOVEMENT_PRIORITIES, type MovementController } from "@minecraft-studio/skills";

export type EscapePosition = Readonly<{ x: number; z: number; dimension: string }>;
export type EscapeOutcome = "escaped" | "timed_out" | "stalled" | "cancelled" | "scope_changed" | "movement_busy";

export async function runSpawnEscape(port: {
  movement: MovementController;
  position(): EscapePosition | null;
  look(yaw: number): Promise<void>;
  sprint(): void;
}, input: {
  origin: EscapePosition;
  distance: number;
  bearingDeg: number;
  durationMs: number;
  signal: AbortSignal;
}): Promise<EscapeOutcome> {
  const lease = port.movement.acquire({ owner: "spawn-escape", priority: MOVEMENT_PRIORITIES.ESCAPE, signal: input.signal });
  if (!lease) return "movement_busy";
  const started = performance.now();
  let lastProgress = started;
  let farthest = 0;
  try {
    const rad = input.bearingDeg * Math.PI / 180;
    await port.look(Math.atan2(-Math.cos(rad), Math.sin(rad)));
    lease.assertCurrent();
    port.sprint();
    while (lease.isCurrent()) {
      const at = port.position();
      if (!at || at.dimension !== input.origin.dimension) return "scope_changed";
      const distance = Math.hypot(at.x - input.origin.x, at.z - input.origin.z);
      if (distance >= input.distance) return "escaped";
      const now = performance.now();
      if (distance > farthest + 1) { farthest = distance; lastProgress = now; }
      if (now - started >= input.durationMs) return "timed_out";
      if (now - lastProgress >= 5_000) return "stalled";
      await delay(100, undefined, { signal: lease.signal });
    }
    return "cancelled";
  } catch (error) {
    if (lease.signal.aborted) return "cancelled";
    throw error;
  } finally {
    // Arbiter cleanup runs synchronously only for the current token.
    lease.release("spawn-escape-finished");
  }
}
