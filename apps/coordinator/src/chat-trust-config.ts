import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { chatIdentityPolicySchema, type ChatIdentityPolicy } from "@minecraft-studio/protocol";

/** 缺省路径：manager 白名单面板写的同一文件（零配置闭环）。 */
export const DEFAULT_CHAT_TRUST_PATH = path.join("runtime-data", "chat-trust.json");

export function loadChatTrustPolicies(filePath: string | undefined): readonly ChatIdentityPolicy[] {
  const resolved = filePath?.trim() || DEFAULT_CHAT_TRUST_PATH;
  try {
    const content = readFileSync(resolved, "utf8");
    if (Buffer.byteLength(content) > 256 * 1024) throw new Error("size");
    const policies = z.array(chatIdentityPolicySchema).max(256).parse(JSON.parse(content));
    const keys = policies.map((p) => JSON.stringify([p.serverProfileId, p.worldId]));
    if (new Set(keys).size !== keys.length) throw new Error("duplicates");
    return policies;
  } catch (error) {
    // 缺省路径不存在=未配置（合法首启）；显式配置损坏才 fail-closed。
    if (!filePath?.trim() && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("CHAT_TRUST_CONFIG_INVALID");
  }
}
