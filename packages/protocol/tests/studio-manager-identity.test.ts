import { describe, expect, it } from "vitest";
import { studioCreateBotRequestV1Schema, studioManagedBotV1Schema } from "../src/studio-manager.js";
import { botIdentitySchema, botPersonalMemoryScopeSchema, botStatusV1Schema, identifierSchema } from "../src/index.js";

const common = { schemaVersion: "1.0", serverHost: "127.0.0.1", serverPort: 25565, minecraftVersion: "auto" };

describe("managed game identity schemas", () => {
  it("permits leading underscores only in valid Minecraft Bot usernames", () => {
    for (const botId of ["_Miner", "___", "studio-bot-01", "bot:legacy"]) {
      expect(botIdentitySchema.parse(botId)).toBe(botId);
      expect(botPersonalMemoryScopeSchema.parse({ botId, serverProfileId: "server-one", worldId: null }).botId).toBe(botId);
      expect(botStatusV1Schema.shape.botId.parse(botId)).toBe(botId);
    }
    for (const invalid of ["_", "__", "_longer_than_16_chars", "_bad-name", "../Miner", "_bot/name"]) {
      expect(botIdentitySchema.safeParse(invalid).success).toBe(false);
    }
    expect(identifierSchema.safeParse("_Miner").success).toBe(false);
    expect(botPersonalMemoryScopeSchema.safeParse({ botId: "_Miner", serverProfileId: "_server", worldId: null }).success).toBe(false);
  });

  it("keeps unknown world generation absent and accepts an explicit generation ID", () => {
    const request = { ...common, username: "_Miner" };
    expect(studioCreateBotRequestV1Schema.parse(request)).not.toHaveProperty("worldId");
    expect(studioCreateBotRequestV1Schema.parse({ ...request, worldId: "season-2026" })).toHaveProperty("worldId", "season-2026");
    expect(studioCreateBotRequestV1Schema.safeParse({ ...request, worldId: "" }).success).toBe(false);
  });
  it("requires a game username for offline creation, including legacy requests", () => {
    expect(studioCreateBotRequestV1Schema.parse({ ...common, username: "Offline_Bot" })).toMatchObject({ username: "Offline_Bot" });
    expect(studioCreateBotRequestV1Schema.safeParse({ ...common, auth: "offline" }).success).toBe(false);
    expect(studioCreateBotRequestV1Schema.safeParse({ ...common, auth: "offline", accountRef: "account-one", username: "Offline_Bot" }).success).toBe(false);
  });

  it("requires a controlled account reference for online creation and accepts no raw credentials", () => {
    expect(studioCreateBotRequestV1Schema.parse({ ...common, auth: "online", accountRef: "account-one" })).not.toHaveProperty("username");
    expect(studioCreateBotRequestV1Schema.safeParse({ ...common, auth: "online", username: "Unverified" }).success).toBe(false);
    expect(studioCreateBotRequestV1Schema.safeParse({ ...common, auth: "online", accountRef: "person@example.invalid" }).success).toBe(false);
    expect(studioCreateBotRequestV1Schema.safeParse({ ...common, auth: "online", accountRef: "account-one", password: "secret" }).success).toBe(false);
    // Legacy clients may still send an alias, but it cannot replace accountRef.
    expect(studioCreateBotRequestV1Schema.safeParse({ ...common, auth: "online", accountRef: "account-one", username: "Unverified" }).success).toBe(true);
  });

  it("allows the verified Java UUID in public Bot status without account credentials", () => {
    const bot = { botId: "Verified_Player", username: "Verified_Player", serverHost: "127.0.0.1", serverPort: 25565,
      minecraftVersion: "auto", auth: "online", gameProfileId: "069a79f444e94726a5befca90e38aaf5", processState: "stopped", pid: null,
      createdAt: "2026-09-08T12:00:00.000Z", updatedAt: "2026-09-08T12:00:00.000Z", lastError: null };
    expect(studioManagedBotV1Schema.safeParse(bot).success).toBe(true);
    expect(studioManagedBotV1Schema.safeParse({ ...bot, gameProfileId: "unverified" }).success).toBe(false);
    expect(studioManagedBotV1Schema.safeParse({ ...bot, accountRef: "account-one" }).success).toBe(false);
  });
});
