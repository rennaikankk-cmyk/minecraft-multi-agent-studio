# Third-Party UI Attribution

## 采用（copy-in / 依赖）

| 来源 | License | 使用范围 | 版本/锁定方式 | 本地修改 |
|---|---|---|---|---|
| [shadcn/ui](https://ui.shadcn.com)（new-york 风格） | MIT | Button/Badge/Card/Dialog/Sheet/Tooltip/DropdownMenu 等组件结构与视觉语言；`components/ui/` copy-in | 无运行时包（copy-in 模型）；同步于 2026-09 参考实现 | 适配项目 design tokens（theme.css）、移除 preflight 依赖、cva 变体裁剪 |
| [shadcn-admin](https://github.com/satnaing/shadcn-admin) | MIT | 仅信息架构/侧边栏折叠/响应式行为参考 | 未复制代码 | —（无代码复制） |
| [Tailwind CSS](https://tailwindcss.com) v4 | MIT | 工具类 + `@theme` token 层（theme+utilities，无 preflight） | `tailwindcss@4.x`（pnpm lockfile） | postcss 配置见 `postcss.config.mjs` |
| [Radix UI](https://radix-ui.com) primitives | MIT | dialog/dropdown-menu/tooltip/tabs/scroll-area/separator/slot 可访问性原语 | `@radix-ui/*@2.x`（lockfile） | 无 |
| [lucide-react](https://lucide.dev) | ISC | 全站统一线条图标 | `lucide-react@0.5xx`（lockfile） | 无 |
| [recharts](https://recharts.org) | MIT | 图表引擎（Tremor 风格克制样式，项目内实现 chart 组件） | `recharts@3.x`（lockfile） | 样式封装见 `components/charts/` |
| [Tremor](https://tremor.so) | Apache-2.0 | 仅视觉参考（图表配色/克制装饰原则），未引入运行时 | — | — |

## 明确不采用

- shadcn-admin 的登录/用户管理/支付/CRM 页面（与本项目无关）。
- 付费或来源不明模板代码。
- 远程运行时资源（CDN 字体/图标等）。

## 原则

- 所有 copy-in 代码进入本仓库后遵循本项目 lint/typecheck；未使用组件不保留。
- 任何组件不得在运行时请求远程资源。
