/**
 * 模块职责：本包卡片与配置清单用的线性图标
 * 依赖方向：只用注入的 `api.h`
 * 生命周期：模块级常量
 * 注意事项：一律 24 视口、描边、`currentColor` —— 与面板自身的图标同一画法，颜色由所在语境决定，
 *          故深浅两模式、任何强调色下都不必另写一份。图标是装饰，一律 `aria-hidden`。
 */

/** 图标名 → path 数据 */
export const ICONS = {
  cpu: "M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3M6 6h12v12H6zM10 10h4v4h-4z",
  memory: "M3 8h18v9H3zM7 8v9M11 8v9M15 8v9M5 20v-3M19 20v-3M3 12h2M19 12h2",
  board: "M4 4h16v16H4zM8 8h4v4H8zM15 8h1M15 12h1M8 16h8M12 4v2M4 12h2",
  gpu: "M2 7h18v10H2zM20 10h2M20 14h2M6 17v3M16 17v3M8.5 12a2.5 2.5 0 1 0 5 0 2.5 2.5 0 1 0-5 0",
  disk: "M4 5h16v6H4zM4 13h16v6H4zM8 8h.01M8 16h.01M12 8h4M12 16h4",
  os: "M3 4h18v12H3zM8 20h8M12 16v4",
  net: "M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01",
  swap: "M4 7h13l-3-3M20 17H7l3 3",
  process: "M4 6h16M4 12h10M4 18h7M18 15v6M15 18h6",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18M12 11v6M12 7.5h.01",
  database: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  pulse: "M3 12h4l2-6 4 12 2-6h6",
  temp: "M10 14V5a2 2 0 1 1 4 0v9a4 4 0 1 1-4 0M12 9v6",
  bolt: "M13 2 4 14h7l-1 8 9-12h-7z",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18M12 7v5l3 2",
  battery: "M3 8h15v8H3zM21 11v2M6 11h6",
  bot: "M12 3v3M6 8h12v10H6zM9.5 12h.01M14.5 12h.01M9 15h6M3 12v2M21 12v2",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  close: "M6 6l12 12M18 6 6 18",
  chevron: "M9 6l6 6-6 6"
}

/** 卡片标题 → 图标；没列到的不加图标 */
export const TITLE_ICONS = {
  系统: "cpu",
  CPU: "cpu",
  内存: "memory",
  交换空间: "swap",
  显卡: "gpu",
  磁盘与读写: "disk",
  网络: "net",
  进程监控: "process",
  系统信息: "info",
  Redis: "database",
  负载趋势: "pulse",
  完整配置: "list"
}

/**
 * 一枚图标的 vnode
 * @param {object} api 注入的面板能力
 * @param {string} name 图标名，取 `ICONS` 的键
 * @param {string} [cls] 额外类名
 * @returns {object|null} vnode；名字不认得时为 null
 */
export function icon(api, name, cls = "") {
  const d = ICONS[name]
  if (d === undefined) return null
  return api.h(
    "svg",
    {
      class: `hw-icon ${cls}`.trim(),
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.7",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
      focusable: "false"
    },
    [api.h("path", { d })]
  )
}
