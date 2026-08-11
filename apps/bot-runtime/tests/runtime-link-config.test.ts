import { describe, expect, it } from "vitest";

import {
  RuntimeLinkConfigError,
  loadRuntimeLinkConfig,
} from "../src/runtime-link-config.js";

const VALID_ENV = {
  BOT_RUNTIME_LINK_URL: "ws://127.0.0.1:3221/v1/runtime-link",
  BOT_RUNTIME_LINK_KEY_ID: "runtime-key-01",
  BOT_RUNTIME_LINK_SECRET: "correct-horse-battery-staple-123456",
};

describe("Runtime Link configuration", () => {
  it("accepts only an explicit loopback Runtime Link endpoint", () => {
    expect(loadRuntimeLinkConfig(VALID_ENV)).toMatchObject({
      url: "ws://127.0.0.1:3221/v1/runtime-link",
      keyId: "runtime-key-01",
      secret: VALID_ENV.BOT_RUNTIME_LINK_SECRET,
    });
    expect(
      loadRuntimeLinkConfig({
        ...VALID_ENV,
        BOT_RUNTIME_LINK_URL: "ws://[::1]:3221/v1/runtime-link",
      }).url,
    ).toBe("ws://[::1]:3221/v1/runtime-link");
  });

  it.each([
    "wss://127.0.0.1:3221/v1/runtime-link",
    "ws://localhost:3221/v1/runtime-link",
    "ws://192.168.1.10:3221/v1/runtime-link",
    "ws://127.0.0.1/v1/runtime-link",
    "ws://user@127.0.0.1:3221/v1/runtime-link",
    "ws://127.0.0.1:3221/other",
    "ws://127.0.0.1:3221/v1/runtime-link?token=value",
    "ws://127.0.0.1:3221/v1/runtime-link#fragment",
  ])("rejects unsafe endpoint %s", (url) => {
    expect(() =>
      loadRuntimeLinkConfig({ ...VALID_ENV, BOT_RUNTIME_LINK_URL: url }),
    ).toThrowError(
      expect.objectContaining<Partial<RuntimeLinkConfigError>>({
        code: "RUNTIME_LINK_URL_INVALID",
      }),
    );
  });

  it("requires a bounded identifier and a sufficiently long secret", () => {
    expect(() =>
      loadRuntimeLinkConfig({
        ...VALID_ENV,
        BOT_RUNTIME_LINK_KEY_ID: "bad key",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<RuntimeLinkConfigError>>({
        code: "RUNTIME_LINK_KEY_ID_INVALID",
      }),
    );
    expect(() =>
      loadRuntimeLinkConfig({
        ...VALID_ENV,
        BOT_RUNTIME_LINK_SECRET: "too-short",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<RuntimeLinkConfigError>>({
        code: "RUNTIME_LINK_SECRET_INVALID",
      }),
    );
  });
});
