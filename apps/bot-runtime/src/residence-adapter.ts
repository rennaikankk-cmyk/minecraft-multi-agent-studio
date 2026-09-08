import { randomUUID } from "node:crypto";
import { Vec3 } from "vec3";
import type { Bot } from "mineflayer";
import { residenceCheckOutputSchema, respawnMarkerLines, type ResidenceCheckInput,
  type ResidenceCheckOutput } from "@minecraft-studio/base-management";

type Position = { x: number; y: number; z: number };
const vec = (p: Position) => new Vec3(p.x, p.y, p.z);
const same = (a: Position | undefined, b: Position) => !!a && a.x === b.x && a.y === b.y && a.z === b.z;
const air = (b: ReturnType<Bot["blockAt"]>) => !!b && b.boundingBox === "empty" &&
  !/water|lava|fire|powder_snow|cactus|berry|web/u.test(b.name);

/** Only the root translation component of a server packet is a confirmation.
 * Player text, nested quoted components and rendered regular expressions are not. */
export function serverBedConfirmation(raw: unknown): boolean {
  try {
    const message = typeof raw === "string" ? JSON.parse(raw) : raw;
    return !!message && typeof message === "object" && !Array.isArray(message) &&
      (message as { translate?: unknown }).translate === "block.minecraft.bed.set_spawn";
  } catch { return false; }
}

export interface ResidencePort {
  bot: Bot;
  runtimeInstanceId: string;
  signal: AbortSignal;
  assertActive(): void;
  authorize(action: "use" | "place", target: Position, blockName: string): Promise<void>;
  approach(target: Position): Promise<void>;
}

/** One bounded server operation. Durable home/bed assignment stays in the
 * Coordinator; these results report only observations made by this Runtime. */
