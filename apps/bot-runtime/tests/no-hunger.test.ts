import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import {
  attachNoHunger,
  NoHungerCapabilityMemory,
  type NoHungerBot,
  resolveNoHungerConfig,
} from "../src/no-hunger.js";
import { serverProfileSchema } from "../src/server-profile.js";

type WriteRecord = Readonly<{ name: string; payload: unknown }>;

class FakeWireClient extends EventEmitter {
  readonly writes: WriteRecord[] = [];

  write(name: string, payload: unknown): void {
    this.writes.push({ name, payload });
  }
}

class FakeBot extends EventEmitter {
  readonly _client = new FakeWireClient();
  readonly controls = new Map<string, boolean>([["forward", true]]);
  entity = {
    id: 7,
    onGround: true,
    isInWater: false,
    isInLava: false,
    elytraFlying: false,
    velocity: { y: 0 },
  };
  targetDigBlock: unknown = null;
  vehicle: unknown = null;

  getControlState(control: string): boolean {
    return this.controls.get(control) === true;
  }
}

function createHarness(
  input: Readonly<{
    now?: number;
    config?: { enabled?: boolean; mode?: "adaptive" | "maximum" };
    serverKey?: string;
    memory?: NoHungerCapabilityMemory;
  }> = {},
) {
  let now = input.now ?? 0;
  const bot = new FakeBot();
  const controller = attachNoHunger(bot as unknown as NoHungerBot, {
    config: input.config,
    serverKey: input.serverKey ?? "server-a",
    now: () => now,
    capabilityMemory: input.memory ?? new NoHungerCapabilityMemory(),
  });
  bot.emit("spawn");
  return {
    bot,
    controller,
    setNow(value: number) {
      now = value;
    },
  };
}

function movementPayload(onGround = true) {
  return {
    x: 1,
    y: 64,
    z: 1,
    onGround,
    flags: { onGround, hasHorizontalCollision: false },
  };
}

