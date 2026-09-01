// Phase 4：teardown 后 NORMAL 态 Overview（Local MC OFF 显示为正常状态，非错误）证据截图。
import { test } from "@playwright/test";
import { mkdirSync } from "node:fs";

const OUT = "C:/Users/renna/.zcode/workspace/default/minecraft-multi-agent-studio/docs/screenshots/after";

test("shoot4 overview NORMAL state @1440x900", async ({ page }) => {
  test.skip(process.env.UI_SHOOT !== "4", "screenshot tool only");
  mkdirSync(OUT, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "load", timeout: 45_000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/overview-normal-1440x900.png`, fullPage: false });
});
