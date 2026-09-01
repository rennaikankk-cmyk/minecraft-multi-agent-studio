// Phase 3 补拍：/bots 与 /combat（SSE 页面 networkidle 永不空闲，此前两批缺失），
// 1024x768 视口补全，以及 Overview 修复后重拍。仅 UI_SHOOT=3 时运行。
import { test } from "@playwright/test";
import { mkdirSync } from "node:fs";

const OUT = "C:/Users/renna/.zcode/workspace/default/minecraft-multi-agent-studio/docs/screenshots/after";

const viewports = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1920x1080", width: 1920, height: 1080 },
  { name: "1280x720", width: 1280, height: 720 },
  { name: "1024x768", width: 1024, height: 768 },
  { name: "390x844", width: 390, height: 844 },
];

// SSE/推送页面（/bots、/combat）保持长连接，networkidle 永不满足，统一 load + 静置。
const shots: Array<{ route: string; viewportNames: string[] }> = [
  { route: "/bots", viewportNames: viewports.map((v) => v.name) },
  { route: "/combat", viewportNames: ["1440x900", "1024x768", "390x844"] },
  { route: "/", viewportNames: ["1440x900", "1024x768"] },
  { route: "/servers", viewportNames: ["1024x768"] },
  { route: "/incidents", viewportNames: ["1024x768"] },
  { route: "/ai-spark", viewportNames: ["1024x768"] },
  { route: "/runtime", viewportNames: ["1024x768"] },
];

for (const { route, viewportNames } of shots) {
  for (const viewportName of viewportNames) {
    const viewport = viewports.find((v) => v.name === viewportName);
    if (!viewport) continue;
    test(`shoot3 ${route} @${viewportName}`, async ({ page }) => {
      test.skip(process.env.UI_SHOOT !== "3", "screenshot tool only");
      mkdirSync(OUT, { recursive: true });
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(route, { waitUntil: "load", timeout: 45_000 });
      await page.waitForTimeout(2500);
      const name = route === "/" ? "overview" : route.slice(1).replace("/", "-");
      await page.screenshot({ path: `${OUT}/${name}-${viewportName}.png`, fullPage: false });
    });
  }
}
