import { MovementController, MOVEMENT_PRIORITIES } from "@minecraft-studio/skills";
import { describe, expect, it, vi } from "vitest";
import { runSpawnEscape, type EscapePosition } from "../src/spawn-escape.js";

function setup() {
  const clear = vi.fn();
  const movement = new MovementController({ onRelease: clear, onPreempt: clear });
  const origin = { x: 0, z: 0, dimension: "minecraft:overworld" };
  let position: EscapePosition | null = { ...origin };
  const controller = new AbortController();
  const port = { movement, position: () => position, look: vi.fn(async () => undefined), sprint: vi.fn() };
  const input = { origin, distance: 96, bearingDeg: 135, durationMs: 20_000, signal: controller.signal };
  return { port, input, clear, controller, setPosition: (value: EscapePosition | null) => { position = value; } };
}

describe("spawn escape ownership", () => {
  it("does not clear the replacement movement after preemption", async () => {
    const s = setup();
    const pending = runSpawnEscape(s.port, s.input);
    await Promise.resolve();
    const replacement = s.port.movement.require({ owner: "L0", priority: MOVEMENT_PRIORITIES.EMERGENCY });
    const cleanups = s.clear.mock.calls.length;
    expect(await pending).toBe("cancelled");
    expect(s.clear).toHaveBeenCalledTimes(cleanups);
    expect(replacement.isCurrent()).toBe(true);
    replacement.release();
  });

  it("cancels during look without installing stale controls", async () => {
    const s = setup();
    const pending = runSpawnEscape(s.port, s.input);
    s.controller.abort();
    expect(await pending).toBe("cancelled");
    expect(s.port.sprint).not.toHaveBeenCalled();
  });

  it.each([null, { x: 0, z: 0, dimension: "minecraft:the_nether" }])("stops when connection or dimension changes", async (position) => {
    const s = setup();
    s.setPosition(position);
    expect(await runSpawnEscape(s.port, s.input)).toBe("scope_changed");
    expect(s.port.movement.currentLease()).toBeNull();
  });

  it("reports escape only from observed distance", async () => {
    const s = setup();
    s.setPosition({ ...s.input.origin, x: 97 });
    expect(await runSpawnEscape(s.port, s.input)).toBe("escaped");
    s.setPosition({ ...s.input.origin });
    expect(await runSpawnEscape(s.port, { ...s.input, durationMs: 0 })).toBe("timed_out");
  });
});
