import type { Metadata } from "next";
import type { ReactNode } from "react";

import { ConsoleNav } from "@/components/console-nav";

import "./globals.css";

export const metadata: Metadata = {
  title: "Minecraft Multi-Agent Studio",
  description: "Hardware-neutral Minecraft multi-agent control studio",
};

const themeInitScript = `(function(){try{var t=localStorage.getItem("studio-theme");if(t==="modern"||t==="pixel"){document.documentElement.setAttribute("data-theme",t);}}catch(e){}})();`;

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <ConsoleNav />
        {children}
      </body>
    </html>
  );
}
