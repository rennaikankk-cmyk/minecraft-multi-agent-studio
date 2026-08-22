import { defineConfig } from "@playwright/test";

const browserChannel = process.env.PLAYWRIGHT_BROWSER_CHANNEL;
const reuseExistingServer = process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === "1";
const rawPort = process.env.PLAYWRIGHT_PORT ?? "3000";
if (!/^[0-9]+$/u.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65_535) {
  throw new Error("PLAYWRIGHT_PORT must be a valid TCP port.");
}
const baseURL = `http://127.0.0.1:${rawPort}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...(browserChannel ? { channel: browserChannel } : {}),
  },
  webServer: {
    command: `pnpm dev --hostname 127.0.0.1 --port ${rawPort}`,
    url: baseURL,
    reuseExistingServer,
    timeout: 120_000,
  },
});
