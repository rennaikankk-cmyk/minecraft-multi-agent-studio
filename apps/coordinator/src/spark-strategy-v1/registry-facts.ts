import { createHmac, randomBytes } from "node:crypto";
import type { BaseRegistry, FacilityRegistry, InMemoryWorkstationRegistry } from "@minecraft-studio/skills";
import type { BotRegistry } from "../bot-registry.js";
import type { BotAssignmentService } from "../bot-assignment.js";
import { canonicalJson, parseTeamFactsInput, type TeamFactsInput } from "./facts.js";
import type { ActionContext } from "./action-contract.js";

export const reviewedSkills = ["food.secure", "world.scan", "collect.block", "craft.item", "container.transfer", "movement.goto", "inventory.equip-armor"];
const gates = ["BASE_SITE_RESERVED", "STARTER_BASE_ACTIVE", "VILLAGE_SOURCE_VERIFIED"];
const terminal = new Set(["completed", "failed", "cancelled", "expired"]);
const edible = new Set(["bread", "carrot", "potato", "baked_potato", "cooked_beef", "cooked_porkchop", "cooked_chicken", "apple"]);

export type Observation = { facts: TeamFactsInput; context: ActionContext; contentKey: string; scopeKey: string };
export type RegistryFactSources = {
  registry: Pick<BotRegistry, "inspect">;
  assignment: Pick<BotAssignmentService, "inspect">;
  bases: Pick<BaseRegistry, "forMember">;
  facilities: Pick<FacilityRegistry, "findByBase">;
  workstations: Pick<InMemoryWorkstationRegistry, "serialize">;
};

/** The random key prevents enumeration of coordinate-derived Registry IDs from public hashes. */
export class RegistryFactReader {
  private readonly key = randomBytes(32);
  constructor(private readonly sources: RegistryFactSources, private readonly maxAgeMs = 60_000) {}
  private alias(kind: string, raw: string): string {
    return `${kind}-${createHmac("sha256", this.key).update(raw).digest("hex").slice(0, 12)}`;
  }

