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
  await expect(page.getByTestId("bot-card-worker-01")).toContainText("L0安全");
  await expect(page.getByTestId("bot-card-worker-01")).toContainText("正常监控");
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

test("samples real memory every five seconds without repeating full detection", async ({
  page,
}) => {
  let environmentRequests = 0;
  let memoryRequests = 0;
  await page.clock.install({ time: new Date(NOW) });
  await routeBots(page, "offline");
  await page.route(/\/api\/environment$/, async (route) => {
    environmentRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(environmentResponse()),
    });
  });
  await page.route(/\/api\/environment\/memory$/, async (route) => {
    memoryRequests += 1;
    if (memoryRequests === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          requestId: UUID,
          error: {
            code: "ENVIRONMENT_MEMORY_CAPTURE_FAILED",
            message: "内存采集暂时不可用",
          },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        requestId: UUID,
        sample: {
          schemaVersion: "1.0",
          capturedAt: "2026-07-20T08:00:10.000Z",
          source: "node-os",
          memory: {
            totalBytes: 16 * 1024 ** 3,
            freeBytes: 7 * 1024 ** 3,
          },
        },
      }),
    });
  });

  await page.goto("/");
  await expect(page.getByTestId("memory-free")).toContainText("8.00 GiB");
  const initialEnvironmentRequests = environmentRequests;
  expect(initialEnvironmentRequests).toBeGreaterThan(0);
  expect(memoryRequests).toBe(0);

  await page.clock.fastForward(5_000);
  await expect.poll(() => memoryRequests).toBe(1);
  await expect(page.getByTestId("memory-free")).toContainText("8.00 GiB");
  await expect(page.getByTestId("memory-sample-status")).toContainText(
    "数据已过期",
  );

  await page.clock.fastForward(5_000);
  await expect.poll(() => memoryRequests).toBe(2);
  await expect(page.getByTestId("memory-free")).toContainText("7.00 GiB");
    await expect(page.getByTestId("memory-sample-status")).toContainText(
      "每 5 秒采集",
    );
    expect(environmentRequests).toBe(initialEnvironmentRequests);

    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.clock.fastForward(15_001);
    await expect(page.getByTestId("memory-sample-status")).toContainText(
      "超过 15 秒未成功采集",
    );
    expect(memoryRequests).toBe(2);

    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect.poll(() => memoryRequests).toBe(3);
    await expect(page.getByTestId("memory-sample-status")).toContainText(
      "每 5 秒采集",
    );

    await page.getByRole("button", { name: "重新检测" }).click();
    await expect.poll(() => environmentRequests).toBe(
      initialEnvironmentRequests + 1,
    );
    await expect(page.getByTestId("memory-free")).toContainText("7.00 GiB");
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
          safety: {
            mode: "monitoring",
            activeRisks: [],
            normalTasksPaused: false,
            lastDecisionId: "l0-e2e-test",
            lastAction: null,
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

function environmentResponse() {
  return {
    requestId: UUID,
    environment: {
      schemaVersion: "1.0",
      capturedAt: NOW,
      mode: { value: "standard", source: "default" },
      hardware: {
        platform: "win32",
        release: "10.0.26100",
        architecture: "x64",
        cpu: { model: "Detected CPU", logicalCores: 16 },
        memory: {
          totalBytes: 16 * 1024 ** 3,
          freeBytes: 8 * 1024 ** 3,
        },
        gpu: { status: "not_detected", source: "test-probe", devices: [] },
      },
      software: [],
      warnings: [],
    },
  };
}
