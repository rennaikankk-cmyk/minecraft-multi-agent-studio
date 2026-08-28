import { describe, expect, it } from "vitest";

import {
  ExplosionPacketAdapter,
  ExplosionPacketAdapterError,
} from "../src/explosion-packet-adapter.js";

const CONTEXT = {
  observedAtMs: 1_000,
  serverProfileId: "local-isolated-test",
  dimension: "minecraft:overworld",
} as const;

describe("ExplosionPacketAdapter schema detection", () => {
  it.each([
    ["1.21.1", "LEGACY_OFFSETS_AND_MOTION"],
    ["1.21.3", "XYZ_OPTIONAL_VEC3F"],
    ["1.21.4", "XYZ_OPTIONAL_VEC3F64"],
    ["1.21.5", "XYZ_OPTIONAL_VEC3F64"],
    ["1.21.8", "XYZ_OPTIONAL_VEC3F64"],
    ["1.21.9", "CENTERED_BLOCK_PARTICLES"],
    ["1.21.11", "CENTERED_BLOCK_PARTICLES"],
  ] as const)("reads the installed %s protocol schema", (version, kind) => {
    expect(new ExplosionPacketAdapter(version).schemaKind).toBe(kind);
  });

  it("rejects 1.21.0 because this install has no exact protocol data", () => {
    expect(() => new ExplosionPacketAdapter("1.21.0")).toThrowError(
      expect.objectContaining({
        code: "EXPLOSION_PROTOCOL_VERSION_UNAVAILABLE",
      }),
    );
  });

  it("rejects an unknown packet schema at construction time", () => {
    expect(() => new ExplosionPacketAdapter("1.19.4")).toThrowError(
      ExplosionPacketAdapterError,
    );
  });
});

describe("ExplosionPacketAdapter normalization", () => {
  it("normalizes the 1.21.1 radius, offsets shape, and split motion", () => {
    const result = new ExplosionPacketAdapter("1.21.1").adapt({
      x: 1,
      y: 2,
      z: 3,
      radius: 4,
      affectedBlockOffsets: [{ x: 0, y: 0, z: 0 }],
      playerMotionX: 0.25,
      playerMotionY: 0.5,
      playerMotionZ: -0.25,
    }, CONTEXT);
    expect(result).toEqual({
      center: { x: 1, y: 2, z: 3 },
      knockback: { x: 0.25, y: 0.5, z: -0.25 },
      radiusIfPresent: 4,
      blockCountIfPresent: null,
      ...CONTEXT,
    });
  });

  it("normalizes optional float and double knockback without reading radius", () => {
    const floatResult = new ExplosionPacketAdapter("1.21.3").adapt({
      x: 1,
      y: 2,
      z: 3,
      playerKnockback: { x: 0.1, y: 0.2, z: 0.3 },
      radius: 999,
    }, CONTEXT);
    expect(floatResult).toMatchObject({
      knockback: { x: 0.1, y: 0.2, z: 0.3 },
      radiusIfPresent: null,
      blockCountIfPresent: null,
    });

    const doubleResult = new ExplosionPacketAdapter("1.21.8").adapt({
      x: 4,
      y: 5,
      z: 6,
      playerKnockback: null,
    }, CONTEXT);
    expect(doubleResult.knockback).toBeNull();
    expect(doubleResult).not.toHaveProperty("power");
  });

  it("normalizes centered packets with explicit block counts", () => {
    const result = new ExplosionPacketAdapter("1.21.11").adapt({
      center: { x: 7, y: 8, z: 9 },
      radius: 5,
      blockCount: 12,
      playerKnockback: [0, 0.4, -0.2],
      blockParticles: [],
    }, CONTEXT);
    expect(result).toMatchObject({
      center: { x: 7, y: 8, z: 9 },
      knockback: { x: 0, y: 0.4, z: -0.2 },
      radiusIfPresent: 5,
      blockCountIfPresent: 12,
    });
  });

  it("fails loudly on malformed packet data or context", () => {
    const adapter = new ExplosionPacketAdapter("1.21.8");
    expect(() => adapter.adapt({
      x: 1,
      y: 2,
      z: 3,
    }, CONTEXT)).toThrowError(
      expect.objectContaining({ code: "EXPLOSION_PACKET_INVALID" }),
    );
    expect(() => adapter.adapt({
      x: 1,
      y: 2,
      z: 3,
      playerKnockback: null,
    }, { ...CONTEXT, serverProfileId: " " })).toThrowError(
      ExplosionPacketAdapterError,
    );
  });
});
