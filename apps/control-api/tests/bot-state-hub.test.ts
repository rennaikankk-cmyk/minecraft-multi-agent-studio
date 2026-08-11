import { describe, expect, it, vi } from "vitest";

import {
  BotStateHub,
  type BotStateSource,
} from "../src/index.js";

describe("BotStateHub", () => {
  it("rolls back a listener when the initial authoritative list throws", () => {
    const source: BotStateSource = {
      isReady: () => true,
      get: () => null,
      list: () => {
        throw new Error("authoritative_list_failed");
      },
      subscribe: () => () => undefined,
      subscribeAvailability: () => () => undefined,
    };
    const hub = new BotStateHub(source);
    const listener = vi.fn();

    expect(() => hub.subscribe(listener, new Date())).toThrowError(
      "authoritative_list_failed",
    );
    expect(
      (hub as unknown as { listeners: Set<unknown> }).listeners.size,
    ).toBe(0);

    hub.dispose();
  });
});
