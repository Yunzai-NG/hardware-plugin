/**
 * 负载趋势：整机 CPU 与内存近五分钟的走势
 *
 * 与「系统」那一枚共用同一次整机采样（见 `useHistory`），不多发请求。历史只在浏览器里记，
 * 打开页面时从零开始 —— 头一两拍只有一个点，此时画一枚点而不是空白。
 */
import { HISTORY_POINTS, card, sparkline, useHistory } from "./lib/store.js"

export default {
  id: "hardware.trend",
  page: "overview",
  title: "负载趋势",
  defaultLayout: { w: 4, h: 4, minW: 3, minH: 1, resizable: true, fit: true },

  setup(api) {
    const { points, error } = useHistory(api)

    /**
     * 一条走势：名、当前值、峰值与图
     * @param {string} label 名
     * @param {string} key 取哪一项
     * @param {string} cls 配色类名
     * @returns {object} vnode
     */
    const lane = (label, key, cls) => {
      const values = points.value.map(p => p[key])
      const known = values.filter(v => v !== undefined)
      const now = known.at(-1)
      const peak = known.length === 0 ? undefined : Math.max(...known)
      const avg = known.length === 0 ? undefined : known.reduce((a, b) => a + b, 0) / known.length
      return api.h("div", { class: `hw-lane ${cls}` }, [
        api.h("div", { class: "hw-lane-head" }, [
          api.h("span", { class: "hw-lane-label" }, label),
          api.h("b", { class: `hw-lane-now ${api.fmt.gaugeLevel(now)}` }, api.fmt.percent(now))
        ]),
        sparkline(api, values, cls),
        api.h("p", { class: "hw-lane-foot" }, `均值 ${api.fmt.percent(avg)} · 峰值 ${api.fmt.percent(peak)}`)
      ])
    }

    return () => {
      const span = Math.round((points.value.length * 5) / 60)
      const note = error.value !== "" ? `更新失败：${error.value}` : ""
      return card(api, "负载趋势", api.h("div", { class: "hw-lanes" }, [lane("CPU", "cpu", "lane-cpu"), lane("内存", "memory", "lane-mem")]), note, {
        sub: points.value.length < HISTORY_POINTS ? `打开页面后已记录 ${span < 1 ? "不到 1" : span} 分钟` : "近 5 分钟 · 每 5 秒一点"
      })
    }
  }
}
