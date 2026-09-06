import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const mineflayerRequire = createRequire(require.resolve("mineflayer"));
const Chunk = mineflayerRequire("prismarine-chunk")("1.21.8");

describe("Minecraft wire light observations", () => {
  it("decodes each low/high nibble at its actual world position", () => {
    const chunk = new Chunk({ minY: -64, worldHeight: 384 });
    const bytes = Buffer.alloc(2048);
    for (let index = 0; index < 4096; index++) {
      const light = ((index & 15) + ((index >> 4) & 15) + (index >> 8)) % 16;
      bytes[index >> 1] = bytes[index >> 1]! | light << (index % 2 * 4);
    }
    const mask = [[0, 1 << 9]], empty = [[0, 0]];
    chunk.loadParsedLight([bytes], [bytes], mask, mask, empty, empty);
    for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
      const position = { x, y: 64 + y, z };
      expect(chunk.getBlockLight(position), JSON.stringify(position)).toBe((x + y + z) % 16);
      expect(chunk.getSkyLight(position), JSON.stringify(position)).toBe((x + y + z) % 16);
    }
  });
});
