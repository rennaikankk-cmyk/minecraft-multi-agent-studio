import { readFileSync } from "node:fs";
import { z } from "zod";
import { chatIdentityPolicySchema, type ChatIdentityPolicy } from "@minecraft-studio/protocol";

export function loadChatTrustPolicies(filePath: string | undefined): readonly ChatIdentityPolicy[] {
  if (!filePath?.trim()) return [];
  try {
    const content = readFileSync(filePath, "utf8");
    if (Buffer.byteLength(content) > 256 * 1024) throw new Error("size");
    const policies = z.array(chatIdentityPolicySchema).max(256).parse(JSON.parse(content));
    const keys = policies.map((p) => JSON.stringify([p.serverProfileId, p.worldId]));
    if (new Set(keys).size !== keys.length) throw new Error("duplicates");
    return policies;
  } catch { throw new Error("CHAT_TRUST_CONFIG_INVALID"); }
}
