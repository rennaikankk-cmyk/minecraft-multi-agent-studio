// 补充视口截图（新路由 + 1920/1280；仅 UI_SHOOT=2 时运行）
import { test } from "@playwright/test";
import { mkdirSync } from "node:fs";

const OUT = "C:/Users/renna/.zcode/workspace/default/minecraft-multi-agent-studio/docs/screenshots/after";
const routes = ["/", "/servers", "/bots", "/incidents", "/ai-spark", "/goals", "/runtime", "/settings", "/e2e", "/events"];
const viewports = [
  { name: "1920x1080", width: 1920, height: 1080 },
  { name: "1280x720", width: 1280, height: 720 },
  { name: "390x844", width: 390, height: 844 },
];

for (const route of routes) {
  for (const viewport of viewports) {
    test(`shoot2 ${route} @${viewport.name}`, async ({ page }) => {
      test.skip(process.env.UI_SHOOT !== "2", "screenshot tool only");
      mkdirSync(OUT, { recursive: true });
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(route, { waitUntil: "load" });
      await page.waitForTimeout(2500);
      const name = route === "/" ? "overview" : route.slice(1).replace("/", "-");
      await page.screenshot({ path: `${OUT}/${name}-${viewport.name}.png`, fullPage: false });
    });
  }
}
