import type { Metadata } from "next";

import { ThemeSwitcher } from "@/components/theme-switcher";
import { Card, CardContent, CardHeader, CardTitle, UiEmptyState } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Settings · Minecraft Multi-Agent Studio" };

export default function SettingsPage() {
  return (
    <main>
      <header className="mb-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-subtle-foreground">SYSTEM · SETTINGS</p>
        <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
      </header>
      <Card className="mb-4">
        <CardHeader><CardTitle>外观</CardTitle></CardHeader>
        <CardContent>
          <p className="mb-2 text-xs text-muted-foreground">旧版页面主题（迁移期间仍生效）：</p>
          <ThemeSwitcher />
        </CardContent>
      </Card>
      <UiEmptyState
        title="其余设置项：无浏览器可编辑的安全配置"
        hint="Studio 的运行时配置来自 .env / .env.local（服务端读取，含 secrets，不回传浏览器）。需要变更时修改配置文件并重启 Studio；secrets 在任何 UI 中只以 configured/not-configured 形式存在。"
      />
    </main>
  );
}
