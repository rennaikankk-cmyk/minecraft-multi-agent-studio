import type { Metadata } from "next";
import type { ReactNode } from "react";

import { ConsoleNav } from "@/components/console-nav";

import "./globals.css";

export const metadata: Metadata = {
  title: "Minecraft Multi-Agent Studio",
  description: "Hardware-neutral Minecraft multi-agent control studio",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <ConsoleNav />
        {children}
      </body>
    </html>
  );
}
