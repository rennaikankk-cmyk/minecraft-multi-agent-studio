import { expect, test, type Page } from "@playwright/test";

const NOW = "2026-08-08T08:00:00.000Z";
const UUID = "44444444-4444-4444-8444-444444444444";

test("console navigation reaches every page", async ({ page }) => {
  await routeEmptyBots(page);
  await page.goto("/");
  await expect(page.getByTestId("bot-overview-counts")).toBeVisible();

  await page.getByRole("link", { name: "任务" }).click();
  await expect(page.getByTestId("goal-console")).toBeVisible();

  await page.getByRole("link", { name: "作战" }).click();
  await expect(page.getByTestId("combat-role-grid")).toBeVisible();
  await expect(page.getByTestId("combat-not-connected")).toContainText("运行时数据未接入");

  await page.getByRole("link", { name: "机器人" }).click();
  await expect(page.getByTestId("stream-state-badge")).toBeVisible();
});

test("tasks page shows no fabricated task data", async ({ page }) => {
  await routeEmptyBots(page);
  await page.goto("/tasks");
  await expect(page.getByTestId("goal-console")).toBeVisible();
  await expect(page.getByText("尚未提交目标。")).toBeVisible();
  await expect(page.locator(".botCard")).toHaveCount(0);
});

test("tasks page renders a real goal result and preserves failed styling", async ({ page }) => {
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
          bots: [{
            botId: "worker-01",
            connectionState: "online",
            lastMessageAt: NOW,
            lastHeartbeatAt: NOW,
            lastStatusAt: NOW,
            health: { current: 20, maximum: 20 },
            food: { level: 20, saturation: 5 },
            armorPoints: 20,
            latencyMs: 20,
            currentTask: null,
            position: null,
            positionRedacted: true,
            minecraftVersion: null,
          }],
        },
      }),
    });
  });
  await page.route(/\/api\/goals$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "1.0",
        requestId: UUID,
        data: {
          action: "skill_result",
          botId: "worker-01",
          taskId: UUID,
          reasonCode: "SKILL_EXECUTION_FAILED",
          skillId: "movement.wander",
          skillVersion: "1.0.0",
          outcome: "failed",
          errorCode: "PATH_BLOCKED",
          ai: { attempts: 1, queueTimeMs: 1, executionTimeMs: 4, totalTimeMs: 5 },
        },
      }),
    });
  });
  await page.goto("/tasks");
  await page.getByLabel("目标").fill("采集附近的木材");
  await page.getByRole("button", { name: "提交目标" }).click();
  await expect(page.getByTestId("goal-result-state")).toHaveText("failed");
  await expect(page.getByTestId("goal-result-state")).toHaveClass(/unavailable/);
  await expect(page.getByText(UUID)).toBeVisible();
  await expect(page.getByText("PATH_BLOCKED")).toBeVisible();
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

test("theme switcher applies and persists the selected style", async ({ page }) => {
  await routeEmptyBots(page);
  await page.goto("/");
  // Default tactical theme has no data-theme attribute.
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);

  await page.getByTestId("theme-modern").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "modern");

  await page.getByTestId("theme-pixel").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "pixel");

  // Survives reload via localStorage + inline init script.
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "pixel");

  await page.getByTestId("theme-tactical").click();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
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
