import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const requiredEnvironment = [
  "TASK_POSTGRES_URL",
  "TASK_REDIS_URL",
  "TASK_INFRA_TEST_NAMESPACE",
];
const missing = requiredEnvironment.filter(
  (name) => !process.env[name]?.trim(),
);

if (missing.length > 0) {
  console.error(
    `Task infrastructure test configuration is incomplete: ${missing.join(", ")}`,
  );
  process.exit(1);
}

const vitestEntry = path.join(
  repositoryRoot,
  "node_modules",
  "vitest",
  "vitest.mjs",
);
if (!existsSync(vitestEntry)) {
  console.error(
    "Vitest is unavailable. Run the frozen workspace install first.",
  );
  process.exit(1);
}

const taskResult = spawnSync(
  process.execPath,
  [
    vitestEntry,
    "run",
    "tests/real-infrastructure.integration.test.ts",
  ],
  {
    cwd: path.join(repositoryRoot, "packages", "task-system"),
    env: {
      ...process.env,
      RUN_REAL_TASK_INFRA_TEST: "1",
    },
    shell: false,
    stdio: "inherit",
    timeout: 120_000,
  },
);

if (taskResult.error) {
  console.error("Task infrastructure test runner failed to start.");
  process.exit(1);
}
if (taskResult.status !== 0) {
  process.exit(taskResult.status ?? 1);
}

const memoryResult = spawnSync(
  process.execPath,
  [
    vitestEntry,
    "run",
    "tests/real-infrastructure.integration.test.ts",
  ],
  {
    cwd: path.join(repositoryRoot, "packages", "world-memory"),
    env: {
      ...process.env,
      RUN_REAL_WORLD_MEMORY_TEST: "1",
      WORLD_MEMORY_POSTGRES_URL: process.env.TASK_POSTGRES_URL,
      WORLD_MEMORY_TEST_NAMESPACE: process.env.TASK_INFRA_TEST_NAMESPACE,
    },
    shell: false,
    stdio: "inherit",
    timeout: 120_000,
  },
);

if (memoryResult.error) {
  console.error("World-memory infrastructure test runner failed to start.");
  process.exit(1);
}
process.exit(memoryResult.status ?? 1);
