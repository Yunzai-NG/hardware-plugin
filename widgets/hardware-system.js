/**
 * 系统卡：两枚带图例的双色环（CPU / 内存）加一排指标片，标题下是 CPU 型号，右上角可展开完整配置
 *
 * 探不到的指标不出片，高度随内容。型号、插槽、缓存这类查阅用的事实在「完整配置」里，不挤在卡上。
 */
import { icon } from "./lib/icons.js"
import { specsButton } from "./lib/specs.js"
import { card, ringWithLegend, useHardware, useOverview } from "./lib/store.js"

const OWN_LABEL = "Yunzai NG"

/**
 * 一枚指标片
 * @param {object} api 注入的面板能力
 * @param {string} mark 图标名
 * @param {string} label 名
 * @param {string} value 值
 * @returns {object} vnode
 */
function chip(api, mark, label, value) {
  return api.h("div", { class: "hw-chip" }, [
    icon(api, mark),
    api.h("span", { class: "hw-chip-label" }, label),
    api.h("b", { class: "hw-chip-value" }, value)
  ])
}

export default {
  id: "hardware.system",
  page: "overview",
  title: "系统",
  defaultLayout: { w: 8, h: 4, minW: 4, minH: 1, resizable: true, fit: true },

  setup(api) {
    const { data, error } = useHardware(api)
    const overview = useOverview(api)
    const specs = specsButton(api)

    return () => {
      const info = data.value
      const models = info?.models
      const mem = info?.memory
      const usage = overview.data.value?.usage
      const chips = []

      if (models?.cores !== undefined) {
        chips.push(chip(api, "cpu", "核心", models.physicalCores === undefined ? `${models.cores} 线程` : `${models.physicalCores} 核 ${models.cores} 线程`))
      }
      if (info?.clock !== undefined) chips.push(chip(api, "bolt", "频率", `${(info.clock / 1000).toFixed(2)} GHz`))
      if (info?.temperature !== undefined) chips.push(chip(api, "temp", "温度", `${Math.round(info.temperature.main)} ℃`))
      if (mem !== undefined) chips.push(chip(api, "memory", "内存", `${api.fmt.bytes(mem.used)} / ${api.fmt.bytes(mem.total)}`))
      if (models?.memoryType !== undefined) {
        chips.push(chip(api, "board", "规格", models.memoryClock === undefined ? models.memoryType : `${models.memoryType}-${models.memoryClock}`))
      }
      if (usage?.rss !== undefined) chips.push(chip(api, "bot", "机器人", api.fmt.bytes(usage.rss)))
      if (info?.battery !== undefined) {
        chips.push(chip(api, "battery", "电池", `${api.fmt.percent(info.battery.level)}${info.battery.charging ? " 充电中" : ""}`))
      }

      const total = mem === undefined ? undefined : api.fmt.ratioOf(mem.used, mem.total)
      const own = usage?.rss === undefined || mem === undefined ? undefined : api.fmt.ratioOf(usage.rss, mem.total)
      const body = [
        api.h("div", { class: "sys-rings" }, [
          ringWithLegend(api, "CPU", info?.cpu, usage?.cpu, OWN_LABEL),
          ringWithLegend(api, "内存", total, own, OWN_LABEL)
        ]),
        chips.length === 0 ? api.h("p", { class: "sub hw-empty" }, "读取中…") : api.h("div", { class: "hw-chips" }, chips)
      ]
      return card(api, "系统", body, error.value === "" ? "" : `更新失败：${error.value}`, {
        sub: models?.cpu ?? "整机占用 · 机器人占用取自内核采样",
        action: api.h("div", { class: "hw-actions" }, specs())
      })
    }
  }
}
