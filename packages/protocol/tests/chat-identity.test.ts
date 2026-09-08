import { describe, expect, it } from "vitest";
import { verifyChatIdentity, type ChatIdentityPolicy, type ChatIdentityEvidence } from "../src/chat-identity.js";

const id = "0123456789abcdef0123456789abcdef";
const policy: ChatIdentityPolicy = { schemaVersion: "1.0", serverProfileId: "local", worldId: "save-1", revision: 1,
  authMode: "online", usernames: ["Ally"], uuids: [id], offlineTrust: "disabled", allowUnsignedOnline: false };
const evidence: ChatIdentityEvidence = { schemaVersion: "1.0", source: "protocol-player-chat", senderUuid: id,
  playerListUsername: "Ally", signatureVerified: true, channel: "public", authMode: "online", worldId: "save-1",
  dimension: "minecraft:overworld", policyRevision: 1 };
const check = (p = policy, e: unknown = evidence, speaker = "Ally", serverProfileId = "local") =>
  verifyChatIdentity({ policy: p, evidence: e, speaker, serverProfileId });

describe("authenticated chat policy", () => {
  it("requires evidence and the exact UUID even when a displayed name is allowlisted", () => {
    expect(check()).toBe(true);
    expect(check(policy, null)).toBe(false);
    expect(check(policy, { ...evidence, senderUuid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })).toBe(false);
    expect(check(policy, evidence, "Forged")).toBe(false);
    expect(check(policy, { ...evidence, signatureVerified: false })).toBe(false);
  });
  it("keeps offline trust explicit and does not treat an offline UUID as authentication", () => {
    const p = { ...policy, authMode: "offline" as const, uuids: [] };
    const e = { ...evidence, authMode: "offline", signatureVerified: false };
    expect(check(p, e)).toBe(false);
    expect(check({ ...p, offlineTrust: "server-player-list" }, e)).toBe(true);
    expect(check({ ...p, usernames: [], offlineTrust: "server-player-list" }, e)).toBe(false);
    expect(check(policy, e)).toBe(false);
  });
  it("rejects old policy and world scope while allowing an explicitly configured unsigned server", () => {
    expect(check(policy, { ...evidence, worldId: "save-2" })).toBe(false);
    expect(check(policy, { ...evidence, policyRevision: 2 })).toBe(false);
    expect(check(policy, evidence, "Ally", "elsewhere")).toBe(false);
    expect(check({ ...policy, allowUnsignedOnline: true }, { ...evidence, signatureVerified: false })).toBe(true);
  });
});
