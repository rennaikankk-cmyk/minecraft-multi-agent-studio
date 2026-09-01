// 重构前后截图工具（仅在 UI_SHOOT=1 时运行；CI 跳过）
import { test } from "@playwright/test";
import { mkdirSync } from "node:fs";

const phase = process.env.UI_SHOOT_PHASE ?? "before";
const OUT = `C:/Users/renna/.zcode/workspace/default/minecraft-multi-agent-studio/docs/screenshots/${phase}`;
const routes = ["/", "/servers", "/bots", "/incidents", "/bases", "/shared-state", "/tasks", "/combat"];
const viewports = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "390x844", width: 390, height: 844 },
];

for (const route of routes) {
  for (const viewport of viewports) {
    test(`shoot ${phase} ${route} @${viewport.name}`, async ({ page }) => {
      test.skip(process.env.UI_SHOOT !== "1", "screenshot tool only");
      mkdirSync(OUT, { recursive: true });
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(route, { waitUntil: "networkidle" });
      await page.waitForTimeout(1500);
      const name = route === "/" ? "overview" : route.slice(1).replace("/", "-");
      await page.screenshot({ path: `${OUT}/${name}-${viewport.name}.png`, fullPage: false });
    });
  }
}