describe("NoHunger", () => {
  it("is enabled in adaptive mode when the profile omits configuration", () => {
    expect(resolveNoHungerConfig(undefined)).toEqual({
      enabled: true,
      mode: "adaptive",
    });
  });

  it("accepts a bounded per-server override and rejects unknown settings", () => {
    const base = {
      schemaVersion: "1.0",
      id: "local-isolated-test",
      botId: "studio-bot-01",
      purpose: "isolated-test",
      networkScope: "loopback",
      host: "127.0.0.1",
      port: 25565,
      minecraftVersion: "1.21.8",
      username: "StudioBot",
      auth: "offline",
      statusIntervalMs: 1_000,
      heartbeatIntervalMs: 5_000,
      stopGracePeriodMs: 5_000,
      reconnect: {
        enabled: true,
        maxAttempts: 5,
        baseDelayMs: 2_000,
        maxDelayMs: 30_000,
      },
    } as const;

    expect(
      serverProfileSchema.safeParse({
        ...base,
        noHunger: { enabled: true, mode: "adaptive" },
      }).success,
    ).toBe(true);
    expect(
      serverProfileSchema.safeParse({
        ...base,
        noHunger: { enabled: true, packetMagic: 42 },
      }).success,
    ).toBe(false);
  });

  it("spoofs both legacy and 1.21.3+ ground fields on safe movement", () => {
    const { bot, controller } = createHarness();

    bot._client.write("position", movementPayload());

    expect(bot._client.writes).toHaveLength(1);
    expect(bot._client.writes[0]).toEqual({
      name: "position",
      payload: {
        ...movementPayload(false),
        flags: { onGround: false, hasHorizontalCollision: false },
      },
    });
    expect(controller.snapshot()).toMatchObject({
      stage: "maximum",
      spoofedGroundPackets: 1,
    });
  });

  it("does not spoof a landing, fluid, vertical motion, digging, or look-only packet", () => {
    const { bot, controller } = createHarness();

    bot.entity.onGround = false;
    bot.entity.velocity.y = -0.2;
    bot._client.write("position", movementPayload(false));
    bot.entity.onGround = true;
    bot.entity.velocity.y = 0;
    bot._client.write("position", movementPayload(true));

    bot.entity.isInWater = true;
    bot._client.write("position", movementPayload(true));
    bot.entity.isInWater = false;
    bot.targetDigBlock = { name: "stone" };
    bot._client.write("position_look", movementPayload(true));
    bot.targetDigBlock = null;
    bot._client.write("look", { yaw: 0, pitch: 0, onGround: true });

    expect(controller.snapshot().spoofedGroundPackets).toBe(0);
    expect(bot._client.writes.map((entry) => entry.payload)).toEqual([
      movementPayload(false),
      movementPayload(true),
      movementPayload(true),
      movementPayload(true),
      { yaw: 0, pitch: 0, onGround: true },
    ]);
  });

  it("suppresses a balanced sprint pair and resynchronizes on degradation", () => {
    const { bot, controller } = createHarness();
    const start = { entityId: 7, actionId: "start_sprinting", jumpBoost: 0 };

    bot._client.write("entity_action", start);
    expect(bot._client.writes).toHaveLength(0);

    controller.observeServerSignal("Grim: GroundSpoof violation", "message");

    expect(controller.snapshot()).toMatchObject({
      stage: "ground-only",
      transitionReason: "anticheat-message",
      suppressedSprintPackets: 1,
    });
    expect(bot._client.writes).toEqual([{ name: "entity_action", payload: start }]);

    const stop = { entityId: 7, actionId: "stop_sprinting", jumpBoost: 0 };
    bot._client.write("entity_action", stop);
    expect(bot._client.writes.at(-1)).toEqual({
      name: "entity_action",
      payload: stop,
    });
  });

  it("degrades after correlated server setbacks and remembers the server", () => {
    const memory = new NoHungerCapabilityMemory();
    const first = createHarness({ memory, serverKey: "grim-server" });
    first.setNow(6_000);
    first.bot._client.write("position", movementPayload());
    first.setNow(6_100);
    first.bot._client.emit("position", {});
    first.setNow(6_200);
    first.bot._client.emit("position", {});

    expect(first.controller.snapshot()).toMatchObject({
      stage: "ground-only",
      transitionReason: "server-setback",
      observedSetbacks: 2,
    });

    const second = createHarness({ memory, serverKey: "grim-server" });
    expect(second.controller.snapshot()).toMatchObject({
      stage: "ground-only",
      transitionReason: "remembered-server-capability",
    });
  });

  it("uses a low-duty pulse after repeated detection", () => {
    const { bot, controller } = createHarness({ serverKey: "strict-server" });
    controller.observeServerSignal("AntiCheat violation", "message");
    controller.observeServerSignal("AntiCheat violation", "message");
    expect(controller.snapshot().stage).toBe("pulse");

    for (let packet = 0; packet < 220; packet += 1) {
      bot._client.write("position", movementPayload());
    }

    const spoofed = controller.snapshot().spoofedGroundPackets;
    expect(spoofed).toBeGreaterThanOrEqual(1);
    expect(spoofed).toBeLessThan(4);
  });

  it("falls back to vanilla after a correlated kick", () => {
    const { bot, controller, setNow } = createHarness();
    setNow(6_000);
    bot._client.write("position", movementPayload());
    setNow(6_500);
    bot.emit("kicked", "Disconnected");
    bot._client.write("position", movementPayload());

    expect(controller.snapshot()).toMatchObject({
      stage: "vanilla",
      transitionReason: "anticheat-kick",
    });
    expect(bot._client.writes.at(-1)?.payload).toEqual(movementPayload(true));
  });

  it("allows an explicit maximum mode and a complete disable", () => {
    const maximum = createHarness({ config: { mode: "maximum" } });
    maximum.controller.observeServerSignal("Grim violation", "message");
    expect(maximum.controller.snapshot().stage).toBe("maximum");

    const disabled = createHarness({ config: { enabled: false } });
    disabled.bot._client.write("position", movementPayload());
    expect(disabled.controller.snapshot().stage).toBe("vanilla");
    expect(disabled.bot._client.writes[0]?.payload).toEqual(movementPayload());
  });

  it("restores the original writer and removes interception on stop", () => {
    const { bot, controller } = createHarness();
    controller.stop();
    bot._client.write("position", movementPayload());

    expect(bot._client.writes[0]?.payload).toEqual(movementPayload());
  });
});
