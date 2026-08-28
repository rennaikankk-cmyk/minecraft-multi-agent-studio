import minecraftData from "minecraft-data";

export type CombatExplosionVector = Readonly<{
  x: number;
  y: number;
  z: number;
}>;

export type CombatExplosionObservation = Readonly<{
  center: CombatExplosionVector;
  knockback: CombatExplosionVector | null;
  radiusIfPresent: number | null;
  blockCountIfPresent: number | null;
  observedAtMs: number;
  serverProfileId: string;
  dimension: string;
}>;

export type ExplosionPacketSchemaKind =
  | "LEGACY_OFFSETS_AND_MOTION"
  | "XYZ_OPTIONAL_VEC3F"
  | "XYZ_OPTIONAL_VEC3F64"
  | "CENTERED_BLOCK_PARTICLES";

export type ExplosionPacketAdapterErrorCode =
  | "EXPLOSION_PROTOCOL_VERSION_UNAVAILABLE"
  | "EXPLOSION_PACKET_SCHEMA_UNSUPPORTED"
  | "EXPLOSION_PACKET_INVALID";

export class ExplosionPacketAdapterError extends Error {
  constructor(readonly code: ExplosionPacketAdapterErrorCode) {
    super(code);
    this.name = "ExplosionPacketAdapterError";
  }
}

type PacketField = Readonly<{ name: string; type: unknown }>;

const LEGACY_FIELD_NAMES = [
  "x",
  "y",
  "z",
  "radius",
  "affectedBlockOffsets",
  "playerMotionX",
  "playerMotionY",
  "playerMotionZ",
  "block_interaction_type",
  "small_explosion_particle",
  "large_explosion_particle",
  "sound",
] as const;

const XYZ_FIELD_NAMES = [
  "x",
  "y",
  "z",
  "playerKnockback",
  "explosionParticle",
  "sound",
] as const;

const CENTERED_FIELD_NAMES = [
  "center",
  "radius",
  "blockCount",
  "playerKnockback",
  "explosionParticle",
  "sound",
  "blockParticles",
] as const;

/**
 * Read-only normalization of the clientbound explosion packet. Schema shape
 * is resolved once at construction so an unknown protocol fails before a
 * combat packet can arrive. Explosion power is intentionally absent: callers
 * derive it from the observed source and combat's BLAST_POWER constants.
 */
export class ExplosionPacketAdapter {
  readonly schemaKind: ExplosionPacketSchemaKind;

  constructor(readonly minecraftVersion: string) {
    if (minecraftVersion.trim().length === 0) {
      throw new ExplosionPacketAdapterError(
        "EXPLOSION_PROTOCOL_VERSION_UNAVAILABLE",
      );
    }
    const data = minecraftData(minecraftVersion) as
      | { type?: unknown; protocol?: unknown }
      | null;
    if (data === null || data.type !== "pc" || data.protocol === undefined) {
      throw new ExplosionPacketAdapterError(
        "EXPLOSION_PROTOCOL_VERSION_UNAVAILABLE",
      );
    }
    const fields = explosionPacketFields(data.protocol);
    this.schemaKind = identifySchema(fields);
  }

  adapt(
    packet: unknown,
    context: Readonly<{
      observedAtMs: number;
      serverProfileId: string;
      dimension: string;
    }>,
  ): CombatExplosionObservation {
    validateContext(context);
    const record = asRecord(packet);
    if (record === null) invalidPacket();

    switch (this.schemaKind) {
      case "LEGACY_OFFSETS_AND_MOTION": {
        requireArray(record, "affectedBlockOffsets");
        return observation(
          vectorFromFields(record, "x", "y", "z"),
          vectorFromFields(
            record,
            "playerMotionX",
            "playerMotionY",
            "playerMotionZ",
          ),
          nonNegativeNumber(record, "radius"),
          null,
          context,
        );
      }
      case "XYZ_OPTIONAL_VEC3F":
      case "XYZ_OPTIONAL_VEC3F64":
        return observation(
          vectorFromFields(record, "x", "y", "z"),
          optionalVector(record, "playerKnockback"),
          null,
          null,
          context,
        );
      case "CENTERED_BLOCK_PARTICLES": {
        requireArray(record, "blockParticles");
        return observation(
          requiredVector(record, "center"),
          optionalVector(record, "playerKnockback"),
          nonNegativeNumber(record, "radius"),
          nonNegativeInteger(record, "blockCount"),
          context,
        );
      }
    }
  }
}

function explosionPacketFields(protocol: unknown): readonly PacketField[] {
  const packetType = asRecord(asRecord(asRecord(protocol)?.play)?.toClient)
    ?.types;
  const explosion = asRecord(packetType)?.packet_explosion;
  if (
    !Array.isArray(explosion) ||
    explosion.length !== 2 ||
    explosion[0] !== "container" ||
    !Array.isArray(explosion[1])
  ) {
    throw new ExplosionPacketAdapterError(
      "EXPLOSION_PACKET_SCHEMA_UNSUPPORTED",
    );
  }
  return explosion[1].map((value) => {
    const field = asRecord(value);
    if (field === null || typeof field.name !== "string" || !("type" in field)) {
      throw new ExplosionPacketAdapterError(
        "EXPLOSION_PACKET_SCHEMA_UNSUPPORTED",
      );
    }
    return { name: field.name, type: field.type };
  });
}

