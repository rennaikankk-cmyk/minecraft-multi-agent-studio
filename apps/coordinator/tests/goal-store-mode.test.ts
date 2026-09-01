import { describe, expect, it } from "vitest";

import {
  assertGoalStoreWiring,
  GoalStoreWiringError,
  resolveGoalStoreMode,
} from "../src/goal-store-mode.js";
import { ControlLinkServer } from "../src/control-link-server.js";
import { InMemoryGoalLifecycleStore } from "../src/in-memory-goal-store.js";
import { BotRegistry } from "../src/bot-registry.js";

describe("resolveGoalStoreMode", () => {
  it("prefers the durable PostgreSQL store whenever persistence is configured", () => {
    expect(
      resolveGoalStoreMode({ hasPersistenceConfig: true, localMemoryMode: true }),
    ).toBe("postgresql");
  });

  it("uses local-memory only under the explicit offline fixture flag", () => {
    expect(
      resolveGoalStoreMode({ hasPersistenceConfig: false, localMemoryMode: true }),
    ).toBe("local-memory");
  });

  it("returns none when nothing is configured (never silently in-memory)", () => {
    expect(
      resolveGoalStoreMode({ hasPersistenceConfig: false, localMemoryMode: false }),
    ).toBe("none");
  });
});

describe("assertGoalStoreWiring", () => {
  it("fails closed with a structured code when a planner is assembled without a store", () => {
    expect(() =>
      assertGoalStoreWiring({ mode: "none", hasPlanner: true }),
    ).toThrowError(GoalStoreWiringError);
    try {
      assertGoalStoreWiring({ mode: "none", hasPlanner: true });
    } catch (cause) {
      expect(cause).toBeInstanceOf(GoalStoreWiringError);
      expect(cause.code).toBe("COORDINATOR_GOAL_STORE_REQUIRED");
      expect(cause.message).toContain("COORDINATOR_LOCAL_MEMORY_MODE");
    }
  });

  it("accepts planner plus a durable postgresql store (production)", () => {
    expect(
      assertGoalStoreWiring({ mode: "postgresql", hasPlanner: true }),
    ).toBe("postgresql");
  });

  it("accepts planner plus explicit local-memory (offline fixture only)", () => {
    expect(
      assertGoalStoreWiring({ mode: "local-memory", hasPlanner: true }),
    ).toBe("local-memory");
  });

  it("allows store-less assembly only when no planner is present", () => {
    expect(
      assertGoalStoreWiring({ mode: "none", hasPlanner: false }),
    ).toBe("none");
  });
});

describe("ControlLinkServer durable-storage guard (unchanged belt)", () => {
  it("still rejects a planner without a store at construction time", () => {
    const registry = new BotRegistry({ staleAfterMs: 30_000 });
    expect(
      () =>
        new ControlLinkServer({
          host: "127.0.0.1",
          port: 0,
          instanceId: "coordinator-guard-test",
          clients: [
            {
              clientId: "client-a",
              keyId: "key-a",
              secretSha256:
                "a".repeat(64),
              capabilities: ["bot.read", "bot.stop"],
            },
          ],
          registry,
          stopController: {
            requestStop: async () => ({}),
          } as never,
          assignment: {} as never,
          goalPlanner: { planAndDispatch: async () => undefined } as never,
          logger: {
            info: () => undefined,
            warn: () => undefined,
            error: () => undefined,
          } as never,
        }),
    ).toThrowError(/requires durable storage/u);
  });

  it("accepts the same wiring once the explicit in-memory store is attached", () => {
    const registry = new BotRegistry({ staleAfterMs: 30_000 });
    const server = new ControlLinkServer({
      host: "127.0.0.1",
      port: 0,
      instanceId: "coordinator-guard-test-2",
      clients: [
        {
          clientId: "client-a",
          keyId: "key-a",
          secretSha256: "a".repeat(64),
          capabilities: ["bot.read", "bot.stop"],
        },
      ],
      registry,
      stopController: {
        requestStop: async () => ({}),
      } as never,
      assignment: {} as never,
      goalPlanner: { planAndDispatch: async () => undefined } as never,
      goalStore: new InMemoryGoalLifecycleStore() as never,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      } as never,
    });
    expect(server).toBeDefined();
  });
});
