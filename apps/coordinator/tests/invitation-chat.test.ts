import { describe, expect, it } from "vitest";
import { InvitationStore } from "@minecraft-studio/base-management";
import { InvitationChatRouter } from "../src/invitation-chat.js";
import type { BotRegistryChatEvent, BotRegistryRecord } from "../src/bot-registry.js";

const evidence = { schemaVersion: "1.0" as const, source: "protocol-player-chat" as const,
  senderUuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", playerListUsername: "Alice", signatureVerified: true,
  channel: "public" as const, authMode: "online" as const, worldId: "world", dimension: "overworld", policyRevision: 1 };
const bot = (botId: string) => ({ botId, serverProfileId: "srv", connectionState: "online", currentStatus: {
  position: { dimension: "overworld" }, personalContext: { worldId: "world" },
} }) as unknown as BotRegistryRecord;
const chat = (message: string, messageId = "m1", channel: "public" | "private" = "public"): BotRegistryChatEvent => ({
  kind: "chat", message, messageId, speaker: "Alice", timestamp: new Date().toISOString(), identity: { ...evidence, channel },
});

describe("trusted invitation chat routing", () => {
  it("selects the named bot without triggering other bots that hear the same public chat", () => {
    const store = new InvitationStore(); const bots = [bot("BotOne"), bot("BotTwo")];
    const router = new InvitationChatRouter({ store, records: () => bots });
    const event = chat("@BotTwo 这是我的基地，坐标 -10 65 20，过来住");
    expect(router.handle(bots[0]!, event)).toEqual({ handled: true, reason: "addressed_to_other_bot" });
    expect(router.handle(bots[1]!, event).invitation?.targetBotId).toBe("BotTwo");
    expect(store.list()).toHaveLength(1);
  });
  it("requires an addressed context for ownership-only public messages", () => {
    const store = new InvitationStore(); const bots = [bot("BotOne")];
    const router = new InvitationChatRouter({ store, records: () => bots });
    expect(router.handle(bots[0]!, chat("这是我的基地 x=1 z=3")).reason).toBe("target_ambiguous");
    expect(router.handle(bots[0]!, chat("这是我的基地 x=1 z=3", "m2", "private")).invitation?.status).toBe("accepted");
  });
  it("uses coordinates first then an ownership declaration only within the same trusted conversation", () => {
    let now = Date.now(); const store = new InvitationStore(); const bots = [bot("BotOne")];
    const router = new InvitationChatRouter({ store, records: () => bots, now: () => now });
    expect(router.handle(bots[0]!, chat("@BotOne x=-20 y=70 z=5")).reason).toBe("coordinates_context_saved");
    expect(router.handle(bots[0]!, chat("这是我家", "m2")).invitation?.coordinates).toEqual({ x: -20, y: 70, z: 5 });
    store.transition(store.list()[0]!.invitationId, "cancelled");
    router.handle(bots[0]!, chat("@BotOne x=-20 z=5", "m3")); now += 120_001;
    expect(router.handle(bots[0]!, chat("这是我家", "m4")).reason).toBe("target_ambiguous");
  });
  it("never forwards coordinate-bearing malformed/negated invitations to the model path", () => {
    const store = new InvitationStore(); const bots = [bot("BotOne")];
    const router = new InvitationChatRouter({ store, records: () => bots });
    expect(router.handle(bots[0]!, chat("@BotOne 不是我的基地 x=1 z=2")).handled).toBe(true);
    expect(router.handle(bots[0]!, chat("@BotOne 我的基地 x=1.5 z=2")).handled).toBe(true);
    expect(store.list()).toHaveLength(0);
    expect(router.handle(bots[0]!, chat("穿上最好的护甲")).handled).toBe(false);
  });
});
