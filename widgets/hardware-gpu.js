/**
 * 模块职责：概览页的「显卡」组件 —— 每块卡一条占用
 * 依赖方向：只依赖注入的 `api` 与同目录 `lib/store.js`
 * 生命周期：随所在格子
 * 注意事项：**标题就叫「显卡」，不带「（全机）」。** 内置的显卡组件已撤，
 *          故这一枚是页面上唯一的显卡组件。理由同 `hardware-memory.js`。
 *
 *          **默认不上板**（`defaultHidden`）：多数机器上占用率测不到（nvidia-smi 只在
 *          N 卡上有，AMD、Intel、Termux 一概没有），默认摆上去等于默认给多数人一格
 *          永远是破折号的东西。
 *
 *          **认得出型号但测不到占用时，槽为空、数值为破折号，不写 0%。** 集显正是这种
 *          情形 —— `si.graphics()` 认得出「Intel Arc 140V」却给不出它的占用率。写 0%
 *          会被读成「这块卡闲着」，而真相是「这块卡没有可用的探测手段」。
 */
import { bar, card, empty, useHardware } from "./lib/store.js"

export default {
  id: "hardware.gpu",
  page: "overview",
  title: "显卡",
  defaultLayout: { w: 4, h: 2, minW: 3, minH: 1, resizable: true, fit: true },
  defaultHidden: true,

  /**
   * 建立组件状态
   * @param {object} api 注入的面板能力
   * @returns {Function} 渲染函数
   */
  setup(api) {
    const { data, error } = useHardware(api)

    /** 底部小字 */
    const note = api.computed(() => {
      if (error.value !== "") return `更新失败：${error.value}`
      const cards = data.value?.gpus ?? []
      // 说清「为什么有的卡没有百分数」，否则那一格破折号看起来像坏了
      return cards.some(item => item.load === undefined)
        ? "集显与部分驱动给不出占用率，此时只列型号"
        : "整机显卡占用"
    })

    return () => {
      const cards = data.value?.gpus ?? []
      if (cards.length === 0) {
        return card(
          api,
          "显卡",
          empty(api, data.value === undefined ? "读取中" : "未探测到显卡"),
          note.value
        )
      }

      const rows = cards.map(item => {
        const vram =
          item.memoryUsed !== undefined && item.memoryTotal !== undefined
            ? ` · ${api.fmt.bytes(item.memoryUsed)} / ${api.fmt.bytes(item.memoryTotal)}`
            : item.memoryTotal !== undefined
              ? ` · ${api.fmt.bytes(item.memoryTotal)}`
              : ""
        return bar(api, item.name, item.load, `${api.fmt.percent(item.load)}${vram}`)
      })

      return card(api, "显卡", api.h("div", { class: "bars" }, rows), note.value)
    }
  }
}
