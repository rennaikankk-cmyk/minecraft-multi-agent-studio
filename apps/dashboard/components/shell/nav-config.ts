import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Bot,
  Cpu,
  FlaskConical,
  LayoutDashboard,
  ScrollText,
  Server,
  Sparkles,
  Target,
  Boxes,
  Globe2,
  Settings,
} from "lucide-react";

export interface NavItem {
  readonly label: string;
  readonly href: string;
  readonly icon: LucideIcon;
  /** badge 键（GlobalStatus 中取数） */
  readonly badge?: "criticalIncidents" | "spark" | "localTest";
  /** 键盘快捷键提示（command palette 内展示） */
  readonly hint?: string;
}

export interface NavGroup {
  readonly label: string;
  readonly items: readonly NavItem[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    label: "Operations",
    items: [
      { label: "Overview", href: "/", icon: LayoutDashboard, hint: "总览" },
      { label: "Servers", href: "/servers", icon: Server, hint: "External / Local Test" },
      { label: "Bots", href: "/bots", icon: Bot, hint: "Bot Fleet" },
      { label: "Combat", href: "/combat", icon: Target, hint: "战斗 reflex" },
    ],
  },
  {
    label: "World",
    items: [
      { label: "Bases", href: "/bases", icon: Boxes, hint: "基地与蓝图" },
      { label: "Shared State", href: "/shared-state", icon: Globe2, hint: "leases/reservations" },
    ],
  },
  {
    label: "Reliability",
    items: [
      { label: "Incidents", href: "/incidents", icon: Activity, badge: "criticalIncidents", hint: "问题与导出" },
      { label: "E2E", href: "/e2e", icon: FlaskConical, hint: "隔离验收" },
      { label: "Events / Logs", href: "/events", icon: ScrollText, hint: "事件与日志" },
    ],
  },
  {
    label: "Intelligence",
    items: [
      { label: "AI / Spark", href: "/ai-spark", icon: Sparkles, badge: "spark", hint: "推理连接" },
      { label: "Goals / Plans", href: "/goals", icon: Target, hint: "目标与仲裁" },
    ],
  },
  {
    label: "System",
    items: [
      { label: "Runtime", href: "/runtime", icon: Cpu, hint: "组件与能力" },
      { label: "Settings", href: "/settings", icon: Settings, hint: "偏好" },
    ],
  },
];
