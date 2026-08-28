import { describe, expect, it } from "vitest";

import {
  parseAcquisitionGoal,
  parseDeterministicGoal,
  parseFoodGoal,
  parseMovementGoal,
  parseScanGoal,
  parseShelterGoal,
} from "../src/deterministic-goals.js";

const BINDABLE = [
  "oak_log",
  "oak_planks",
  "crafting_table",
  "wooden_pickaxe",
  "cobblestone",
  "dirt",
  "diamond",
  "iron_pickaxe",
];

describe("deterministic goal parsing", () => {
  it("parses a plain single-item acquisition with a default count of one", () => {
    expect(parseAcquisitionGoal("获取 oak_log", BINDABLE)).toEqual({
      kind: "acquire-item",
      itemName: "oak_log",
      count: 1,
    });
    expect(parseAcquisitionGoal("Craft one crafting_table from nearby resources.", BINDABLE)).toEqual({
      kind: "acquire-item",
      itemName: "crafting_table",
      count: 1,
    });
  });

  it("parses counts written before or after the item name", () => {
    expect(parseAcquisitionGoal("获取 8 个 oak_log", BINDABLE)).toEqual({
      kind: "acquire-item",
      itemName: "oak_log",
      count: 8,
    });
    expect(parseAcquisitionGoal("获取 oak_log x8", BINDABLE)).toEqual({
      kind: "acquire-item",
      itemName: "oak_log",
      count: 8,
    });
    expect(parseAcquisitionGoal("获取 oak_log 8 个", BINDABLE)).toEqual({
      kind: "acquire-item",
      itemName: "oak_log",
      count: 8,
    });
  });

  it("rejects ambiguous or non-acquisition goals", () => {
    expect(parseAcquisitionGoal("Equip the best armor already in inventory.", BINDABLE)).toBeNull();
    expect(parseAcquisitionGoal("获取 oak_log 和 dirt", BINDABLE)).toBeNull();
    expect(parseAcquisitionGoal("获取 unknown_item", BINDABLE)).toBeNull();
  });

  it("parses the coordinator movement template with exactly one coordinate triple", () => {
    expect(parseMovementGoal("移动到坐标 x=12 y=64 z=-6 附近，继续观察 oak_log 方块")).toEqual({
      kind: "move-to",
      x: 12,
      y: 64,
      z: -6,
    });
    expect(parseMovementGoal("Equip the best armor.")).toBeNull();
    expect(
      parseMovementGoal("移动到坐标 x=1 y=2 z=3 附近再前往 x=4 y=5 z=6"),
    ).toBeNull();
  });

  it("parses the coordinator scan template with a registry-safe block name", () => {
    expect(parseScanGoal("读取当前区域的 coal_ore 方块分布并给出扫描结果，只读")).toEqual({
      kind: "scan-block",
      blockName: "coal_ore",
    });
    expect(parseScanGoal("读取当前区域的 Coal Ore 方块分布并给出扫描结果，只读")).toBeNull();
  });

  it("parses the coordinator food template and never confuses it with item acquisition", () => {
    expect(parseFoodGoal("获取 8 份安全食物")).toEqual({
      kind: "secure-food",
      targetCount: 8,
    });
    expect(parseFoodGoal("获取 份安全食物")).toBeNull();
    expect(parseAcquisitionGoal("获取 8 份安全食物", BINDABLE)).toBeNull();
  });

  it("parses the coordinator shelter template with whitelisted direction and seal", () => {
    expect(
      parseShelterGoal("在当前维度向 north 挖一个 2 格深的安全避难所，并用 dirt 封口"),
    ).toEqual({
      kind: "dig-shelter",
      direction: "north",
      depth: 2,
      sealItemName: "dirt",
    });
    expect(
      parseShelterGoal("在当前维度向 down 挖一个 2 格深的安全避难所，并用 dirt 封口"),
    ).toBeNull();
    expect(
      parseShelterGoal("在当前维度向 north 挖一个 2 格深的安全避难所，并用 bedrock 封口"),
    ).toBeNull();
  });

  it("dispatches to the first matching template in a fixed order", () => {
    expect(parseDeterministicGoal("获取 oak_log", BINDABLE)).toMatchObject({
      kind: "acquire-item",
    });
    expect(parseDeterministicGoal("Equip the best armor.", BINDABLE)).toBeNull();
  });
});