function identifySchema(fields: readonly PacketField[]): ExplosionPacketSchemaKind {
  const byName = new Map(fields.map((field) => [field.name, field.type]));
  if (
    exactFieldNames(fields, LEGACY_FIELD_NAMES) &&
    primitiveFields(byName, ["x", "y", "z"], "f64") &&
    primitiveFields(byName, ["radius", "playerMotionX", "playerMotionY", "playerMotionZ"], "f32") &&
    taggedType(byName.get("affectedBlockOffsets"), "array")
  ) {
    return "LEGACY_OFFSETS_AND_MOTION";
  }
  if (
    exactFieldNames(fields, XYZ_FIELD_NAMES) &&
    primitiveFields(byName, ["x", "y", "z"], "f64") &&
    optionType(byName.get("playerKnockback"), "vec3f")
  ) {
    return "XYZ_OPTIONAL_VEC3F";
  }
  if (
    exactFieldNames(fields, XYZ_FIELD_NAMES) &&
    primitiveFields(byName, ["x", "y", "z"], "f64") &&
    optionType(byName.get("playerKnockback"), "vec3f64")
  ) {
    return "XYZ_OPTIONAL_VEC3F64";
  }
  if (
    exactFieldNames(fields, CENTERED_FIELD_NAMES) &&
    byName.get("center") === "vec3f64" &&
    byName.get("radius") === "f32" &&
    byName.get("blockCount") === "i32" &&
    optionType(byName.get("playerKnockback"), "vec3f64") &&
    taggedType(byName.get("blockParticles"), "array")
  ) {
    return "CENTERED_BLOCK_PARTICLES";
  }
  throw new ExplosionPacketAdapterError(
    "EXPLOSION_PACKET_SCHEMA_UNSUPPORTED",
  );
}

function exactFieldNames(
  fields: readonly PacketField[],
  names: readonly string[],
): boolean {
  return fields.length === names.length &&
    fields.every((field, index) => field.name === names[index]);
}

function primitiveFields(
  fields: ReadonlyMap<string, unknown>,
  names: readonly string[],
  type: string,
): boolean {
  return names.every((name) => fields.get(name) === type);
}

function optionType(value: unknown, vectorType: string): boolean {
  return Array.isArray(value) &&
    value.length === 2 &&
    value[0] === "option" &&
    value[1] === vectorType;
}

function taggedType(value: unknown, tag: string): boolean {
  return Array.isArray(value) && value.length === 2 && value[0] === tag;
}

function observation(
  center: CombatExplosionVector,
  knockback: CombatExplosionVector | null,
  radiusIfPresent: number | null,
  blockCountIfPresent: number | null,
  context: Readonly<{
    observedAtMs: number;
    serverProfileId: string;
    dimension: string;
  }>,
): CombatExplosionObservation {
  return {
    center,
    knockback,
    radiusIfPresent,
    blockCountIfPresent,
    observedAtMs: context.observedAtMs,
    serverProfileId: context.serverProfileId,
    dimension: context.dimension,
  };
}

function optionalVector(
  record: Record<string, unknown>,
  key: string,
): CombatExplosionVector | null {
  if (!Object.hasOwn(record, key)) invalidPacket();
  return record[key] === null ? null : requiredVector(record, key);
}

function requiredVector(
  record: Record<string, unknown>,
  key: string,
): CombatExplosionVector {
  const value = record[key];
  if (Array.isArray(value) && value.length === 3) {
    return vector(value[0], value[1], value[2]);
  }
  const nested = asRecord(value);
  if (nested === null) invalidPacket();
  return vector(nested.x, nested.y, nested.z);
}

function vectorFromFields(
  record: Record<string, unknown>,
  x: string,
  y: string,
  z: string,
): CombatExplosionVector {
  return vector(record[x], record[y], record[z]);
}

function vector(x: unknown, y: unknown, z: unknown): CombatExplosionVector {
  if (![x, y, z].every((value) =>
    typeof value === "number" && Number.isFinite(value)
  )) {
    invalidPacket();
  }
  return { x: Number(x), y: Number(y), z: Number(z) };
}

function nonNegativeNumber(
  record: Record<string, unknown>,
  key: string,
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    invalidPacket();
  }
  return value;
}

function nonNegativeInteger(
  record: Record<string, unknown>,
  key: string,
): number {
  const value = nonNegativeNumber(record, key);
  if (!Number.isSafeInteger(value)) invalidPacket();
  return value;
}

function requireArray(
  record: Record<string, unknown>,
  key: string,
): readonly unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) invalidPacket();
  return value;
}

function validateContext(context: Readonly<{
  observedAtMs: number;
  serverProfileId: string;
  dimension: string;
}>): void {
  if (
    !Number.isSafeInteger(context.observedAtMs) ||
    context.observedAtMs < 0 ||
    context.serverProfileId.trim().length === 0 ||
    context.dimension.trim().length === 0
  ) {
    invalidPacket();
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function invalidPacket(): never {
  throw new ExplosionPacketAdapterError("EXPLOSION_PACKET_INVALID");
}
