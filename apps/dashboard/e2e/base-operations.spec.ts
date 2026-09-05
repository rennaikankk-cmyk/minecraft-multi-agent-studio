import { expect, test } from "@playwright/test";

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`base production, scope filter and stale state at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    let failed = false;
    const observedAt = new Date().toISOString();
    const base = { id: "base-test", name: "模拟基地 Alpha", serverProfileId: "isolated-test", dimension: "minecraft:overworld",
      anchor: { x: 100, y: 64, z: 100 }, blueprintId: "operator-adopted", status: "active", integrity01: 0,
      placedCells: 0, facilityCount: 1, updatedAt: observedAt, source: "operator_adopted", memberBotIds: ["farmer-01", "guard-01"],
      phaseFacts: { BASE_SITE_RESERVED: { availability: "AVAILABLE", observedAt, evidence: "模拟配置", source: "operator-config", revision: 1 } } };
    await page.route("**/api/shared-state", async (route) => route.fulfill({ status: failed ? 503 : 200,
      contentType: "application/json", body: JSON.stringify(failed ? { message: "模拟连接中断" } : {
        schemaVersion: "1.0", generatedAt: observedAt, savedAt: observedAt,
        bases: [base, { ...base, id: "base-other", name: "模拟基地 Beta", serverProfileId: "other-test", facilityCount: 0 }],
        workstations: [], facilities: [{ id: "farm-test", facilityType: "crop_farm", serverProfileId: "isolated-test",
          dimension: "minecraft:overworld", baseId: base.id, anchor: base.anchor, lifecycle: "planned", slots: [], slotCounts: {},
          production: { schemaVersion: "1.0", enabled: true, status: "PRODUCING", lastTaskId: "test-task", lastObservedAt: observedAt,
            nextRunAtMs: Date.now() + 30_000, reason: null, input: { crops: ["carrots"] }, samples: [{ atMs: Date.now(), netFood: 12 }] } }],
      }) }));
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/bases");
    await page.getByRole("button", { name: "展开 模拟基地 Alpha" }).click();
    await expect(page.getByText("12 份 · 1 批")).toBeVisible();
    await expect(page.getByText("有收获", { exact: true })).toBeVisible();
    await page.getByRole("combobox", { name: "服务器筛选" }).selectOption("isolated-test");
    await expect(page.getByRole("heading", { name: "模拟基地 Beta" })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await page.locator(".baseRecordHeader").evaluate((element) => getComputedStyle(element).paddingTop)).toBe("14px");
    expect(await page.locator("body").evaluate((element) => getComputedStyle(element).paddingLeft)).toBe("0px");
    await page.screenshot({ path: testInfo.outputPath(`bases-${viewport.width}.png`), fullPage: true });
    failed = true;
    await page.getByRole("button", { name: "刷新基地" }).click();
    await expect(page.getByText("数据过期", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "模拟基地 Alpha" })).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test("base load failure does not appear as an empty registry", async ({ page }) => {
  await page.route("**/api/shared-state", (route) => route.fulfill({ status: 503,
    contentType: "application/json", body: JSON.stringify({ message: "模拟不可达" }) }));
  await page.goto("/bases");
  await expect(page.getByRole("alert").filter({ hasText: "基地数据读取失败" })).toBeVisible();
  await expect(page.getByText("尚未登记基地")).toHaveCount(0);
});
