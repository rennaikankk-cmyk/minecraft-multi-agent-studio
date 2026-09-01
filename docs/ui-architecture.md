# UI Architecture（前端视觉与交互重构 ADR）

基线：Round 6（a8d29ca）后的 dashboard。目标：Modern Operations Console、dark-first、高信息密度、真实可观测性。

## 决策

### D1 — 框架不迁移
保持 **Next.js 16 App Router + React 19 + TypeScript**。禁止为模板迁移框架/构建系统。

### D2 — 渐进引入 Tailwind CSS v4（不启用 preflight）
- 方式：`@tailwindcss/postcss`；`app/theme.css` 只加载 `tailwindcss/theme.css` + `tailwindcss/utilities.css`，**不加载 preflight**——旧 `globals.css` 类体系（tactical/modern/pixel 三主题、20 个存量组件）在 parity 前继续工作，新旧共存。
- 新 shell 的最小 reset 限定在 `.studio-ui` 作用域，不影响旧页面。
- 单一 design-token 来源：`app/theme.css` 的 `@theme` 块（surfaces/semantic/typography/radius/motion）。页面不得硬编码 hex。

### D3 — shadcn/ui copy-in 组件模型
- 以 shadcn/ui（MIT）new-york 风格为视觉参考，组件 copy-in 到 `components/ui/` 并适配项目 tokens/lint/typecheck；删除未用组件；不依赖远程运行时资源。
- Radix 原语（dialog/dropdown/tooltip 等）承担可访问性（focus trap/restore、aria）。
- shadcn-admin（MIT）仅作信息架构/布局/响应式参考，不复制其登录/用户/CRM 等无关页面。

### D4 — 图表：recharts（Tremor 风格 copy-in patterns）
- 不引入整个 `@tremor/react` App 体系；Tremor 只用于数据展示——采用其底层引擎 **recharts** 按 Tremor 的克制样式（细线、少量色、深色适配、文本摘要 fallback）在项目内实现 chart 组件。

### D5 — Icons
- 统一 **lucide-react**（ISC）线条图标；仅图标按钮必须带 aria-label/tooltip。
- Minecraft 元素（bot 头像/item/block 图标、dimension 语义）克制使用，不影响正文可读性。

### D6 — 状态语义唯一来源
- `StatusTone` 词汇表（online/offline/starting/stopping/degraded/failed/unknown/notstarted/managed/external/ai/manual/autonomy/localtest）定义于 `components/ui/primitives.tsx`，全站唯一；状态不只靠颜色（icon/label 并用）。
- 语义色：primary=cyan、success=emerald、warning=amber、danger/critical=red、AI=violet、manual=blue、autonomy=cyan、local test=orange、external=slate。

### D7 — 数据与安全边界不变
- 保留全部 routes/API contracts/same-origin/X-Studio-Action/schemaVersion 安全模型。
- 轮询沿用现有频率分类；页面不可见降频由浏览器节流+现有间隔承担；**任何 UI 轮询不触发 Spark generation**。
- secrets/token 不进浏览器（现有服务端代理模式不变）。

## 迁移策略
Phase 1 tokens/组件 → Phase 2 App Shell（新路由渐进加入）→ Phase 3–5 逐页迁移（每页先做旧页功能清单 parity）→ Phase 6 删除死旧 UI（仅 parity 后）、a11y/性能/真实浏览器验收。
