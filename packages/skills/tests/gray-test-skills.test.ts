import { describe, expect, it } from "vitest";

function evaluatePreconditions(skill: { preconditions: ReadonlyArray<{ id: string; failureCode: string; check: (input: unknown, state: unknown, policy?: unknown) => boolean }> }, input: unknown, state: unknown) {
  const policy = { checkBlockReach: (distance: number) => distance <= 6 };
  for (const precondition of skill.preconditions) {
    if (!precondition.check(input, state, policy)) {
      return { ok: false, failureCode: precondition.failureCode };
    }
  }
  return { ok: true, failureCode: null };
}

import {
  animalBreedInputSchema,
  animalBreedSkill,
  breedFoodAccepted,
  BREED_FOOD_BY_ANIMAL,
  fluidPlaceInputSchema,
  fluidPlaceSkill,
  inventoryDropInputSchema,
  inventoryDropSkill,
} from "../src/index.js";

function onlineState(extra: Record<string, unknown> = {}) {
  return {
    online: true,
    normalActionsAllowed: true,
    serverProfileId: "srv-test",
    position: {
      x: 0, y: 64, z: 0,
      dimension: "minecraft:overworld",
      serverProfileId: "srv-test",
      yaw: 0,
      pitch: 0,
    },
    ...extra,
  };
}

const baseInput = { serverProfileId: "srv-test" };

describe("inventory.drop", () => {
  it("parses minimal input with defaulted reserve", () => {
    const parsed = inventoryDropInputSchema.parse({
      itemName: "cobblestone",
      count: 32,
      ...baseInput,
    });
    expect(parsed.keepReserve).toBe(0);
  });

  it("rejects count 0 / unknown props / bad item names", () => {
    expect(inventoryDropInputSchema.safeParse({ itemName: "cobblestone", count: 0, ...baseInput }).success).toBe(false);
    expect(inventoryDropInputSchema.safeParse({ itemName: "Cobblestone", count: 1, ...baseInput }).success).toBe(false);
    expect(inventoryDropInputSchema.safeParse({ itemName: "cobblestone", count: 1, extra: true, ...baseInput }).success).toBe(false);
  });

  it("fails closed on unknown counts (INVENTORY_COUNT_UNKNOWN)", async () => {
    const state = onlineState({ heldItemCount: null });
    const result = evaluatePreconditions(inventoryDropSkill, 
      inventoryDropInputSchema.parse({ itemName: "cobblestone", count: 1, ...baseInput }),
      state as never,
    );
    expect(result?.ok).toBe(false);
    expect((result as { failureCode: string }).failureCode).toBe("INVENTORY_COUNT_UNKNOWN");
  });

  it("rejects dropping more than held minus reserve", async () => {
    const state = onlineState({ heldItemCount: 10 });
    const input = inventoryDropInputSchema.parse({ itemName: "cobblestone", count: 8, keepReserve: 4, ...baseInput });
    const result = evaluatePreconditions(inventoryDropSkill, input, state as never);
    expect((result as { failureCode: string }).failureCode).toBe("INVENTORY_INSUFFICIENT_ITEMS");
  });

  it("state schema accepts runtime position with yaw/pitch (G4)", () => {
    const skill = inventoryDropSkill as unknown as { stateSchema: { safeParse(v: unknown): { success: boolean } } };
    expect(skill.stateSchema.safeParse(onlineState({ heldItemCount: 5 })).success).toBe(true);
  });
});

