import { gunzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { Schematic } from "prismarine-schematic";
import { parseUncompressed, simplify } from "prismarine-nbt";
import { z } from "zod";
import { blueprintFileSchema, validateStagingGeometry, type BlueprintFileCell } from "./blueprint-files.js";

const require = createRequire(import.meta.url);
const { parseBlockName } = require("prismarine-schematic/lib/states.js") as {
  parseBlockName(name: string): { name: string; properties: [string, string][] };
};
const coordinate = z.object({ x: z.number().int().min(-64).max(64), y: z.number().int().min(-64).max(64), z: z.number().int().min(-64).max(64) }).strict();
export const schematicImportOptionsSchema = z.object({
  minecraftVersion: z.string().regex(/^1\.\d+(?:\.\d+)?$/),
  name: blueprintFileSchema.shape.name,
  description: z.string().max(500).default("Imported schematic"),
  batchSize: blueprintFileSchema.shape.batchSize,
  staging: blueprintFileSchema.shape.staging,
  rotate: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
  mirror: z.enum(["none", "x", "z"]).default("none"),
  selection: z.object({ min: coordinate, max: coordinate }).strict().optional(),
  replacements: z.array(z.object({ from: z.string().regex(/^[a-z0-9_]+$/), to: z.string().regex(/^[a-z0-9_]+$/) }).strict()).max(64).default([]),
}).strict();
type Options = z.infer<typeof schematicImportOptionsSchema>;
const directions = ["north", "east", "south", "west"];

export function transformSchematicCell(cell: BlueprintFileCell, options: Pick<Options, "rotate" | "mirror" | "replacements">): BlueprintFileCell {
  let { x, y, z } = cell.offset;
  if (options.mirror === "x") x = -x;
  if (options.mirror === "z") z = -z;
  for (let turn = 0; turn < options.rotate / 90; turn++) [x, z] = [-z, x];
  const direction = (value: string): string => {
    let index = directions.indexOf(value);
    if (index < 0) return value;
    if (options.mirror === "x") index = (4 - index) % 4;
    if (options.mirror === "z") index = (2 - index + 4) % 4;
    return directions[(index + options.rotate / 90) % 4]!;
  };
  const transformed = options.rotate !== 0 || options.mirror !== "none";
  const blockProperties = (cell.blockProperties ?? []).map(({ name, value }) => {
    if (name === "facing" && typeof value === "string") value = direction(value);
    else if (name === "axis" && options.rotate % 180 !== 0 && (value === "x" || value === "z")) value = value === "x" ? "z" : "x";
    else if (name === "rotation" && typeof value === "number") {
      if (options.mirror === "x") value = (16 - value) % 16;
      if (options.mirror === "z") value = (8 - value + 16) % 16;
      value = (value + options.rotate / 22.5) % 16;
    } else if (transformed && ["shape", "hinge", "orientation"].includes(name)) {
      throw new Error("SCHEMATIC_TRANSFORM_PROPERTY_UNSUPPORTED");
    }
    return { name: direction(name), value };
  });
  const replacement = options.replacements.find((entry) => entry.from === cell.item)?.to;
  if (replacement && replacement !== cell.item && blockProperties.length > 0) throw new Error("SCHEMATIC_REPLACEMENT_PROPERTIES_UNSUPPORTED");
  return { ...cell, offset: { x, y, z }, item: replacement ?? cell.item, ...(blockProperties.length ? { blockProperties } : {}) };
}

/** Bounded offline import. No world writes, shell commands, entity/NBT reconstruction, or version guessing. */
export async function importSchematic(buffer: Buffer, rawOptions: unknown) {
  const options = schematicImportOptionsSchema.parse(rawOptions);
  if (buffer.length > 2_000_000) throw new Error("SCHEMATIC_FILE_TOO_LARGE");
  const decompressed = buffer[0] === 0x1f && buffer[1] === 0x8b ? gunzipSync(buffer, { maxOutputLength: 4_000_000 }) : buffer;
  const root = simplify(parseUncompressed(decompressed)) as Record<string, unknown>;
  const dimension = z.number().int().min(1).max(65);
  const width = dimension.parse(root.Width), height = dimension.parse(root.Height), length = dimension.parse(root.Length);
  const volume = width * height * length;
  if (volume > 4096) throw new Error("SCHEMATIC_VOLUME_EXCEEDED");
  for (const key of ["Entities", "TileEntities", "BlockEntities"]) {
    if (root[key] !== undefined && (!Array.isArray(root[key]) || root[key].length > 0)) throw new Error("SCHEMATIC_NBT_UNSUPPORTED");
  }
  if (root.Version !== undefined && root.Version !== 2) throw new Error("SCHEMATIC_FORMAT_UNSUPPORTED");
  if (root.Version === undefined && root.Materials !== "Alpha") throw new Error("SCHEMATIC_FORMAT_UNSUPPORTED");
  const palette = root.Palette === undefined ? null : z.record(z.string().regex(/^minecraft:[a-z0-9_]+(?:\[[a-z0-9_=,]+\])?$/), z.number().int().min(0).max(4095)).parse(root.Palette);
  const schematic = await Schematic.read(decompressed, options.minecraftVersion);
  if (schematic.blocks.length !== volume || schematic.blocks.some((id) => !Number.isInteger(id) || schematic.palette[id] === undefined)) {
    throw new Error("SCHEMATIC_BLOCK_DATA_INVALID");
  }
  if (palette) {
    for (const [state, index] of Object.entries(palette)) {
      const expected = parseBlockName(state);
      const stateId = schematic.palette[index];
      if (stateId === undefined) throw new Error("SCHEMATIC_PALETTE_INVALID");
      const actual = schematic.Block.fromStateId(stateId, 0);
      const properties = actual.getProperties();
      if (actual.name !== expected.name || expected.properties.some(([key, value]) => String(properties[key]) !== value)) {
        throw new Error("SCHEMATIC_PALETTE_VERSION_MISMATCH");
      }
    }
  }
  const cells: BlueprintFileCell[] = [];
  for (let y = 0; y < height; y++) for (let z = 0; z < length; z++) for (let x = 0; x < width; x++) {
    const selection = options.selection;
    if (selection && (x < selection.min.x || x > selection.max.x || y < selection.min.y || y > selection.max.y || z < selection.min.z || z > selection.max.z)) continue;
    const block = schematic.getBlock(schematic.start().offset(x, y, z));
    if (["air", "cave_air", "void_air"].includes(block.name)) continue;
    const properties = Object.entries(block.getProperties()).map(([name, value]) => ({ name, value }));
    cells.push(transformSchematicCell({ offset: { x, y, z }, item: block.name, ...(properties.length ? { blockProperties: properties } : {}) }, options));
  }
  const result = blueprintFileSchema.parse({ schemaVersion: "1.0", name: options.name, description: options.description,
    batchSize: options.batchSize, staging: options.staging, cells,
    notes: `Imported using prismarine-schematic 1.3.0 for ${options.minecraftVersion}. Air omitted; explicit clearing is a separate operation.` });
  validateStagingGeometry(result);
  return result;
}
