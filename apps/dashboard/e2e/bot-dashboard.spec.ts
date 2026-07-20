import { expect, test, type Page, type Route } from "@playwright/test";

const NOW = "2026-07-20T08:00:00.000Z";
const UUID = "11111111-1111-4111-8111-111111111111";

test("shows an online Bot with real telemetry fields", async ({ page }) => {
  await routeBots(page, "online");
  await page.goto("/");
  await expect(page.getByTestId("bot-card-worker-01")).toBeVisible();
  await expect(page.getByTestId("bot-state-worker-01")).toHaveText("在线");
  await expect(page.getByTestId("bot-card-worker-01")).toContainText("18 / 20");
  await expect(page.getByTestId("bot-card-worker-01")).toContainText("巡逻基地");
});

test("shows a disconnected Bot as offline", async ({ page }) => {
  await routeBots(page, "offline");
  await page.goto("/");
  await expect(page.getByTestId("bot-state-worker-01")).toHaveText("离线");
});

test("shows stale as 失联 and disables stop", async ({ page }) => {
  await routeBots(page, "stale");
  await page.goto("/");
  await expect(page.getByTestId("bot-state-worker-01")).toHaveText("失联");
  await expect(page.getByRole("button", { name: "失联不可停止" })).toBeDisabled();
});

test("shows backend failure without fake Bot fallback", async ({ page }) => {
  await page.route(/\/api\/bots$/, async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "1.0",
        requestId: UUID,
        error: { code: "CONTROL_API_UNAVAILABLE", message: "Control API 当前不可用。" },
      }),
    });
  });
  await page.goto("/");
  await expect(page.getByTestId("bot-backend-error")).toContainText("Control API 当前不可用");
  await expect(page.getByTestId("bot-grid")).toHaveCount(0);
});

test("requires confirmation and shows the confirmed stop result", async ({ page }) => {
  let stopped = false;
  await page.route(/\/api\/bots$/, async (route) => {
    await fulfillBots(route, stopped ? "offline" : "online");
  });
  await page.route(/\/api\/bots\/worker-01\/stop$/, async (route) => {
    const request = route.request();
    expect(request.method()).toBe("POST");
    expect(request.headers()["x-studio-action"]).toBe("stop-bot");
    expect(request.postDataJSON()).toMatchObject({ confirmationCode: "safe-stop-123" });
    stopped = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "1.0",
        requestId: UUID,
        data: {
          botId: "worker-01",
          traceId: UUID,
          commandId: UUID,
          outcome: "completed",
          errorCode: null,
        },
      }),
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "安全停止" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel("本地停止确认码").fill("safe-stop-123");
  await page.getByRole("button", { name: "确认优雅停止" }).click();
  await expect(page.getByTestId("stop-result")).toContainText("已确认停止");
  await expect(page.getByTestId("stop-trace-id")).toContainText(UUID);
  await expect(page.getByTestId("bot-state-worker-01")).toHaveText("离线");
});

async function routeBots(page: Page, state: "online" | "offline" | "stale") {
  await page.route(/\/api\/bots$/, async (route) => fulfillBots(route, state));
}

async function fulfillBots(route: Route, state: "online" | "offline" | "stale") {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(botResponse(state)),
  });
}

function botResponse(state: "online" | "offline" | "stale") {
  return {
    schemaVersion: "1.0",
    requestId: UUID,
    data: {
      source: "control-api",
      generatedAt: NOW,
      capabilities: { stopConfirmationConfigured: true },
      bots: [
        {
          botId: "worker-01",
          connectionState: state,
          lastMessageAt: NOW,
          lastHeartbeatAt: state === "offline" ? null : NOW,
          lastStatusAt: NOW,
          health: { current: 18, maximum: 20 },
          food: { level: 16, saturation: 4 },
          armorPoints: 4,
          latencyMs: 22,
          currentTask: {
            taskId: "patrol-01",
            title: "巡逻基地",
            status: "running",
            startedAt: NOW,
          },
          position: { x: 12, y: 64, z: -8, dimension: "minecraft:overworld" },
          positionRedacted: false,
          minecraftVersion: {
            selection: "auto",
            requestedVersion: null,
            resolvedVersion: "1.21.8",
            supportLevel: "tested",
            supportedRange: { oldest: "1.8.8", latest: "1.21.11" },
          },
        },
      ],
    },
  };
}
