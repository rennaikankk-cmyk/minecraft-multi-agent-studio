import { describe, expect, it } from "vitest";

import {
  ControlLinkConfigError,
  loadControlLinkConfig,
} from "../src/control-link-config.js";

const HASH = "a".repeat(64);
const CLIENT = {
  clientId: "control-api",
  keyId: "control-key-01",
  secretSha256: HASH,
  capabilities: ["bot.read", "bot.stop"],
} as const;

describe("Coordinator Control Link config", () => {
  it("loads strict loopback client configuration", () => {
    expect(
      loadControlLinkConfig({
        COORDINATOR_CONTROL_LINK_HOST: "::1",
        COORDINATOR_CONTROL_LINK_PORT: "43211",
        COORDINATOR_CONTROL_LINK_CLIENTS_JSON: JSON.stringify([CLIENT]),
      }),
    ).toEqual({ host: "::1", port: 43_211, clients: [CLIENT] });
  });

  it("uses a dedicated loopback default port", () => {
    expect(
      loadControlLinkConfig({
        COORDINATOR_CONTROL_LINK_CLIENTS_JSON: JSON.stringify([CLIENT]),
      }),
    ).toMatchObject({ host: "127.0.0.1", port: 3_221 });
  });

  it("rejects unsafe binds and missing clients", () => {
    expect(() =>
      loadControlLinkConfig({
        COORDINATOR_CONTROL_LINK_HOST: "0.0.0.0",
        COORDINATOR_CONTROL_LINK_CLIENTS_JSON: JSON.stringify([CLIENT]),
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ControlLinkConfigError>>({
        code: "CONTROL_LINK_HOST_INVALID",
      }),
    );
    expect(() => loadControlLinkConfig({})).toThrowError(
      expect.objectContaining({ code: "CONTROL_LINK_CLIENTS_REQUIRED" }),
    );
  });

  it("requires exact capabilities and rejects unknown fields", () => {
    expect(() =>
      loadControlLinkConfig({
        COORDINATOR_CONTROL_LINK_CLIENTS_JSON: JSON.stringify([
          { ...CLIENT, capabilities: ["bot.read"] },
        ]),
      }),
    ).toThrowError(expect.objectContaining({ code: "CONTROL_LINK_CLIENTS_INVALID" }));
    expect(() =>
      loadControlLinkConfig({
        COORDINATOR_CONTROL_LINK_CLIENTS_JSON: JSON.stringify([
          { ...CLIENT, token: "not-allowed" },
        ]),
      }),
    ).toThrowError(expect.objectContaining({ code: "CONTROL_LINK_CLIENTS_INVALID" }));
  });

  it("rejects duplicated client identities, keys, or secret verifiers", () => {
    expect(() =>
      loadControlLinkConfig({
        COORDINATOR_CONTROL_LINK_CLIENTS_JSON: JSON.stringify([
          CLIENT,
          { ...CLIENT, clientId: "other", keyId: "other-key" },
        ]),
      }),
    ).toThrowError(expect.objectContaining({ code: "CONTROL_LINK_CLIENTS_INVALID" }));
  });
});
