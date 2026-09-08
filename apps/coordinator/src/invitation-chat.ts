import { InvitationStore, canRememberInvitationCoordinates, containsPrivateCoordinates, hasInvitationIntent, parseBaseInvitation, parseInvitationCoordinates,
  type BaseInvitation, type InvitationCoordinates, type InvitationScope } from "@minecraft-studio/base-management";
import type { BotRegistryChatEvent, BotRegistryRecord } from "./bot-registry.js";

type Context = Readonly<{ coordinates: InvitationCoordinates; observedAt: number }>;
export type InvitationChatResult = Readonly<{ handled: boolean; reason: string; invitation?: BaseInvitation }>;
function escape(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }

/** Only BotRegistry's verified chat events enter here. No independent execution
 * queue is created: accepted records are consumed by the task-system adapter. */
export class InvitationChatRouter {
  private readonly contexts = new Map<string, Context>();
  constructor(private readonly options: Readonly<{
    store: InvitationStore;
    records: () => readonly BotRegistryRecord[];
    currentHome?: (botId: string, scope: InvitationScope) => string | null;
    now?: () => number;
  }>) {}
  handle(record: BotRegistryRecord, event: BotRegistryChatEvent): InvitationChatResult {
    const now = this.options.now?.() ?? Date.now();
    for (const [key, value] of this.contexts) if (now - value.observedAt > 120_000) this.contexts.delete(key);
    const scope: InvitationScope = { serverProfileId: record.serverProfileId,
      worldId: record.currentStatus?.personalContext?.worldId ?? null, dimension: event.identity.dimension };
    const possibleInvitation = hasInvitationIntent(event.message);
    const privateCoordinates = containsPrivateCoordinates(event.message);
    const revoke = /^(?:@[A-Za-z0-9_]{3,16}[,:：，]?\s*)?(?:撤销邀请|取消邀请|revoke\s+(?:my\s+)?invitation)[。.!！]?$/iu.test(event.message.trim());
    if (!possibleInvitation && !privateCoordinates && !revoke) return { handled: false, reason: "ordinary_chat" };
    if (record.connectionState !== "online" || event.identity.worldId !== scope.worldId || record.currentStatus?.position.dimension !== scope.dimension) return { handled: true, reason: "scope_mismatch" };
    const candidates = this.options.records().filter((r) => r.connectionState === "online" && r.serverProfileId === scope.serverProfileId &&
      (r.currentStatus?.personalContext?.worldId ?? null) === scope.worldId && r.currentStatus?.position.dimension === scope.dimension);
    const mentioned = candidates.filter((r) => new RegExp(`(?:^|[^A-Za-z0-9_])@?${escape(r.botId)}(?:$|[^A-Za-z0-9_])`, "iu").test(event.message));
    const target = event.identity.channel === "private" ? record.botId : mentioned.length === 1 ? mentioned[0]!.botId :
      mentioned.length === 0 && candidates.length === 1 && /(?:过来住|搬来住|搬到这里|搬过来|设为家|住这里|move\s+(?:here|in)|come\s+(?:and\s+)?live)/iu.test(event.message) ? candidates[0]!.botId : null;
    const key = JSON.stringify([scope.serverProfileId, scope.worldId, scope.dimension, event.identity.senderUuid,
      event.identity.authMode, event.identity.policyRevision, record.botId]);
    const context = this.contexts.get(key);
    if (target !== record.botId && !(target === null && context)) return { handled: true, reason: target ? "addressed_to_other_bot" : "target_ambiguous" };
    if (revoke) {
      const active = this.options.store.activeForBot(record.botId, scope);
      if (!active) return { handled: true, reason: "no_active_invitation" };
      const invitation = this.options.store.revoke(active.invitationId, event.identity.senderUuid, new Date(now));
      return invitation ? { handled: true, reason: "revoked", invitation } : { handled: true, reason: "inviter_mismatch" };
    }
    const coordinates = parseInvitationCoordinates(event.message);
    if (coordinates && canRememberInvitationCoordinates(event.message)) {
      if (this.contexts.size >= 256) this.contexts.delete(this.contexts.keys().next().value!);
      this.contexts.set(key, { coordinates, observedAt: now });
    }
    const parsed = parseBaseInvitation(event.message, record.botId, context?.coordinates);
    if (!parsed) return { handled: true, reason: coordinates ? "coordinates_context_saved" : "unrecognized_invitation" };
    this.options.store.expire(new Date(now));
    const invitation = this.options.store.accept(parsed, {
      ...scope, messageId: event.messageId, inviterIdentity: event.identity.playerListUsername, identityEvidence: event.identity,
      previousHomeBaseId: this.options.currentHome?.(record.botId, scope) ?? null,
    }, new Date(now));
    this.contexts.delete(key);
    return { handled: true, reason: invitation.status, invitation };
  }
}
