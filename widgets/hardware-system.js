/** CPU 与内存共用一张卡；探不到的事实不占行，高度随内容。 */
import { card, kv, ringWithLegend, useHardware, useOverview } from "./lib/store.js"

const OWN_LABEL = "Yunzai NG"

export default {
  id: "hardware.system",
  page: "overview",
  title: "系统",
  defaultLayout: { w: 8, h: 4, minW: 4, minH: 1, resizable: true, fit: true },

  setup(api) {
    const { data, error } = useHardware(api)
    const overview = useOverview(api)

    return () => {
      const info = data.value
      const models = info?.models
      const mem = info?.memory
      const usage = overview.data.value?.usage
      const rows = []

      if (models?.cpu !== undefined) rows.push(["CPU 型号", models.cpu])
      if (models?.cores !== undefined) {
        rows.push([
          "核数",
          models.physicalCores === undefined
            ? `${models.cores} 线程`
            : `${models.physicalCores} 核 ${models.cores} 线程`
        ])
      }
      if (info?.clock !== undefined) rows.push(["实时频率", `${info.clock} MHz`])
      if (info?.temperature !== undefined) {
        const max = info.temperature.max === undefined ? "" : ` / 上限 ${info.temperature.max} ℃`
        rows.push(["CPU 温度", `${Math.round(info.temperature.main)} ℃${max}`])
      }
      if (mem !== undefined) rows.push(["内存使用", `${api.fmt.bytes(mem.used)} / ${api.fmt.bytes(mem.total)}`])
      if (usage?.rss !== undefined) rows.push(["机器人内存", api.fmt.bytes(usage.rss)])
      if (mem?.cached !== undefined) rows.push(["可回收缓存", api.fmt.bytes(mem.cached)])
      if (models?.memoryType !== undefined) {
        rows.push([
          "内存规格",
          models.memoryClock === undefined ? models.memoryType : `${models.memoryType} ${models.memoryClock} MHz`
        ])
      }
      if (info?.battery !== undefined) {
        const left = info.battery.minutesLeft === undefined
          ? ""
          : ` · 剩余约 ${api.fmt.duration(info.battery.minutesLeft * 60_000)}`
        rows.push(["电池", `${api.fmt.percent(info.battery.level)}${info.battery.charging ? " · 充电中" : left}`])
      }

      const total = mem === undefined ? undefined : api.fmt.ratioOf(mem.used, mem.total)
      const own = usage?.rss === undefined || mem === undefined ? undefined : api.fmt.ratioOf(usage.rss, mem.total)
      const rings = api.h("div", { class: "sys-rings" }, [
        ringWithLegend(api, "CPU", info?.cpu, usage?.cpu, OWN_LABEL),
        ringWithLegend(api, "内存", total, own, OWN_LABEL)
      ])
      const body = api.h("div", { class: "sys-grid" }, [
        kv(api, rows.length === 0 ? [["硬件", "读取中…"]] : rows),
        rings
      ])
      return card(api, "系统", body, error.value === "" ? "整机占用 · 机器人占用取自内核采样" : `更新失败：${error.value}`)
    }
  }
}
