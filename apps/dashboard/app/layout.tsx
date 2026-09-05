import type { Metadata } from "next";
import type { ReactNode } from "react";

import { StudioShell } from "@/components/shell/studio-shell";

import "./globals.css";
import "./theme.css";

export const metadata: Metadata = {
  title: "Minecraft Multi-Agent Studio",
  description: "Hardware-neutral Minecraft multi-agent control studio",
};

const themeInitScript = `(function(){try{var t=localStorage.getItem("studio-theme");if(t==="modern"||t==="pixel"){document.documentElement.setAttribute("data-theme",t);}}catch(e){}})();`;

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body className="studio-shell-host">
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <StudioShell>{children}</StudioShell>
      </body>
    </html>
  );
}
