import { readFile, writeFile } from "node:fs/promises";
import { importSchematic } from "../apps/coordinator/dist/schematic-import.js";

const [source, optionsFile, destination, ...extra] = process.argv.slice(2);
if (!source || !optionsFile || !destination || extra.length) throw new Error("Usage: node scripts/import-schematic.mjs source.schem options.json destination.json");
const result = await importSchematic(await readFile(source), JSON.parse(await readFile(optionsFile, "utf8")));
await writeFile(destination, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
console.log(`Imported ${result.cells.length} blueprint cells.`);
