import { expect, test, type Page } from "@playwright/test";

const NOW = "2026-08-08T08:00:00.000Z";
const UUID = "44444444-4444-4444-8444-444444444444";

test("console navigation reaches every page", async ({ page }) => {
  await routeEmptyBots(page);
  await page.goto("/");
  await expect(page.getByTestId("bot-overview-counts")).toBeVisible();

  await page.getByRole("link", { name: "任务" }).click();
  await expect(page.getByTestId("tasks-not-connected")).toContainText("后端未接入");

  await page.getByRole("link", { name: "作战" }).click();
  await expect(page.getByTestId("combat-role-grid")).toBeVisible();
  await expect(page.getByTestId("combat-not-connected")).toContainText("运行时数据未接入");

  await page.getByRole("link", { name: "机器人" }).click();
  await expect(page.getByTestId("stream-state-badge")).toBeVisible();
});

test("tasks page shows no fabricated task data", async ({ page }) => {
  await page.goto("/tasks");
  await expect(page.getByTestId("tasks-not-connected")).toBeVisible();
  // No task cards, no queue counts — the page is an explicit placeholder.
  await expect(page.locator(".botCard")).toHaveCount(0);
});

test("bots page falls back to explicit polling when the stream is unavailable", async ({ page }) => {
  await routeEmptyBots(page);
  await page.route(/\/api\/bots\/stream$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: `event: stream-error\ndata: ${JSON.stringify({ requestId: UUID, code: "UPSTREAM_UNAVAILABLE" })}\n\n`,
    });
  });
  await page.goto("/bots");
  await expect(page.getByTestId("stream-state-badge")).toContainText("已退回 3 秒轮询");
  await expect(page.getByTestId("bot-empty")).toBeVisible();
});

test("bots page renders a bot pushed over the live stream", async ({ page }) => {
  // First poll returns an empty registry; later fallback polls are held
  // pending, so the rendered card can only have come from the SSE snapshot.
  let listCalls = 0;
  await page.route(/\/api\/bots$/, async (route) => {
    listCalls += 1;
    if (listCalls > 1) {
      await new Promise(() => {});
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "1.0",
        requestId: UUID,
        data: {
          source: "control-api",
          generatedAt: NOW,
          capabilities: { stopConfirmationConfigured: false },
          bots: [],
        },
      }),
    });
  });
  await page.route(/\/api\/bots\/stream$/, async (route) => {
    const snapshot = {
      requestId: UUID,
      message: {
        schemaVersion: "1.0",
        messageId: UUID,
        timestamp: NOW,
        streamSequence: 1,
        type: "bot.stream.snapshot.v1",
        payload: {
          bots: [
            {
              botId: "stream-bot-01",
              connectionState: "online",
              lastMessageAt: NOW,
              lastHeartbeatAt: NOW,
              lastStatusAt: NOW,
              health: { current: 20, maximum: 20 },
              food: { level: 20, saturation: 5 },
              armorPoints: 20,
              latencyMs: 31,
              currentTask: null,
              position: null,
              positionRedacted: true,
              minecraftVersion: null,
            },
          ],
        },
      },
    };
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`,
    });
  });
  await page.goto("/bots");
  await expect(page.getByTestId("bot-card-stream-bot-01")).toBeVisible();
  await expect(page.getByTestId("bot-state-stream-bot-01")).toHaveText("在线");
});

async function routeEmptyBots(page: Page) {
  await page.route(/\/api\/bots$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "1.0",
        requestId: UUID,
        data: {
          source: "control-api",
          generatedAt: NOW,
          capabilities: { stopConfirmationConfigured: false },
          bots: [],
        },
      }),
    });
  });
}
