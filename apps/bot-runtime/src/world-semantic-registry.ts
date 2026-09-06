import { importantBlockNames } from "./world-state.js";

export const SEMANTIC_SELECTOR_REVISION = 1 as const;
export const SEMANTIC_UNKNOWN = 0x80000000;
export const MAX_REGISTRY_STATES = 1_048_576;
export type RegistryBlock = { name: string; minStateId: number; maxStateId: number; boundingBox?: string };

/** Stable wire IDs: original P5 24 interests, independent of movement bits. */
export const semanticSelectorNames = Object.freeze([...importantBlockNames]);
const colors = ["white", "orange", "magenta", "light_blue", "yellow", "lime", "pink", "gray", "light_gray", "cyan", "purple", "blue", "brown", "green", "red", "black"];
const beds = new Set(colors.map((color) => `${color}_bed`));
const shulkers = new Set(["shulker_box", ...colors.map((color) => `${color}_shulker_box`)]);

export function semanticSelectorMask(name: string): number {
  const id = semanticSelectorNames.indexOf(name as (typeof importantBlockNames)[number]);
  if (id < 0) throw new Error(`unknown semantic selector: ${name}`);
  return 2 ** id;
}

/** Exact names except explicit color families; all block states share membership. */
export function selectorsForBlock(name: string): number {
  const normalized = beds.has(name) ? "bed" : shulkers.has(name) ? "shulker_box" : name;
  const id = semanticSelectorNames.indexOf(normalized as (typeof importantBlockNames)[number]);
  return id < 0 ? 0 : 2 ** id;
}

export function registryStateCount(blocks: readonly RegistryBlock[]): number {
  let max = -1;
  for (const b of blocks) {
    if (!Number.isSafeInteger(b.minStateId) || !Number.isSafeInteger(b.maxStateId) || b.minStateId < 0 || b.maxStateId < b.minStateId || b.maxStateId >= MAX_REGISTRY_STATES) {
      throw new Error("unsupported registry state range");
    }
    max = Math.max(max, b.maxStateId);
  }
  if (max < 0) throw new Error("empty block registry");
  return max + 1;
}

export function buildSemanticSelectors(blocks: readonly RegistryBlock[]): Uint32Array {
  const selectors = new Uint32Array(registryStateCount(blocks)).fill(SEMANTIC_UNKNOWN);
  for (const block of blocks) selectors.fill(selectorsForBlock(block.name), block.minStateId, block.maxStateId + 1);
  return selectors;
}

/** Observed metadata only. Low four movement bits retain classifyBlock's policy. */
export const MOVEMENT_METADATA = Object.freeze({ WATER: 1 << 4, LAVA: 1 << 5, FIRE: 1 << 6, FALLING: 1 << 7, CLIMBABLE: 1 << 8, CONTAINER: 1 << 9 });
export function movementMetadata(name: string): number {
  let mask = 0;
  if (name === "water") mask |= MOVEMENT_METADATA.WATER;
  if (name === "lava") mask |= MOVEMENT_METADATA.LAVA;
  if (name === "fire" || name === "soul_fire") mask |= MOVEMENT_METADATA.FIRE;
  if (["sand", "red_sand", "gravel", "anvil", "chipped_anvil", "damaged_anvil"].includes(name) || name.endsWith("_concrete_powder")) mask |= MOVEMENT_METADATA.FALLING;
  if (["ladder", "vine", "scaffolding", "weeping_vines", "weeping_vines_plant", "twisting_vines", "twisting_vines_plant"].includes(name)) mask |= MOVEMENT_METADATA.CLIMBABLE;
  if (["chest", "trapped_chest", "ender_chest", "barrel", "hopper", "dispenser", "dropper", "furnace", "blast_furnace", "smoker"].includes(name) || shulkers.has(name)) mask |= MOVEMENT_METADATA.CONTAINER;
  return mask;
}
