import { describe, expect, it } from "vitest";
import { writeUncompressed, type NBT } from "prismarine-nbt";
import { gzipSync } from "node:zlib";
import { importSchematic, transformSchematicCell } from "../src/schematic-import.js";
import { blueprintCellsForDispatch } from "../src/blueprint-files.js";

function fixture(palette: string, extra: NBT["value"] = {}) {
  return writeUncompressed({ type: "compound", name: "Schematic", value: {
    Version: { type: "int", value: 2 }, DataVersion: { type: "int", value: 3465 },
    Width: { type: "short", value: 1 }, Height: { type: "short", value: 1 }, Length: { type: "short", value: 1 },
    Palette: { type: "compound", value: { [palette]: { type: "int", value: 0 } } },
    BlockData: { type: "byteArray", value: [0] }, ...extra,
  } });
}
const options = { minecraftVersion: "1.20.1", name: "test-import", batchSize: 1, staging: [{ batch: 1, offset: { x: 1, y: 0, z: 0 } }] };
describe("schematic import", () => {
  it("imports a gzip Sponge schematic into the existing blueprint dispatch contract", async () => {
    const result = await importSchematic(gzipSync(fixture("minecraft:stone")), options);
    expect(result.cells).toEqual([{ item: "stone", offset: { x: 0, y: 0, z: 0 } }]);
    expect(blueprintCellsForDispatch(result)[0]).toMatchObject({ itemName: "stone", order: 0 });
  });
  it("retains blockstate requirements and transforms facing and axis", async () => {
    const result = await importSchematic(fixture("minecraft:oak_log[axis=x]"), { ...options, rotate: 90 });
    expect(blueprintCellsForDispatch(result)[0]?.blockProperties).toContainEqual({ name: "axis", value: "z" });
    const cell = transformSchematicCell({ offset: { x: 1, y: 0, z: 2 }, item: "furnace", blockProperties: [{ name: "facing", value: "north" }] },
      { rotate: 90, mirror: "x", replacements: [] });
    expect(cell).toMatchObject({ offset: { x: -2, y: 0, z: -1 }, blockProperties: [{ name: "facing", value: "east" }] });
  });
  it("refuses unknown palette entries instead of silently converting them to air", async () => {
    await expect(importSchematic(fixture("minecraft:unknown_material"), options)).rejects.toThrow("SCHEMATIC_PALETTE_VERSION_MISMATCH");
    await expect(importSchematic(fixture("minecraft:stone[imaginary=one]"), options)).rejects.toThrow("SCHEMATIC_PALETTE_VERSION_MISMATCH");
  });
  it("rejects entity NBT, malformed block data, oversized grids, and unsupported transforms", async () => {
    await expect(importSchematic(fixture("minecraft:stone", { Entities: { type: "list", value: { type: "compound", value: [{}] } } }), options)).rejects.toThrow("SCHEMATIC_NBT_UNSUPPORTED");
    await expect(importSchematic(fixture("minecraft:stone", { BlockData: { type: "byteArray", value: [] } }), options)).rejects.toThrow("SCHEMATIC_BLOCK_DATA_INVALID");
    await expect(importSchematic(fixture("minecraft:stone", { Width: { type: "short", value: 65 }, Height: { type: "short", value: 65 } }), options)).rejects.toThrow("SCHEMATIC_VOLUME_EXCEEDED");
    expect(() => transformSchematicCell({ offset: { x: 0, y: 0, z: 0 }, item: "rail", blockProperties: [{ name: "shape", value: "north_south" }] },
      { rotate: 90, mirror: "none", replacements: [] })).toThrow("SCHEMATIC_TRANSFORM_PROPERTY_UNSUPPORTED");
  });
});
