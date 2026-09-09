import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { AsyncLocalStorage } from "node:async_hooks";
import { evaluateWorldEffect, worldEffectRequestSchema, type AssetPolicyRecord, type WorldAssetPort, type WorldEffectRequest } from "@minecraft-studio/asset-policy";

type Position = { x: number; y: number; z: number };
type Scope = { serverProfileId: string; worldId: string | null; dimension: string; subject: string };
const at = (p: Position): Position => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const vec = (p: Position) => new Vec3(p.x, p.y, p.z);
const position = (value: unknown): Position | null => {
  const p = value as Position | null;
  return p && [p.x, p.y, p.z].every(Number.isFinite) ? at(p) : null;
};
const scopeKey = (scope: Scope) => JSON.stringify([scope.serverProfileId, scope.worldId, scope.dimension, scope.subject]);

/** Final local guard. Policy refresh is asynchronous; reflection/escape never
 * waits for HTTP. Missing/stale policy denies effects, retaining known protection.
 * Every wire write is checked again, including plugin and combat entry points. */
export class MachineProtection {
  private records: AssetPolicyRecord[] = [];
  private verifiedAt = 0;
  private verifiedScope = "";
  private loading: Promise<void> | null = null;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly restore: Array<() => void> = [];
  private readonly effects = new AsyncLocalStorage<{ action: WorldEffectRequest["action"]; target: Position; extras: Record<string, unknown> }>();
  private container: Position | null = null;
  private transfer: { position: Position; direction: "withdraw" | "deposit"; itemName: string; count: number } | null = null;

  constructor(private readonly bot: Bot, private readonly assets: WorldAssetPort,
    private readonly scope: () => Scope, private readonly now: () => number = Date.now) {}

  async refresh(): Promise<void> {
    if (this.loading) return this.loading;
    if (this.stopped || !this.assets.protection) throw new Error("ASSET_POLICY_UNAVAILABLE");
    const scope = this.scope(), key = scopeKey(scope);
    const { subject: _subject, ...worldScope } = scope;
    this.loading = Promise.resolve(this.assets.protection(worldScope)).then((records) => {
      if (this.stopped || scopeKey(this.scope()) !== key) return;
      this.records = records;
      this.verifiedAt = this.now(); this.verifiedScope = key;
    }).finally(() => { this.loading = null; });
    return this.loading;
  }

  assert(action: WorldEffectRequest["action"], target: Position, extras: Record<string, unknown> = {}): void {
    const scope = this.scope();
    if (this.stopped || !this.verifiedAt || this.now() - this.verifiedAt > 2000 || this.verifiedScope !== scopeKey(scope)) throw new Error("ASSET_POLICY_UNAVAILABLE");
    const input = worldEffectRequestSchema.parse({ ...extras, ...scope, schemaVersion: "1.0", action, position: at(target), impactRadius: extras.impactRadius ?? 0 });
    const decision = evaluateWorldEffect(this.records, input);
    if (!decision.allowed) throw new Error(decision.code);
  }

  private async check(action: WorldEffectRequest["action"], target: Position, extras: Record<string, unknown> = {}): Promise<void> {
    await this.refresh();
    this.assert(action, target, extras);
  }

