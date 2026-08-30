"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { ThemeSwitcher } from "@/components/theme-switcher";

const links = [
  { href: "/", label: "总览" },
  { href: "/servers", label: "服务器" },
  { href: "/bots", label: "机器人" },
  { href: "/bases", label: "基地" },
  { href: "/incidents", label: "Incidents" },
  { href: "/shared-state", label: "共享状态" },
  { href: "/tasks", label: "任务" },
  { href: "/combat", label: "作战" },
] as const;

export function ConsoleNav() {
  const pathname = usePathname();
  return (
    <nav className="consoleNav" aria-label="控制台导航">
      <div className="consoleNavInner">
        <Link className="consoleNavBrand" href="/">
          <span className="brandMark small" aria-hidden="true">M</span>
          <span>Multi-Agent Studio</span>
        </Link>
        <ul>
          {links.map((link) => {
            const active =
              link.href === "/"
                ? pathname === "/"
                : pathname === link.href || pathname.startsWith(`${link.href}/`);
            return (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className={active ? "active" : ""}
                  aria-current={active ? "page" : undefined}
                >
                  {link.label}
                </Link>
              </li>
            );
          })}
        </ul>
        <ThemeSwitcher />
      </div>
    </nav>
  );
}
