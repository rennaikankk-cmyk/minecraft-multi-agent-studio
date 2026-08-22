import type {
  CombatEntity,
  CombatEntityKind,
} from "@minecraft-studio/combat";

export type MineflayerCombatEntityView = Readonly<{
  id: number;
  type?: unknown;
  name?: unknown;
  username?: unknown;
  uuid?: unknown;
  metadata?: Readonly<Record<number, unknown>> | readonly unknown[];
}>;

export type MineflayerCombatRegistryView = Readonly<{
  entitiesByName?: Readonly<
    Record<
      string,
      Readonly<{ metadataKeys?: readonly string[] }> | undefined
    >
  >;
}>;

/**
 * Converts Mineflayer's read-only entity snapshot into the combat package's
 * deterministic identity input. It does not attack, rotate, or mutate either
 * object. `metadataKeys` comes from Mineflayer's version-selected
 * minecraft-data registry, so Enderman metadata is not tied to a packet index.
 */
export function combatEntityFromMineflayer(
  entity: MineflayerCombatEntityView,
  registry: MineflayerCombatRegistryView,
): CombatEntity {
  if (!Number.isSafeInteger(entity.id) || entity.id < 0) {
    throw new TypeError("Mineflayer combat entity ID must be non-negative.");
  }

  const mineflayerType = normalizedText(entity.type);
  const mobType = normalizedText(entity.name);
  const kind = combatKind(mineflayerType);
  const isEnderman =
    kind === "monster" &&
    (mobType === "enderman" || mobType === "minecraft:enderman");

  return {
    entityId: entity.id,
    kind,
    username: textOrNull(entity.username),
    uuid: textOrNull(entity.uuid),
    mobType: kind === "monster" || kind === "animal" ? mobType : null,
    endermanState: isEnderman
      ? readEndermanState(entity, registry, mobType)
      : null,
  };
}

function combatKind(type: string | null): CombatEntityKind {
  switch (type) {
    case "player":
      return "player";
    case "hostile":
      return "monster";
    case "animal":
      return "animal";
    case "object":
    case "orb":
    case "other":
    case "projectile":
    case "vehicle":
      return "object";
    default:
      return "unknown";
  }
}

function readEndermanState(
  entity: MineflayerCombatEntityView,
  registry: MineflayerCombatRegistryView,
  mobType: string,
): NonNullable<CombatEntity["endermanState"]> {
  const metadataKeys = registry.entitiesByName?.[mobType]?.metadataKeys;
  if (!metadataKeys) return "unknown";

  const creepy = namedBooleanMetadata(entity.metadata, metadataKeys, "creepy");
  const staredAt = namedBooleanMetadata(
    entity.metadata,
    metadataKeys,
    "stared_at",
  );
  if (creepy === true || staredAt === true) return "angry";
  if (creepy === false || staredAt === false) return "calm";
  return "unknown";
}

function namedBooleanMetadata(
  metadata: MineflayerCombatEntityView["metadata"],
  metadataKeys: readonly string[],
  name: string,
): boolean | null {
  const index = metadataKeys.indexOf(name);
  if (index < 0 || metadata === undefined) return null;
  const value = (metadata as Readonly<Record<number, unknown>>)[index];
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return null;
}

function normalizedText(value: unknown): string | null {
  const text = textOrNull(value);
  return text?.toLowerCase() ?? null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