describe("fluid.place", () => {
  it("parses place and scoop modes", () => {
    expect(fluidPlaceInputSchema.parse({
      mode: "place", itemName: "water_bucket",
      referenceBlock: { x: 0, y: 64, z: 0 }, face: { x: 1, y: 0, z: 0 },
      dimension: "minecraft:overworld", ...baseInput,
    }).mode).toBe("place");
    expect(fluidPlaceInputSchema.parse({
      mode: "scoop", target: { x: 1, y: 64, z: 0 },
      dimension: "minecraft:overworld", ...baseInput,
    }).mode).toBe("scoop");
  });

  it("rejects diagonal faces and non-bucket items", () => {
    expect(fluidPlaceInputSchema.safeParse({
      mode: "place", itemName: "water_bucket",
      referenceBlock: { x: 0, y: 64, z: 0 }, face: { x: 1, y: 1, z: 0 },
      dimension: "minecraft:overworld", ...baseInput,
    }).success).toBe(false);
    expect(fluidPlaceInputSchema.safeParse({
      mode: "place", itemName: "stone",
      referenceBlock: { x: 0, y: 64, z: 0 }, face: { x: 1, y: 0, z: 0 },
      dimension: "minecraft:overworld", ...baseInput,
    }).success).toBe(false);
  });

  it("requires the matching bucket for place, empty bucket for scoop", async () => {
    const state = onlineState({ bucketCounts: { bucket: 1, water_bucket: 0, lava_bucket: 2 } });
    const placeInput = fluidPlaceInputSchema.parse({
      mode: "place", itemName: "water_bucket",
      referenceBlock: { x: 0, y: 64, z: 0 }, face: { x: 1, y: 0, z: 0 },
      dimension: "minecraft:overworld", ...baseInput,
    });
    const result = evaluatePreconditions(fluidPlaceSkill, placeInput, state as never);
    expect((result as { failureCode: string }).failureCode).toBe("FLUID_BUCKET_MISSING");
    const scoopInput = fluidPlaceInputSchema.parse({
      mode: "scoop", target: { x: 1, y: 64, z: 0 },
      dimension: "minecraft:overworld", ...baseInput,
    });
    const scoopResult = evaluatePreconditions(fluidPlaceSkill, scoopInput, state as never);
    // scoop 走空桶分支（bucket=1 在手上），reach 经 policy 桩放行。
    expect(scoopResult?.failureCode).not.toBe("FLUID_BUCKET_MISSING");
  });
});

describe("animal.breed", () => {
  it("accepts valid pairs and rejects identical entities", () => {
    const base = {
      animal: "cow" as const, foodItem: "wheat",
      dimension: "minecraft:overworld", ...baseInput,
    };
    expect(animalBreedInputSchema.parse({
      ...base, firstEntityUuid: "0123456789abcdef0123456789abcdef",
      secondEntityUuid: "0123456789abcdef0123456789abcdee",
    }).animal).toBe("cow");
    expect(animalBreedInputSchema.safeParse({
      ...base, firstEntityUuid: "0123456789abcdef0123456789abcdef",
      secondEntityUuid: "0123456789abcdef0123456789abcdef",
    }).success).toBe(false);
  });

  it("breed food matrix: cow=wheat, chicken=seeds, wrong food rejected in precondition", async () => {
    expect(breedFoodAccepted("cow", "wheat")).toBe(true);
    expect(breedFoodAccepted("cow", "carrot")).toBe(false);
    expect(breedFoodAccepted("chicken", "wheat_seeds")).toBe(true);
    expect(breedFoodAccepted("pig", "beetroot")).toBe(true);
    expect(Object.keys(BREED_FOOD_BY_ANIMAL)).toContain("sheep");
    const state = onlineState({ foodItemCount: 8, entitiesPresent: true });
    const input = animalBreedInputSchema.parse({
      animal: "cow", foodItem: "carrot",
      firstEntityUuid: "0123456789abcdef0123456789abcdef",
      secondEntityUuid: "0123456789abcdef0123456789abcdee",
      dimension: "minecraft:overworld", ...baseInput,
    });
    const result = evaluatePreconditions(animalBreedSkill, input, state as never);
    expect((result as { failureCode: string }).failureCode).toBe("BREED_FOOD_INCOMPATIBLE");
  });

  it("requires at least 2 food and fails closed on unknown counts", async () => {
    const state = onlineState({ foodItemCount: 1, entitiesPresent: true });
    const input = animalBreedInputSchema.parse({
      animal: "cow", foodItem: "wheat",
      firstEntityUuid: "0123456789abcdef0123456789abcdef",
      secondEntityUuid: "0123456789abcdef0123456789abcdee",
      dimension: "minecraft:overworld", ...baseInput,
    });
    const result = evaluatePreconditions(animalBreedSkill, input, state as never);
    expect((result as { failureCode: string }).failureCode).toBe("INVENTORY_INSUFFICIENT_ITEMS");
    const unknown = evaluatePreconditions(animalBreedSkill, input, onlineState({ foodItemCount: null, entitiesPresent: true }) as never);
    expect((unknown as { failureCode: string }).failureCode).toBe("INVENTORY_COUNT_UNKNOWN");
  });
});