  read(nowMs: number): Observation[] {
    const records = this.sources.registry.inspect(new Date(nowMs));
    const groups = new Map<string, typeof records>();
    for (const record of records) {
      const dimension = record.currentStatus?.position.dimension;
      if (!dimension) continue;
      const key = canonicalJson([record.serverProfileId, dimension]);
      const group = groups.get(key) ?? [];
      group.push(record);
      groups.set(key, group);
    }
    if (groups.size > 32) throw new Error("OBSERVER_SCOPE_CAPACITY");
    const leases = this.sources.assignment.inspect();
    const workstations = this.sources.workstations.serialize().entries;
    const observations: Observation[] = [];
    for (const [groupKey, group] of groups) {
      if (group.length > 10) throw new Error("OBSERVER_BOT_CAPACITY");
      const server = group[0]!.serverProfileId;
      const dimension = group[0]!.currentStatus!.position.dimension;
      const serverAlias = this.alias("server", server);
      const dimensionAlias = ["minecraft:overworld", "minecraft:the_nether", "minecraft:the_end"].includes(dimension)
        ? dimension : `minecraft:${this.alias("dimension", dimension)}`;
      const scopeKey = this.alias("scope", groupKey);
      const fresh = (time: number) => Number.isFinite(time) && time <= nowMs + 2_000 && nowMs - time <= this.maxAgeMs;
      const times: number[] = [];
      const includeTime = (time: number) => { if (Number.isFinite(time)) times.push(time); };
      const facts: TeamFactsInput = {
        scope: { serverProfileId: serverAlias, dimension: dimensionAlias, observedAtMs: nowMs,
          snapshotId: this.alias("sessions", canonicalJson(group.map((r) => [r.botId, r.runtimeInstanceId]))) },
        capturedAtMs: nowMs, bots: [], team: { sharedInventory: "unknown", facilities: [], shortages: [], reservedResources: [] },
        events: [], constraints: { capabilities: [], phaseGates: [], nonPreemptibleBots: [],
          allowedChangeScope: "Read-only suggestions. Preserve active tasks and leases. Never change survival/combat rules. Inventory is per Bot; shared stock and death totals are unknown. Unknown evidence requires observation. No execution is authorized." },
        sourceRefs: ["registry-read-only-v1"],
      };
      const targetMap: NonNullable<ActionContext["targets"]> = new Map();
      const targets = targetMap as Map<string, { serverProfileId: string; dimension: string; x: number; y: number; z: number }>;
      const addedFacilities = new Set<string>();
      for (const record of group) {
        const status = record.currentStatus!;
        const statusTime = Date.parse(status.observedAt);
        includeTime(statusTime);
        const known = fresh(statusTime);
        const botId = this.alias("bot", record.botId);
        const reserved = leases.filter((lease) => lease.botId === record.botId && lease.serverProfileId === server &&
          (lease.dimension === dimension || lease.dimension === null) && Date.parse(lease.expiresAt) > nowMs);
        const task = status.currentTask;
        const active = task !== null && !terminal.has(task.status);
        const paused = status.safety?.normalTasksPaused === true;
        const inventory = known && status.inventory ? status.inventory.map(({ itemName, count }) => ({ itemName, count })) : "unknown";
        // Item registry names are the only allowed strings in inventory, never display/NBT names.
        if (inventory !== "unknown" && inventory.some((item) => !/^[a-z0-9_]{1,80}$/.test(item.itemName))) throw new Error("OBSERVER_ITEM_ID_INVALID");
        facts.bots.push({ botId, online: record.connectionState === "online" && known,
          currentTask: !known ? "unknown" : active ? { goalText: this.alias("task", task.taskId), phase: task.status }
            : paused ? { goalText: "deterministic-safety-hold", phase: "paused" }
            : reserved.length ? { goalText: "assignment-reserved", phase: "assigned" } : null,
          survival: { health: known ? status.health.current : "unknown", food: known ? status.food.level : "unknown",
            armorPoints: known ? status.armorPoints ?? "unknown" : "unknown" }, inventory, deaths: "unknown" });
        if (active || paused || reserved.length) facts.constraints.nonPreemptibleBots.push(botId);
        if (known && (status.food.level < 12 || (inventory !== "unknown" && inventory.reduce((n, i) => n + (edible.has(i.itemName) ? i.count : 0), 0) < 8))) {
          facts.team.shortages.push(`${botId}:food-stock-below-8-or-hunger-below-12`);
        }
        const death = status.lastDeath;
        if (death?.dimension === dimension && fresh(Date.parse(death.diedAt))) facts.events.push({ kind: "death", atMs: Date.parse(death.diedAt),
          source: "runtime-last-death", botId, detail: "recent death observed; total deaths unknown" });
        const base = this.sources.bases.forMember(record.botId, server, dimension);
        for (const gate of gates) {
          const evidence = base?.phaseFacts?.[gate];
          const at = evidence ? Date.parse(evidence.observedAt) : NaN;
          const trustworthy = evidence && evidence.evidence && evidence.validator && fresh(at);
          if (trustworthy) includeTime(at);
          facts.constraints.phaseGates.push({ gate, botId, satisfied: trustworthy
            ? evidence.availability === "AVAILABLE" ? true : evidence.availability === "UNVERIFIED" ? "unknown" : false : "unknown" });
        }
        if (base) for (const facility of this.sources.facilities.findByBase(base.id)) {
          if (facility.serverProfileId !== server || facility.dimension !== dimension || addedFacilities.has(facility.id)) continue;
          addedFacilities.add(facility.id);
          const facilityAlias = this.alias("facility", facility.id);
          // Structure/slot discovery is not proof of an operational production facility.
          (facts.team.facilities as Exclude<TeamFactsInput["team"]["facilities"], "unknown">).push({ facilityId: facilityAlias, kind: facility.facilityType, status: "unknown" });
          for (const slot of facility.slots) {
            if (slot.reservedBy && slot.reservedUntilMs !== null && slot.reservedUntilMs > nowMs) {
              facts.team.reservedResources.push({ resource: this.alias("slot", slot.slotId), heldByBotId: this.alias("bot", slot.reservedBy) });
            }
          }
        }
      }
      for (const station of workstations) {
        if (station.serverProfileId !== server || station.dimension !== dimension) continue;
        const ref = this.alias("station", canonicalJson([server, dimension, station.position]));
        const lease = station.lease && station.lease.expiresAtMs > nowMs ? station.lease : null;
        const known = fresh(station.lastSeenAt) && station.confidence >= 0.8;
        if (known) includeTime(station.lastSeenAt);
        const heldByBotId = lease ? this.alias("bot", lease.ownerBotId) : undefined;
        (facts.team.facilities as Exclude<TeamFactsInput["team"]["facilities"], "unknown">).push({ facilityId: ref,
          kind: station.type, status: known ? lease ? "busy" : "available" : "unknown", ...(heldByBotId ? { heldByBotId } : {}) });
        if (heldByBotId) facts.team.reservedResources.push({ resource: ref, heldByBotId });
        targets.set(ref, { ...station.position, serverProfileId: serverAlias, dimension: dimensionAlias });
      }
      if (facts.team.facilities.length > 64 || facts.team.reservedResources.length > 128) throw new Error("OBSERVER_RESOURCE_CAPACITY");
      facts.constraints.capabilities = reviewedSkills.map((skillId) => ({ skillId, supported: group.every((record) =>
        record.skillCatalog?.skills.some((skill) => skill.skillId === skillId && skill.availability === "available") === true) }));
      facts.scope.observedAtMs = times.length ? Math.min(...times) : nowMs;
      const parsed = parseTeamFactsInput(facts);
      const contentKey = this.alias("content", canonicalJson({ ...parsed, capturedAtMs: undefined,
        scope: { ...parsed.scope, observedAtMs: undefined } }));
      observations.push({ facts: parsed, context: { targets }, contentKey, scopeKey });
    }
    return observations.sort((a, b) => a.scopeKey.localeCompare(b.scopeKey));
  }
}
