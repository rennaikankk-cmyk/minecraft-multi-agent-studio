import { describe, expect, it } from "vitest";

import {
  RuntimeLinkConfigError,
  loadRuntimeLinkConfig,
} from "../src/runtime-link-config.js";

const HASH = "a".repeat(64);

describe("Runtime Link Coordinator config", () => {
  it("loads strict loopback peer configuration", () => {
    expect(
      loadRuntimeLinkConfig({
        COORDINATOR_RUNTIME_LINK_HOST: "::1",
        COORDINATOR_RUNTIME_LINK_PORT: "43210",
        COORDINATOR_BOT_STALE_AFTER_MS: "45000",
        COORDINATOR_RUNTIME_LINK_PEERS_JSON: JSON.stringify([
          { keyId: "runtime-key-01", botId: "worker-01", secretSha256: HASH },
        ]),
      }),
    ).toEqual({
      host: "::1",
      port: 43_210,
      botStaleAfterMs: 45_000,
      peers: [
        { keyId: "runtime-key-01", botId: "worker-01", secretSha256: HASH },
      ],
    });
  });

  it("uses the dedicated loopback defaults", () => {
    expect(
      loadRuntimeLinkConfig({
        COORDINATOR_RUNTIME_LINK_PEERS_JSON: JSON.stringify([
          { keyId: "runtime-key-01", botId: "worker-01", secretSha256: HASH },
        ]),
      }),
    ).toMatchObject({
      host: "127.0.0.1",
      port: 3_220,
      botStaleAfterMs: 15_000,
    });
  });

  it("rejects stale thresholds outside the strict production range", () => {
    const peers = JSON.stringify([
      { keyId: "runtime-key-01", botId: "worker-01", secretSha256: HASH },
    ]);
    for (const value of ["999", "300001", "1.5", " 15000", "NaN"]) {
      expect(() =>
        loadRuntimeLinkConfig({
          COORDINATOR_BOT_STALE_AFTER_MS: value,
          COORDINATOR_RUNTIME_LINK_PEERS_JSON: peers,
        }),
      ).toThrowError(
        expect.objectContaining<Partial<RuntimeLinkConfigError>>({
          code: "COORDINATOR_BOT_STALE_AFTER_MS_INVALID",
        }),
      );
    }
  });

  it("rejects non-loopback binds and missing peer configuration", () => {
    expect(() =>
      loadRuntimeLinkConfig({
        COORDINATOR_RUNTIME_LINK_HOST: "0.0.0.0",
        COORDINATOR_RUNTIME_LINK_PEERS_JSON: "[]",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<RuntimeLinkConfigError>>({
        code: "RUNTIME_LINK_HOST_INVALID",
      }),
    );
    expect(() => loadRuntimeLinkConfig({})).toThrowError(
      expect.objectContaining<Partial<RuntimeLinkConfigError>>({
        code: "RUNTIME_LINK_AUTH_REQUIRED",
      }),
    );
  });

  it("rejects unknown fields and duplicated peer identities or secrets", () => {
    expect(() =>
      loadRuntimeLinkConfig({
        COORDINATOR_RUNTIME_LINK_PEERS_JSON: JSON.stringify([
          {
            keyId: "runtime-key-01",
            botId: "worker-01",
            secretSha256: HASH,
            token: "not-allowed",
          },
        ]),
      }),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_LINK_AUTH_INVALID" }));

    expect(() =>
      loadRuntimeLinkConfig({
        COORDINATOR_RUNTIME_LINK_PEERS_JSON: JSON.stringify([
          { keyId: "runtime-key-01", botId: "worker-01", secretSha256: HASH },
          { keyId: "runtime-key-02", botId: "worker-02", secretSha256: HASH },
        ]),
      }),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_LINK_AUTH_INVALID" }));
  });
});