  install(): void {
    void this.refresh().catch(() => {});
    this.timer = setInterval(() => { void this.refresh().catch(() => {}); }, 1000);
    this.timer.unref();
    const bot = this.bot;
    const wire = bot._client as unknown as { write(name: string, data: Record<string, unknown>): void };
    const original = wire.write;
    const guarded = (name: string, data: Record<string, unknown>) => {
      const target = position(data.location ?? data.position ?? (name === "position" ? data : null));
      // Movement itself can trigger pressure plates, tripwire and crop
      // trampling.  A position packet is therefore an effect boundary when
      // the destination (or supporting block) is a protected mechanism/farm.
      if (name === "position" && target) {
        const feet = bot.blockAt(vec(target));
        const support = bot.blockAt(vec(target).offset(0, -1, 0));
        const triggered = feet?.name ?? support?.name ?? "unknown";
        if (/(?:pressure_plate|tripwire|farmland|soul_sand)$/u.test(triggered)) this.assert("interact", target, { observedBlock: triggered });
      }
      if (name === "block_dig" && target && Number(data.status) <= 2) this.assert("dig", target);
      if (["block_place", "use_item_on"].includes(name) && target && target.y !== -1) {
        const block = bot.blockAt(vec(target));
        const item = bot.heldItem?.name ?? "";
        if (this.container && JSON.stringify(this.container) === JSON.stringify(target)) this.assert("container-transfer", target, { direction: "inspect", observedBlock: block?.name });
        else {
          const hazardous = /(?:bucket|end_crystal|respawn_anchor)$/u.test(item) || block?.name === "respawn_anchor" ||
            this.scope().dimension !== "minecraft:overworld" && /_bed$/u.test(block?.name ?? "");
          const effect = this.effects.getStore();
          if (effect && !hazardous) this.assert(effect.action, effect.target, effect.extras);
          else this.assert(item.endsWith("bucket") ? "fluid" : "interact", target, { impactRadius: hazardous ? 12 : 1, observedBlock: block?.name });
        }
      }
      if (["use_entity", "interact"].includes(name)) {
        const entity = bot.entities[Number(data.target ?? data.entityId)];
        if (!entity) throw new Error("ASSET_ENTITY_UNKNOWN");
        this.assert("entity", entity.position, { ...(entity.uuid ? { entityUuid: entity.uuid } : {}),
          impactRadius: /crystal|tnt|minecart/u.test(entity.name ?? "") ? 12 : 0 });
      }
      if (name === "window_click" && Number(data.windowId) !== 0) {
        if (!this.container) throw new Error("ASSET_CONTAINER_UNKNOWN");
        const block = bot.blockAt(vec(this.container));
        this.assert("container-transfer", this.container, this.transfer ? { ...this.transfer, observedBlock: block?.name } : { direction: "inspect", observedBlock: block?.name });
        // Untracked clicks cannot use an output interface as a generic GUI.
        if (!this.transfer && this.records.some((r) => r.protection === "OUTPUT_ONLY" && JSON.stringify(r.position) === JSON.stringify(this.container))) throw new Error("ASSET_TRANSFER_CONTEXT_REQUIRED");
      }
      if (name === "use_item") {
        const held = bot.heldItem?.name ?? "";
        if (/bucket|crystal|fire_charge|flint_and_steel|_spawn_egg|bow|trident/u.test(held)) this.assert("use", bot.entity.position, { impactRadius: 16 });
      }
      if (name === "update_sign" && target) this.assert("interact", target, { observedBlock: bot.blockAt(vec(target))?.name ?? "sign" });
      return original.call(wire, name, data);
    };
    wire.write = guarded;
    this.restore.push(() => { if (wire.write === guarded) wire.write = original; });

    const activate = bot.activateBlock;
    if (typeof activate === "function") {
      const wrapped: Bot["activateBlock"] = async (block, ...args) => {
        const target = at(block.position);
        const bed = block.name.endsWith("_bed");
        if (bed && this.scope().dimension !== "minecraft:overworld") throw new Error("BED_DIMENSION_UNSAFE");
        const openingContainer = this.container && JSON.stringify(this.container) === JSON.stringify(target);
        const action = openingContainer ? "container-transfer" as const : "use" as const;
        const extras = { observedBlock: block.name, impactRadius: block.name === "respawn_anchor" ? 12 : 0,
          ...(openingContainer ? { direction: "inspect" } : {}) };
        await this.check(action, target, extras);
        return this.effects.run({ action, target, extras }, () => activate.call(bot, block, ...args));
      };
      bot.activateBlock = wrapped;
      this.restore.push(() => { if (bot.activateBlock === wrapped) bot.activateBlock = activate; });
    }

    // Furnace is a separate Mineflayer window and bypasses openContainer;
    // guard it with the same scope/version check and transfer context.
    const openFurnace = bot.openFurnace;
    if (typeof openFurnace === "function") {
      const wrapped: Bot["openFurnace"] = async (block, ...args) => {
        const p = at(block.position), blockName = (block as { name?: string }).name;
        if (!blockName || !/furnace|smoker|blast_furnace/u.test(blockName)) throw new Error("ASSET_FURNACE_UNCONFIRMED");
        await this.check("container-transfer", p, { direction: "inspect", observedBlock: blockName });
        this.container = p;
        let window: Awaited<ReturnType<Bot["openFurnace"]>>;
        try { window = await openFurnace.call(bot, block, ...args); } catch (error) { this.container = null; throw error; }
        const wrapPull = (method: "takeOutput" | "takeInput" | "takeFuel", direction: "withdraw" | "deposit") => {
          const originalPull = window[method].bind(window);
          window[method] = (async () => {
            const item = window[method === "takeOutput" ? "outputItem" : method === "takeInput" ? "inputItem" : "fuelItem"]();
            if (!item) throw new Error("ASSET_TRANSFER_EMPTY");
            await this.check("container-transfer", p, { direction, itemName: item.name, count: item.count, observedBlock: blockName });
            this.transfer = { position: p, direction, itemName: item.name, count: item.count };
            try { return await originalPull(); } finally { this.transfer = null; }
          }) as typeof window[typeof method];
        };
        wrapPull("takeOutput", "withdraw"); wrapPull("takeInput", "deposit"); wrapPull("takeFuel", "deposit");
        window.once("close", () => { this.container = null; this.transfer = null; });
        return window;
      };
      bot.openFurnace = wrapped;
      this.restore.push(() => { if (bot.openFurnace === wrapped) bot.openFurnace = openFurnace; });
    }

    const open = bot.openContainer;
    if (typeof open === "function") {
      const wrapped: Bot["openContainer"] = async (block, ...args) => {
        const p = at(block.position), blockName = (block as { name?: string }).name;
        if (!blockName || blockName === "trapped_chest") throw new Error("ASSET_CONTAINER_UNCONFIRMED");
        await this.check("container-transfer", p, { direction: "inspect", observedBlock: blockName });
        // Double chests may include a protected input half. Check both halves
        // before opening; unknown block state is not treated as a single chest.
        if (blockName === "chest") {
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const neighbour = bot.blockAt(new Vec3(p.x + dx!, p.y, p.z + dz!));
            if (neighbour?.name === "chest") this.assert("container-transfer", neighbour.position, { direction: "inspect", observedBlock: "chest" });
          }
        }
        this.container = p;
        let window: Awaited<ReturnType<Bot["openContainer"]>>;
        try { window = await open.call(bot, block, ...args); }
        catch (error) { this.container = null; throw error; }
        for (const direction of ["withdraw", "deposit"] as const) {
          const originalTransfer = window[direction].bind(window);
          window[direction] = async (itemType: number, metadata: number | null, count: number | null) => {
            const itemName = bot.registry.items[itemType]?.name;
            if (!itemName || !Number.isSafeInteger(count) || !count || count <= 0) throw new Error("ASSET_TRANSFER_INVALID");
            if (this.transfer) throw new Error("ASSET_TRANSFER_BUSY");
            await this.check("container-transfer", p, { direction, itemName, count, observedBlock: blockName });
            const policy = this.records.find((r) => r.protection === "OUTPUT_ONLY" && JSON.stringify(r.position) === JSON.stringify(p));
            const available = window.containerItems().filter((i) => i.name === itemName).reduce((n, i) => n + i.count, 0);
            if (policy && direction === "withdraw" && available - count < policy.minimumRetained) throw new Error("ASSET_OUTPUT_RESERVE");
            this.transfer = { position: p, direction, itemName, count };
            try { await originalTransfer(itemType, metadata, count); }
            finally { this.transfer = null; }
          };
        }
        window.once("close", () => { this.container = null; this.transfer = null; });
        return window;
      };
      bot.openContainer = wrapped;
      this.restore.push(() => { if (bot.openContainer === wrapped) bot.openContainer = open; });
    }
    // Mineflayer's furnace/smoker helpers use openBlock rather than
    // openContainer. Keep that entry point under the same asset policy so a
    // seemingly harmless GUI helper cannot bypass machine protection.
    const openBlock = bot.openBlock;
    if (typeof openBlock === "function") {
      const wrapped: Bot["openBlock"] = async (block, ...args) => {
        const target = at(block.position);
        await this.check("container-transfer", target, { direction: "inspect", observedBlock: block.name });
        this.container = target;
        try {
          const window = await openBlock.call(bot, block, ...args);
          (window as unknown as { once?: (event: string, listener: () => void) => unknown }).once?.("close", () => {
            if (this.container && JSON.stringify(this.container) === JSON.stringify(target)) { this.container = null; this.transfer = null; }
          });
          return window;
        } catch (error) { this.container = null; throw error; }
      };
      bot.openBlock = wrapped;
      this.restore.push(() => { if (bot.openBlock === wrapped) bot.openBlock = openBlock; });
    }
    const updateSign = bot.updateSign;
    if (typeof updateSign === "function") {
      const wrapped: Bot["updateSign"] = (block, text, ...args) => {
        const target = at(block.position);
        // Sign writes are world effects and must be checked at the wire edge.
        this.assert("interact", target, { observedBlock: block.name });
        return updateSign.call(bot, block, text, ...args);
      };
      bot.updateSign = wrapped;
      this.restore.push(() => { if (bot.updateSign === wrapped) bot.updateSign = updateSign; });
    }
  }

  stop(): void { this.stopped = true; if (this.timer) clearInterval(this.timer); for (const restore of this.restore.reverse()) restore(); this.restore.length = 0; }
}
