/**
 * 模块职责：「完整配置」清单 —— 取数、分节渲染，以及系统卡上那枚按钮弹出的对话框
 * 依赖方向：只用注入的 `api` 与同目录的 `icons.js`
 * 生命周期：清单只在有人要看时才取（打开对话框，或「完整配置」那一枚上板）；探完即不再请求
 * 注意事项：**node 侧首次不等探测**，回 `ready: false`；这里每秒再问一次直到拿到整份，
 *          不跟 5 秒的节拍 —— 那样打开对话框要干等一拍。
 *
 *          对话框用原生 `<dialog>` 的 `showModal()`：焦点圈在框内、Esc 关闭、背景不可点，
 *          都由浏览器给，不必自己写。它渲染在卡片里，故本包限定过的样式照样生效。
 */
import { icon } from "./icons.js"

/** 未探完时多久再问一次 */
const RETRY_MS = 1000

/** 各节的图标 */
const SECTION_ICONS = { cpu: "cpu", memory: "memory", board: "board", gpu: "gpu", disk: "disk", os: "os", net: "net" }

/** 全包共用一份：探完之后再开一次对话框不必重取 */
let cached
let inflight

/**
 * 取完整配置；未探完时每秒重试，直到拿到或组件不再需要
 * @param {object} api 注入的面板能力
 * @returns {object} `{ specs, error, start }`；调 `start()` 才开始取
 */
export function useSpecs(api) {
  const specs = api.ref(cached)
  const error = api.ref("")
  let alive = true
  let timer
  api.onUnmounted(() => {
    alive = false
    globalThis.clearTimeout(timer)
  })

  const load = async () => {
    if (!alive) return
    try {
      inflight ??= api.own("specs").finally(() => {
        inflight = undefined
      })
      const got = await inflight
      if (got?.ready === true) {
        cached = got
        specs.value = got
        error.value = ""
        return
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    }
    if (alive) timer = globalThis.setTimeout(() => void load(), RETRY_MS)
  }

  const start = () => {
    if (cached !== undefined) specs.value = cached
    else void load()
  }
  return { specs, error, start }
}

/**
 * 一组「名 → 值」
 * @param {object} api 注入的面板能力
 * @param {Array<[string, string]>} rows 行
 * @returns {object} vnode
 */
function pairs(api, rows) {
  return api.h(
    "dl",
    { class: "spec-pairs" },
    rows.flatMap(([name, value]) => [api.h("dt", {}, name), api.h("dd", {}, value)])
  )
}

/**
 * 分节渲染整份清单
 * @param {object} api 注入的面板能力
 * @param {object|undefined} specs node 侧给的清单
 * @param {string} error 最近一次的错误
 * @returns {object} vnode
 */
export function specsView(api, specs, error) {
  if (specs === undefined) {
    return api.h("p", { class: "sub hw-empty spec-wait" }, error === "" ? "正在读取硬件配置，首次约需几秒…" : `读取失败：${error}`)
  }
  if (specs.sections.length === 0) return api.h("p", { class: "sub hw-empty" }, "这台机器上没有探到可列出的配置")
  return api.h(
    "div",
    { class: "spec-grid" },
    specs.sections.map(section =>
      api.h("section", { class: `spec-sec spec-${section.id}` }, [
        api.h("h3", { class: "spec-title" }, [
          api.h("span", { class: "hw-badge" }, [icon(api, SECTION_ICONS[section.id] ?? "info")]),
          section.title
        ]),
        section.rows === undefined || section.rows.length === 0 ? null : pairs(api, section.rows),
        ...(section.items ?? []).map(item =>
          api.h("div", { class: "spec-item" }, [api.h("p", { class: "spec-item-title" }, item.title), pairs(api, item.rows)])
        )
      ])
    )
  )
}

/**
 * 系统卡右上角那枚按钮，连同它弹出的对话框
 * @param {object} api 注入的面板能力
 * @returns {Function} 渲染函数，返回按钮与对话框
 */
export function specsButton(api) {
  const { specs, error, start } = useSpecs(api)
  let dialog

  const open = () => {
    start()
    dialog?.showModal()
  }
  const close = () => dialog?.close()

  return () => [
    api.h("button", { type: "button", class: "hw-link", onClick: open }, [icon(api, "list"), "完整配置"]),
    api.h(
      "dialog",
      {
        class: "spec-dialog",
        "aria-labelledby": "hw-spec-title",
        ref: el => {
          dialog = el ?? undefined
        },
        // 点到遮罩（即 dialog 自身而非其内容）时关闭
        onClick: event => {
          if (event.target === dialog) close()
        }
      },
      [
        api.h("div", { class: "spec-sheet" }, [
          api.h("header", { class: "spec-head" }, [
            api.h("span", { class: "hw-badge" }, [icon(api, "list")]),
            api.h("h2", { id: "hw-spec-title" }, "完整配置"),
            api.h("button", { type: "button", class: "spec-close", "aria-label": "关闭", onClick: close }, [icon(api, "close")])
          ]),
          api.h("div", { class: "spec-body" }, [specsView(api, specs.value, error.value)]),
          api.h("p", { class: "sub spec-foot" }, "序列号、UUID 与 MAC 地址不在此列；换过硬件后重载 webui 即可刷新")
        ])
      ]
    )
  ]
}
