// ---------------------------------------------------------------------------
// 写面同源守卫的唯一实现（F-B3）。
//
// 所有破坏性写路由（重启 Studio、删除/停止 Bot、下发目标、改白名单、发布技能）
// 必须走同一个判定，避免「强守卫」与「只查自定义头」两种纪律并存：
//   1. `x-studio-action` 精确匹配动作名 —— 跨站表单/图片无法伪造自定义头，
//      且带自定义头的跨站 fetch 必然触发 CORS 预检（预检本身会被浏览器拒绝）；
//   2. `Origin` 与 `Host` 必须同时存在且同源 —— 浏览器同源请求的硬事实，
//      DNS-rebinding 场景下二者必然不一致；
//   3. `Sec-Fetch-Site` 存在时必须为 `same-origin`。
//
// `requireFetchSite: true` 保留既有更严格调用点（incidents / local-test）的语义：
// 那些调用点原本就要求 `Sec-Fetch-Site` 显式存在，重构到本模块时不得放松。
// ---------------------------------------------------------------------------

export type SameOriginGuardOptions = Readonly<{
  /** 严格模式：必须显式携带 `Sec-Fetch-Site: same-origin`（既有严格调用点用）。 */
  requireFetchSite?: boolean;
}>;

export function isSameOriginAction(
  request: Request,
  action: string,
  options: SameOriginGuardOptions = {},
): boolean {
  if (request.headers.get("x-studio-action") !== action) return false;
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  const fetchSite = request.headers.get("sec-fetch-site");
  if (options.requireFetchSite === true) {
    if (fetchSite !== "same-origin") return false;
  } else if (fetchSite !== null && fetchSite !== "same-origin") {
    return false;
  }
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
