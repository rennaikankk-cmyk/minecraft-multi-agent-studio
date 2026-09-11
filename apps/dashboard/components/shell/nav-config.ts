import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Layers,
  Bot,
  Cpu,
  FlaskConical,
  LayoutDashboard,
  Lightbulb,
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
      { label: "Skills", href: "/skills", icon: Layers, hint: "Skill System v1 Manifest" },
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
      { label: "Models & API", href: "/models", icon: Sparkles, badge: "spark", hint: "本地推理 / 云端 API / 中转站" },
      { label: "Goals / Plans", href: "/goals", icon: Target, hint: "目标与仲裁" },
      { label: "Gap Console", href: "/gaps", icon: Lightbulb, hint: "自我改善：gap/lesson/release" },
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
