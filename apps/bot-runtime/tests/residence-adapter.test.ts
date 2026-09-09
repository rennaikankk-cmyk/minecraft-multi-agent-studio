import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { bedSiteSchema } from "@minecraft-studio/base-management";
import { checkResidence, serverBedConfirmation } from "../src/residence-adapter.js";

const site = bedSiteSchema.parse({ siteId: "11111111-1111-4111-8111-111111111111", baseId: "base", scope: { serverProfileId: "srv", worldId: "w", dimension: "minecraft:overworld", botId: "Bot" }, head: { x: 1, y: 64, z: 0 }, foot: { x: 1, y: 64, z: 1 }, facing: "north", marker: { x: 2, y: 64, z: 1 }, standing: { x: 0, y: 64, z: 1 }, revision: 1, policyRevision: 1, source: "bot-built" });
const block = (name: string, p: any, props: any = {}) => ({ name, position: p, boundingBox: name === "air" ? "empty" : "block", getProperties: () => props });

describe("residence runtime adapter", () => {
  it("accepts only the root bed translation", () => {
    expect(serverBedConfirmation(JSON.stringify({ translate: "block.minecraft.bed.set_spawn" }))).toBe(true);
    expect(serverBedConfirmation(JSON.stringify({ text: { translate: "block.minecraft.bed.set_spawn" } }))).toBe(false);
    expect(serverBedConfirmation("Alice set your spawnpoint")).toBe(false);
  });
  it("reports inspect evidence without claiming a server bind", async () => {
    const client = new EventEmitter();
    const bot: any = { _client: client, blockAt: (p: any) => {
      if (p.x === 1 && p.y === 64 && p.z === 0) return block("white_bed", p, { part: "head", facing: "north", occupied: false });
      if (p.x === 1 && p.y === 64 && p.z === 1) return block("white_bed", p, { part: "foot", facing: "north", occupied: false });
      if (p.y === 63) return block("stone", p);
      return block("air", p);
    }};
    const result = await checkResidence({ schemaVersion: "1.0", site, operationId: "22222222-2222-4222-8222-222222222222", mode: "inspect" }, { bot, runtimeInstanceId: "rt", signal: new AbortController().signal, assertActive() {}, async authorize() {}, async approach() {} });
    expect(result.bedPresent).toBe(true); expect(result.usable).toBe(true); expect(result.binding).toBe("UNVERIFIED");
  });
});