export async function checkResidence(input: ResidenceCheckInput, port: ResidencePort): Promise<ResidenceCheckOutput> {
  const { bot } = port, { site } = input;
  const now = () => new Date().toISOString();
  const output: ResidenceCheckOutput = {
    schemaVersion: "1.0", siteId: site.siteId, siteRevision: site.revision, operationId: input.operationId,
    ...site.scope, dimension: "minecraft:overworld", runtimeInstanceId: port.runtimeInstanceId,
    bedPresent: false, usable: false, markerPresent: false, binding: "UNVERIFIED", bindingEvidence: null,
    marker: "UNVERIFIED", markerText: null, markerEvidence: null, observedAt: now(), reason: null,
  };
  const finish = (reason: string | null) => residenceCheckOutputSchema.parse({ ...output, observedAt: now(), reason });
  port.assertActive();
  const bed = bot.blockAt(vec(site.head)), foot = bot.blockAt(vec(site.foot));
  if (!bed || !foot) return finish("BED_CHUNK_UNLOADED");
  const hp = bed.getProperties(), fp = foot.getProperties();
  output.bedPresent = /_bed$/u.test(bed.name) && bed.name === foot.name && hp.part === "head" &&
    fp.part === "foot" && hp.facing === site.facing && fp.facing === site.facing;
  if (!output.bedPresent) { output.binding = "INVALID"; return finish("BED_MISSING_OR_REPLACED"); }
  output.usable = hp.occupied !== true && air(bot.blockAt(vec(site.head).offset(0, 1, 0))) &&
    air(bot.blockAt(vec(site.foot).offset(0, 1, 0))) && air(bot.blockAt(vec(site.standing))) &&
    air(bot.blockAt(vec(site.standing).offset(0, 1, 0))) &&
    bot.blockAt(vec(site.standing).offset(0, -1, 0))?.boundingBox === "block";
  if (!output.usable) return finish("BED_SITE_BLOCKED");
  let marker = bot.blockAt(vec(site.marker));
  if (!marker) return finish("MARKER_CHUNK_UNLOADED");
  output.markerPresent = /(?:_sign|_wall_sign)$/u.test(marker.name) && !marker.name.includes("hanging");
  if (input.mode === "inspect") return finish(null);
  if (input.mode === "bind") {
    await port.approach(site.head);
    await port.authorize("use", site.head, bed.name);
    port.assertActive();
    const interactionId = randomUUID();
    const result = await observeEvent(bot._client, "systemChat", port.signal, 4_000,
      (packet: unknown) => serverBedConfirmation((packet as { formattedMessage?: unknown })?.formattedMessage),
      async () => { await bot.activateBlock(bed); });
    if (result) {
      output.binding = "SERVER_CONFIRMED";
      output.bindingEvidence = { type: "server-translation", translation: "block.minecraft.bed.set_spawn", receivedAt: now(), interactionId };
    }
    return finish(result ? null : "BED_BINDING_WAITING_CONFIRMATION");
  }
  await port.approach(site.marker);
  if (!output.markerPresent) {
    if (!air(marker)) return finish("MARKER_SITE_OCCUPIED");
    const sign = bot.inventory.items().find((i) => /_sign$/u.test(i.name) && !i.name.includes("hanging"));
    if (!sign) return finish("MARKER_MATERIAL_REQUIRED");
    const support = bot.blockAt(vec(site.marker).offset(0, -1, 0));
    if (!support || support.boundingBox !== "block") return finish("MARKER_SUPPORT_UNAVAILABLE");
    await port.authorize("place", site.marker, "air");
    port.assertActive();
    await bot.equip(sign, "hand");
    const opened = await observeEvent(bot, "signOpen", port.signal, 4_000,
      (block: unknown) => same((block as { position?: Position })?.position, site.marker),
      async () => { await bot.placeBlock(support, new Vec3(0, 1, 0)); });
    marker = bot.blockAt(vec(site.marker));
    if (!opened || !marker || !/_sign$/u.test(marker.name)) return finish("MARKER_PLACEMENT_UNCONFIRMED");
    output.markerPresent = true;
  } else {
    await port.authorize("use", site.marker, marker.name);
    const opened = await observeEvent(bot, "signOpen", port.signal, 3_000,
      (block: unknown) => same((block as { position?: Position })?.position, site.marker),
      async () => { await bot.activateBlock(marker!); });
    if (!opened) return finish("MARKER_EDIT_UNAVAILABLE");
  }
  port.assertActive();
  const expected = respawnMarkerLines(site.scope.botId);
  const updated = await observeEvent(bot, "blockEntityData", port.signal, 4_000,
    (block: unknown) => same((block as { position?: Position })?.position, site.marker),
    async () => { bot.updateSign(marker!, expected, false); });
  if (updated) {
    const readback = bot.blockAt(vec(site.marker)) as unknown as { signText?: string | string[] } | null;
    const text = typeof readback?.signText === "string" ? readback.signText : readback?.signText?.join("\n");
    output.markerText = text ?? null;
    if (text?.replace(/\s/gu, "") === expected.replace(/\s/gu, "")) {
      output.marker = "SERVER_CONFIRMED";
      output.markerEvidence = { type: "server-block-entity", receivedAt: now() };
    }
  }
  return finish(output.marker === "SERVER_CONFIRMED" ? null : "MARKER_READBACK_UNCONFIRMED");
}

async function observeEvent(emitter: { on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown }, event: string,
  signal: AbortSignal, timeoutMs: number, accepts: (value: unknown) => boolean, action: () => Promise<void>): Promise<boolean> {
  let cleanup = () => {};
  const observation = new Promise<boolean>((resolve, reject) => {
    const handler = (value: unknown) => { if (accepts(value)) { cleanup(); resolve(true); } };
    const abort = () => { cleanup(); reject(new Error("SKILL_CANCELLED")); };
    const timer = setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
    cleanup = () => { clearTimeout(timer); emitter.removeListener(event, handler); signal.removeEventListener("abort", abort); };
    emitter.on(event, handler); signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  // Attach rejection before the action to avoid an unhandled cancel during I/O.
  observation.catch(() => {});
  try { await action(); return await observation; } finally { cleanup(); }
}
