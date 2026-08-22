import { expect, test, type Page, type Route } from "@playwright/test";

const NOW = "2026-08-08T08:00:00.000Z";
const UUID = "44444444-4444-4444-8444-444444444444";
const TASK_A_ID = "11111111-1111-4111-8111-111111111111";
const TASK_B_ID = "22222222-2222-4222-8222-222222222222";

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
  let submittedTaskId = "";
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
    const input = route.request().postDataJSON() as { requestId: string };
    submittedTaskId = input.requestId;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "1.0",
        requestId: UUID,
        data: {
          action: "skill_result",
          botId: "worker-01",
          taskId: input.requestId,
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
  await page.getByRole("textbox", { name: "目标" }).fill("采集附近的木材");
  await page.getByRole("button", { name: "提交目标" }).click();
  await expect(page.getByTestId("goal-result-state")).toHaveText("failed");
  await expect(page.getByTestId("goal-result-state")).toHaveClass(/unavailable/);
  await expect(page.getByTestId("goal-recent-item").first()).toHaveAttribute(
    "data-task-id",
    submittedTaskId,
  );
  await expect(page.getByText("PATH_BLOCKED")).toBeVisible();
});

test("tasks page follows the submitted task through real Bot status to its terminal result", async ({ page }) => {
  let currentTask: {
    taskId: string;
    title: string;
    status: "running" | "completed";
    startedAt: string;
  } | null = {
    taskId: "other-task",
    title: "其他任务",
    status: "running",
    startedAt: NOW,
  };

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
          bots: [onlineBot("worker-01", currentTask)],
        },
      }),
    });
  });
  await page.route(/\/api\/goals$/, async (route) => {
    const input = route.request().postDataJSON() as {
      requestId: string;
      botId: string;
      operatorGoal: string;
    };
    currentTask = {
      taskId: input.requestId,
      title: "采集附近的木材",
      status: "running",
      startedAt: NOW,
    };
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    currentTask = { ...currentTask, status: "completed" };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "1.0",
        requestId: UUID,
        data: {
          action: "skill_result",
          botId: input.botId,
          taskId: input.requestId,
          reasonCode: "SKILL_COMPLETED",
          skillId: "collect.block",
          skillVersion: "1.0.0",
          outcome: "completed",
          ai: { attempts: 1, queueTimeMs: 1, executionTimeMs: 4, totalTimeMs: 5 },
        },
      }),
    });
  });

  await page.goto("/tasks");
  await page.getByRole("textbox", { name: "目标" }).fill("采集附近的木材");
  await page.getByRole("button", { name: "提交目标" }).click();

  await expect(page.getByTestId("goal-live-status")).toHaveText("等待状态");
  await expect(page.getByTestId("goal-lifecycle")).toContainText("Bot 当前任务与此提交不同");
  await expect(page.getByTestId("goal-live-status")).toHaveText("执行中", {
    timeout: 4_500,
  });
  await expect(page.getByTestId("goal-lifecycle")).toContainText("采集附近的木材");
  await expect(page.getByTestId("goal-lifecycle")).toContainText("Bot 状态：执行中");
  await expect(page.getByTestId("goal-live-status")).toHaveText("已完成", {
    timeout: 3_000,
  });
  await expect(page.getByTestId("goal-lifecycle")).toContainText("执行结果：已完成");
});

test("tasks page bounds the recent submission list", async ({ page }) => {
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
          bots: [onlineBot("worker-01", null)],
        },
      }),
    });
  });
  await page.route(/\/api\/goals$/, async (route) => {
    const input = route.request().postDataJSON() as { requestId: string; botId: string };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "1.0",
        requestId: UUID,
        data: {
          action: "noop",
          botId: input.botId,
          taskId: input.requestId,
          reasonCode: "NO_SAFE_SKILL",
          ai: { attempts: 1, queueTimeMs: 1, executionTimeMs: 1, totalTimeMs: 2 },
        },
      }),
    });
  });

  await page.goto("/tasks");
  for (let index = 1; index <= 9; index += 1) {
    await page.getByRole("textbox", { name: "目标" }).fill(`目标 ${index}`);
    await page.getByRole("button", { name: "提交目标" }).click();
    await expect(page.getByRole("button", { name: "提交目标" })).toBeEnabled();
  }

  await expect(page.getByTestId("goal-recent-item")).toHaveCount(8);
  await expect(page.getByTestId("goal-recent-item").first()).toContainText("目标 9");
  await expect(page.getByTestId("goal-recent-list").getByText("目标 1", { exact: true })).toHaveCount(0);
});

