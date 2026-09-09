import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  RuntimeLinkConfigError,
  loadRuntimeLinkConfig,
  readManagedRuntimeLinkPeers,
  RUNTIME_LINK_PEERS_MAX_BYTES,
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

describe("managed Runtime Link bindings", () => {
  const slot = { keyId: "runtime-key-01", botId: "old-slot", secretSha256: HASH };
  const authorized = new Map([[slot.keyId, slot]]);

  it("reads fresh assignments for preauthorized keys without making the file a secret authority", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "runtime-peers-"));
    const file = path.join(dir, "peers.json");
    try {
      expect(loadRuntimeLinkConfig({ COORDINATOR_RUNTIME_LINK_PEERS_JSON: JSON.stringify([slot]),
        COORDINATOR_RUNTIME_LINK_PEERS_PATH: file }).peersPath).toBe(file);
      writeFileSync(file, JSON.stringify({ schemaVersion: "1.0", peers: [{ ...slot, botId: "_Resident_1" }] }));
      expect(readManagedRuntimeLinkPeers(file, authorized).get(slot.keyId)?.botId).toBe("_Resident_1");
      writeFileSync(file, JSON.stringify({ schemaVersion: "1.0", peers: [{ ...slot, botId: "Resident_2" }] }));
      expect(readManagedRuntimeLinkPeers(file, authorized).get(slot.keyId)?.botId).toBe("Resident_2");
      writeFileSync(file, JSON.stringify({ schemaVersion: "1.0", peers: [slot] }));
      expect(readManagedRuntimeLinkPeers(file, authorized).get(slot.keyId)?.botId).toBe("old-slot");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("rejects empty or relative managed file configuration instead of silently disabling it", () => {
    for (const peersPath of ["", "   ", "relative-peers.json"]) {
      expect(() => loadRuntimeLinkConfig({ COORDINATOR_RUNTIME_LINK_PEERS_JSON: JSON.stringify([slot]),
        COORDINATOR_RUNTIME_LINK_PEERS_PATH: peersPath })).toThrow("path must be absolute");
    }
  });

  it("validates the managed subset against static authorized keys", () => {
    const env = { COORDINATOR_RUNTIME_LINK_PEERS_JSON: JSON.stringify([slot]),
      COORDINATOR_RUNTIME_LINK_PEERS_PATH: path.join(tmpdir(), "managed-peer-config.json") };
    expect(loadRuntimeLinkConfig({ ...env, COORDINATOR_RUNTIME_LINK_MANAGED_KEY_IDS_JSON: JSON.stringify([slot.keyId]) }))
      .toMatchObject({ managedKeyIds: [slot.keyId] });
    for (const input of ["{", "null", "{}", JSON.stringify([slot.keyId, slot.keyId]), '["unknown"]', "[1]"]) {
      expect(() => loadRuntimeLinkConfig({ ...env, COORDINATOR_RUNTIME_LINK_MANAGED_KEY_IDS_JSON: input })).toThrow("managed key IDs are invalid");
    }
    expect(() => loadRuntimeLinkConfig({ COORDINATOR_RUNTIME_LINK_PEERS_JSON: env.COORDINATOR_RUNTIME_LINK_PEERS_JSON,
      COORDINATOR_RUNTIME_LINK_MANAGED_KEY_IDS_JSON: JSON.stringify([slot.keyId]) })).toThrow();
  });

  it("rejects file entries for static keys and case-insensitive collisions with static usernames", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "runtime-peers-subset-"));
    const file = path.join(dir, "peers.json");
    const external = { keyId: "external-key", botId: "ExternalBot", secretSha256: "b".repeat(64) };
    const mixed = new Map([...authorized, [external.keyId, external]]);
    const managed = new Set([slot.keyId]);
    try {
      for (const peers of [[external], [{ ...external, botId: "RenamedBot" }],
        [{ ...slot, botId: "externalbot" }], [{ ...slot, botId: "ExternalBot" }]]) {
        writeFileSync(file, JSON.stringify({ schemaVersion: "1.0", peers }));
        expect(() => readManagedRuntimeLinkPeers(file, mixed, managed)).toThrow("unavailable or invalid");
      }
      writeFileSync(file, JSON.stringify({ schemaVersion: "1.0", peers: [{ ...slot, botId: "Resident_1" }] }));
      expect(readManagedRuntimeLinkPeers(file, mixed, managed).get(slot.keyId)?.botId).toBe("Resident_1");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("rejects missing, oversized, malformed, duplicated and unapproved mappings", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "runtime-peers-"));
    const file = path.join(dir, "peers.json");
    const peer = { ...slot, botId: "Resident_1" };
    const body = (peers: unknown[], schemaVersion = "1.0") => JSON.stringify({ schemaVersion, peers });
    try {
      expect(() => readManagedRuntimeLinkPeers(file, authorized)).toThrow("unavailable or invalid");
      for (const invalid of ["{", " ".repeat(RUNTIME_LINK_PEERS_MAX_BYTES + 1),
        body([peer], "2.0"), body([peer, peer]), body([{ ...peer, secretSha256: "b".repeat(64) }]),
        body([{ ...peer, keyId: "unapproved" }]), body([{ ...peer, botId: "not-a-username" }]),
        body([{ ...peer, botId: "x" }]), body([{ ...peer, botId: "x".repeat(17) }]),
        body([{ ...peer, secret: "forbidden" }]), body(Array(1001).fill(peer)),
        JSON.stringify({ schemaVersion: "1.0", peers: [peer], extra: true })]) {
        writeFileSync(file, invalid);
        expect(() => readManagedRuntimeLinkPeers(file, authorized)).toThrow("unavailable or invalid");
      }
      const second = { keyId: "runtime-key-02", botId: "resident_1", secretSha256: "b".repeat(64) };
      writeFileSync(file, body([peer, second]));
      expect(() => readManagedRuntimeLinkPeers(file, new Map([...authorized, [second.keyId, second]]))).toThrow();
      writeFileSync(file, body([]));
      expect(readManagedRuntimeLinkPeers(file, authorized).size).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
