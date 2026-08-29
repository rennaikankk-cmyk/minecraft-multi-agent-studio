import { describe, expect, it } from "vitest";

import {
  inCriticalWindow,
  primeCritical,
  selectCriticalStrategy,
  type CriticalContext,
} from "../src/critical-engine.js";
import {
  IDLE_CONTROL_FRAME,
  meleeControlFrame,
} from "../src/melee-controller.js";

function context(overrides: Partial<CriticalContext> = {}): CriticalContext {
  return {
    pingMs: 50,
    selfSpeed: 0,
    targetDistance: 3,
    inCompromisedPhysics: false,
    targetMoving: false,
    ceilingAbove: false,
    allowPacketCrit: true,
    ...overrides,
  };
}

describe("selectCriticalStrategy", () => {
  it("never crits in compromised physics (water/ladder/web)", () => {
    expect(selectCriticalStrategy(context({ inCompromisedPhysics: true })))
      .toMatchObject({ strategy: "NO_CRIT", awaitFallWindow: false });
  });

  it("falls back to physical jump crit under high latency", () => {
    expect(selectCriticalStrategy(context({ pingMs: 200, selfSpeed: 0.3, targetMoving: true })))
      .toMatchObject({ strategy: "NORMAL_JUMP_CRIT" });
  });

  it("uses packet crit while chasing when allowed", () => {
    const outcome = selectCriticalStrategy(
      context({ selfSpeed: 0.25, targetMoving: true, targetDistance: 3.5 }),
    );
    expect(outcome).toMatchObject({ strategy: "PACKET_CRIT", awaitFallWindow: false });
  });

  it("downgrades to mini-jump when packet crit is not allowed", () => {
    const outcome = selectCriticalStrategy(
      context({ selfSpeed: 0.25, targetMoving: true, allowPacketCrit: false }),
    );
    expect(outcome).toMatchObject({ strategy: "MINI_JUMP_CRIT" });
  });

  it("uses mini-jump in point-blank combo range", () => {
    expect(selectCriticalStrategy(context({ targetDistance: 1.2 })))
      .toMatchObject({ strategy: "MINI_JUMP_CRIT" });
  });

  it("uses low-hop under a ceiling", () => {
    expect(selectCriticalStrategy(context({ ceilingAbove: true })))
      .toMatchObject({ strategy: "LOW_HOP_CRIT" });
  });

  it("defaults to the full jump crit", () => {
    expect(selectCriticalStrategy(context()))
      .toMatchObject({ strategy: "NORMAL_JUMP_CRIT", awaitFallWindow: true });
  });
});

describe("inCriticalWindow", () => {
  const bot = (over: Partial<{ onGround: boolean; vy: number }>) => ({
    entity: {
      onGround: over.onGround ?? false,
      velocity: { x: 0, y: over.vy ?? 0, z: 0 },
      position: { x: 0, y: 64, z: 0 },
    },
  });

  it("is true only while falling fast enough", () => {
    expect(inCriticalWindow(bot({ onGround: false, vy: -0.1 } as never) as never)).toBe(true);
    expect(inCriticalWindow(bot({ onGround: false, vy: 0 } as never) as never)).toBe(false);
    expect(inCriticalWindow(bot({ onGround: true, vy: -0.5 } as never) as never)).toBe(false);
    expect(inCriticalWindow({ entity: null } as never)).toBe(false);
  });
});

describe("primeCritical", () => {
  it("returns true immediately for NO_CRIT", () => {
    const bot = { entity: { position: { x: 0, y: 64, z: 0 }, velocity: { y: 0 }, onGround: true }, setControlState: () => undefined };
    expect(primeCritical(bot as never, "NO_CRIT")).toBe(true);
  });

  it("refuses to double-jump while airborne", () => {
    const bot = { entity: { position: { x: 0, y: 64, z: 0 }, velocity: { y: 0 }, onGround: false }, setControlState: () => undefined };
    expect(primeCritical(bot as never, "NORMAL_JUMP_CRIT")).toBe(false);
  });

  it("sets jump control and writes mini motion for MINI_JUMP_CRIT", () => {
    const calls: Array<[string, boolean]> = [];
    const velocity = { y: 0 };
    const bot = {
      entity: { position: { x: 0, y: 64, z: 0 }, velocity, onGround: true },
      setControlState: (name: string, state: boolean) => calls.push([name, state]),
    };
    expect(primeCritical(bot as never, "MINI_JUMP_CRIT")).toBe(true);
    expect(calls).toContainEqual(["jump", true]);
    expect(velocity.y).toBeCloseTo(0.05, 5);
  });

  it("writes the dual movement packets for PACKET_CRIT", () => {
    const writes: Array<[string, unknown]> = [];
    const bot = {
      entity: {
        position: { x: 1, y: 64, z: -2 },
        velocity: { y: 0 },
        onGround: true,
      },
      setControlState: () => undefined,
      _client: { write: (channel: string, payload: unknown) => writes.push([channel, payload]) },
    };
    expect(primeCritical(bot as never, "PACKET_CRIT")).toBe(true);
    expect(writes).toHaveLength(2);
    const first = writes[0]![1] as { y: number; onGround: boolean };
    const second = writes[1]![1] as { y: number; onGround: boolean };
    expect(first.y).toBeGreaterThan(64);
    expect(first.onGround).toBe(false);
    expect(second.y).toBe(64);
    expect(second.onGround).toBe(false);
  });
});

describe("meleeControlFrame", () => {
  it("sprints while chasing beyond 2.7 blocks", () => {
    const frame = meleeControlFrame({ distance: 3.5, targetSpeed: 0, health: 20, frameIndex: 0 });
    expect(frame).toMatchObject({ forward: true, sprint: true });
  });

  it("steps without sprint between 1.2 and 2.7", () => {
    const frame = meleeControlFrame({ distance: 2, targetSpeed: 0, health: 20, frameIndex: 0 });
    expect(frame).toMatchObject({ forward: true, sprint: false });
  });

  it("alternates strafe every 8 frames in point-blank", () => {
    const left = meleeControlFrame({ distance: 1, targetSpeed: 0, health: 20, frameIndex: 0 });
    const right = meleeControlFrame({ distance: 1, targetSpeed: 0, health: 20, frameIndex: 8 });
    expect(left.left || left.right).toBe(true);
    expect(right.left || right.right).toBe(true);
    expect(left.left).not.toBe(right.left);
  });

  it("backs off at low health in point-blank", () => {
    const frame = meleeControlFrame({ distance: 1, targetSpeed: 0, health: 6, frameIndex: 0 });
    expect(frame).toMatchObject({ back: true });
  });

  it("idle frame is all false", () => {
    expect(IDLE_CONTROL_FRAME.forward).toBe(false);
    expect(IDLE_CONTROL_FRAME.sprint).toBe(false);
  });
});