test("task detail keeps the newest request and error panels can close", async ({ page }) => {
  await routeEmptyBots(page);
  await page.route(/\/api\/tasks\?/, async (route) => {
    await fulfillTaskList(route, [taskSummary(TASK_A_ID, "任务 A"), taskSummary(TASK_B_ID, "任务 B")]);
  });
  let taskARequests = 0;
  await page.route(new RegExp(`/api/tasks/${TASK_A_ID}$`), async (route) => {
    taskARequests += 1;
    if (taskARequests === 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(taskDetailResponse(TASK_A_ID, "任务 A")),
      }).catch(() => undefined);
      return;
    }
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "1.0",
        requestId: UUID,
        error: {
          code: "TASK_HISTORY_UNAVAILABLE",
          message: "任务详情后端当前不可用。",
        },
      }),
    });
  });
  await page.route(new RegExp(`/api/tasks/${TASK_B_ID}$`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(taskDetailResponse(TASK_B_ID, "任务 B")),
    });
  });

  await page.goto("/tasks");
  const items = page.getByTestId("task-history-item");
  await items.filter({ hasText: "任务 A" }).getByRole("button", { name: "查看详情" }).click();
  await items.filter({ hasText: "任务 B" }).getByRole("button", { name: "查看详情" }).click();
  await expect(page.getByTestId("task-detail")).toContainText(TASK_B_ID);
  await page.waitForTimeout(250);
  await expect(page.getByTestId("task-detail")).toContainText(TASK_B_ID);
  await expect(page.getByTestId("task-detail")).not.toContainText(TASK_A_ID);
  await page.getByTestId("task-detail").getByRole("button", { name: "关闭" }).click();
  await expect(page.getByTestId("task-detail")).toHaveCount(0);

  await items.filter({ hasText: "任务 A" }).getByRole("button", { name: "查看详情" }).click();
  await expect(page.getByTestId("task-detail").getByRole("alert")).toContainText(
    "任务详情后端当前不可用",
  );
  await page.getByTestId("task-detail").getByRole("button", { name: "关闭" }).click();
  await expect(page.getByTestId("task-detail")).toHaveCount(0);
});

test("task history polling preserves pages that the operator loaded", async ({ page }) => {
  await page.clock.install({ time: new Date(NOW) });
  await routeEmptyBots(page);
  let firstPageRequests = 0;
  await page.route(/\/api\/tasks\?/, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("cursor") === "task_cursor_page_2") {
      await fulfillTaskList(route, [taskSummary(TASK_B_ID, "历史任务 B")], null);
      return;
    }
    firstPageRequests += 1;
    await fulfillTaskList(
      route,
      [taskSummary(TASK_A_ID, firstPageRequests === 1 ? "当前任务 A" : "当前任务 A（已刷新）")],
      "task_cursor_page_2",
    );
  });

  await page.goto("/tasks");
  await expect(page.getByText("当前任务 A", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "加载更多" }).click();
  await expect(page.getByText("历史任务 B", { exact: true })).toBeVisible();

  await page.clock.fastForward(5_000);
  await expect.poll(() => firstPageRequests).toBeGreaterThanOrEqual(2);
  await expect(page.getByText("当前任务 A（已刷新）", { exact: true })).toBeVisible();
  await expect(page.getByText("历史任务 B", { exact: true })).toBeVisible();
  await expect(page.getByTestId("task-history-item")).toHaveCount(2);
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

async function fulfillTaskList(
  route: Route,
  tasks: ReturnType<typeof taskSummary>[],
  nextCursor: string | null = null,
) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      schemaVersion: "1.0",
      requestId: UUID,
      data: {
        source: "control-api",
        generatedAt: NOW,
        tasks,
        nextCursor,
      },
    }),
  });
}

function taskSummary(taskId: string, title: string) {
  return {
    taskId,
    taskType: "operator.goal",
    title,
    status: "running" as const,
    priority: 50,
    riskLevel: "R1" as const,
    botId: "worker-01",
    failureReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: NOW,
    finishedAt: null,
    revision: 1,
  };
}

function taskDetailResponse(taskId: string, title: string) {
  return {
    schemaVersion: "1.0",
    requestId: UUID,
    data: {
      source: "control-api",
      generatedAt: NOW,
      task: { ...taskSummary(taskId, title), operatorGoal: `执行${title}` },
    },
  };
}

function onlineBot(
  botId: string,
  currentTask: {
    taskId: string;
    title: string;
    status: "running" | "completed";
    startedAt: string;
  } | null,
) {
  return {
    botId,
    connectionState: "online",
    lastMessageAt: NOW,
    lastHeartbeatAt: NOW,
    lastStatusAt: NOW,
    health: { current: 20, maximum: 20 },
    food: { level: 20, saturation: 5 },
    armorPoints: 20,
    latencyMs: 20,
    currentTask,
    position: null,
    positionRedacted: true,
    minecraftVersion: null,
  };
}
