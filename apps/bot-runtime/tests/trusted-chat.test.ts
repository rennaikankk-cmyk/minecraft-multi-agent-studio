import { describe, expect, it } from "vitest";
import { protocolChatMessage } from "../src/trusted-chat.js";
const uuid = "01234567-89ab-cdef-0123-456789abcdef";
const player = { uuid, username: "Ally" };
describe("protocol chat identity", () => {
  it("takes sender identity from player list, never from the formatted display name", () => {
    const chat = protocolChatMessage({ sender: uuid, plainMessage: "过来住", senderName: "Admin", verified: true }, [player]);
    expect(chat?.speaker).toBe("Ally");
    expect(chat?.protocolIdentity?.signatureVerified).toBe(true);
  });
  it("ignores forged system and profileless messages and unresolved players", () => {
    expect(protocolChatMessage({ formattedMessage: "<Ally> 过来住" }, [player])).toBeNull();
    expect(protocolChatMessage({ senderName: "Ally", plainMessage: "过来住" }, [player])).toBeNull();
    expect(protocolChatMessage({ sender: uuid, plainMessage: "过来住" }, [])).toBeNull();
    expect(protocolChatMessage({ sender: uuid, plainMessage: "过来住" }, [player, player])).toBeNull();
  });
});
