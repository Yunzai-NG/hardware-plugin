/**
 * 模块职责：概览页的「磁盘」组件 —— 各分区占用，附全盘读写速率
 * 依赖方向：只依赖注入的 `api` 与同目录 `lib/store.js`
 * 生命周期：随所在格子
 * 注意事项：**与内置的磁盘组件并存，不取代它。** 内置那枚取自内核的 `/api/system`，
 *          只给挂载点与容量；这一枚多给文件系统类型与**读写速率**（`si.fsStats()`）。
 *          两者的数一致（同源于同一个 `statfs`），故不构成「两个数不一样」的问题 ——
 *          这与 CPU / 内存那两枚环的情形不同，那里两个数的口径本就不同。
 *
 *          **默认不上板**：内置的磁盘组件已默认在板上，两枚一起出现会让概览页有两张
 *          磁盘卡片。要读写速率的人自行添加，或把内置那枚移除。
 *
 *          **速率为 undefined 时那一行整个不出现**，不写「0 B/s」：首次采样必然没有速率
 *          （速率非两点不可得），而「0 B/s」会被读成「磁盘完全空闲」。
 */
import { bar, card, empty, rate, useEndpoint } from "./lib/store.js"

export default {
  id: "hardware.disk",
  page: "overview",
  title: "磁盘与读写",
  defaultLayout: { w: 8, h: 3, minW: 4, minH: 1, resizable: true, fit: true },
  defaultHidden: true,

  /**
   * 建立组件状态
   * @param {object} api 注入的面板能力
   * @returns {Function} 渲染函数
   */
  setup(api) {
    const { data, error } = useEndpoint(api, "disks")

    /** 底部小字：读写速率，取不到时说明缘由 */
    const note = api.computed(() => {
      if (error.value !== "") return `更新失败：${error.value}`
      const io = data.value?.io
      if (io === undefined) return "整机分区占用"
      const parts = []
      if (io.read !== undefined) parts.push(`读 ${rate(api, io.read)}`)
      if (io.write !== undefined) parts.push(`写 ${rate(api, io.write)}`)
      return parts.length === 0 ? "读写速率需要两次采样，稍候出现" : parts.join(" · ")
    })

    return () => {
      const parts = data.value?.partitions ?? []
      if (parts.length === 0) {
        return card(
          api,
          "磁盘与读写",
          empty(api, data.value === undefined ? "读取中" : "未探测到分区"),
          note.value
        )
      }

      const rows = parts.map(item => {
        const ratio = api.fmt.ratioOf(item.used, item.total)
        const label = item.type === undefined ? item.mount : `${item.mount} · ${item.type}`
        return bar(
          api,
          label,
          ratio,
          `${api.fmt.percent(ratio)} · 剩 ${api.fmt.bytes(item.free)} / ${api.fmt.bytes(item.total)}`
        )
      })

      return card(api, "磁盘与读写", api.h("div", { class: "bars" }, rows), note.value)
    }
  }
}
