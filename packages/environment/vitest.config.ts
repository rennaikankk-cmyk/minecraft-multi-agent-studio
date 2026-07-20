import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@minecraft-studio/protocol": fileURLToPath(
        new URL("../protocol/src/index.ts", import.meta.url),
      ),
    },
  },
});
