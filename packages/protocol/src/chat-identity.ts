import { z } from "zod";

const username = z.string().regex(/^[A-Za-z0-9_]{3,16}$/u);
const uuid = z.string().regex(/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/iu);
export const chatIdentityEvidenceSchema = z.object({
  schemaVersion: z.literal("1.0"),
  source: z.literal("protocol-player-chat"),
  senderUuid: uuid,
  playerListUsername: username,
  signatureVerified: z.boolean(),
  channel: z.enum(["public", "private"]),
  authMode: z.enum(["online", "offline"]),
  worldId: z.string().min(1).max(128).nullable(),
  dimension: z.string().min(1).max(128),
  policyRevision: z.number().int().positive(),
}).strict();
export type ChatIdentityEvidence = z.infer<typeof chatIdentityEvidenceSchema>;

/** Operator configuration. Offline trust is an explicit server assertion,
 * never proof that a Minecraft UUID authenticates the account owner. */
export const chatIdentityPolicySchema = z.object({
  schemaVersion: z.literal("1.0"),
  serverProfileId: z.string().min(1).max(128),
  worldId: z.string().min(1).max(128).nullable(),
  revision: z.number().int().positive(),
  authMode: z.enum(["online", "offline"]),
  usernames: z.array(username).max(256),
  uuids: z.array(uuid).max(256),
  offlineTrust: z.enum(["disabled", "server-player-list"]).default("disabled"),
  allowUnsignedOnline: z.boolean().default(false),
}).strict();
export type ChatIdentityPolicy = z.infer<typeof chatIdentityPolicySchema>;
const normalizeUuid = (value: string) => value.replaceAll("-", "").toLowerCase();

export function verifyChatIdentity(input: {
  serverProfileId: string; speaker: string; evidence: unknown; policy: ChatIdentityPolicy | null;
}): boolean {
  const parsed = chatIdentityEvidenceSchema.safeParse(input.evidence);
  const policy = input.policy && chatIdentityPolicySchema.safeParse(input.policy);
  if (!parsed.success || !policy?.success) return false;
  const e = parsed.data, p = policy.data;
  if (p.serverProfileId !== input.serverProfileId || p.worldId !== e.worldId ||
      p.authMode !== e.authMode || p.revision !== e.policyRevision ||
      input.speaker.toLowerCase() !== e.playerListUsername.toLowerCase()) return false;
  const uuidAllowed = p.uuids.some((value) => normalizeUuid(value) === normalizeUuid(e.senderUuid));
  const nameAllowed = p.usernames.some((value) => value.toLowerCase() === e.playerListUsername.toLowerCase());
  // A configured UUID allowlist is authoritative; a matching display name
  // must not rescue a nonmatching sender UUID.
  if (p.uuids.length > 0 && !uuidAllowed) return false;
  if (p.authMode === "online") return (e.signatureVerified || p.allowUnsignedOnline) && (uuidAllowed || nameAllowed);
  return p.offlineTrust === "server-player-list" && nameAllowed;
}
