/**
 * 模块职责：概览页的「交换空间」组件 —— 一条 SWAP 占用
 * 依赖方向：只依赖注入的 `api` 与同目录 `lib/store.js`
 * 生命周期：随所在格子
 * 注意事项：**默认不上板**（`defaultHidden`），理由与显卡同类但不同因：多数机器**有**
 *          交换空间，可它平时是 0%，而一条长期为 0 的槽白占一格。要看的人自己添加。
 *
 *          **没有交换空间时说「未配置」，不画 0%。** node 侧在 `swaptotal` 为 0 时
 *          整个字段不给（见 `probe.ts` 的 `swapOf`），故此处据「字段在不在」分辨
 *          「这台机器没有 swap」与「有 swap 但没在用」—— 两者都显示 0% 就把它们混作一谈了。
 *
 *          **SWAP 高不等于坏，但值得看见。** 故仍按通用阈值着色（`api.fmt.gaugeLevel`），
 *          不为它另定一套 —— 两套阈值意味着同一个百分数在两处是两个颜色。
 */
import { bar, card, empty, useHardware } from "./lib/store.js"

export default {
  id: "hardware.swap",
  page: "overview",
  title: "交换空间",
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
      return "整机交换空间"
    })

    return () => {
      const swap = data.value?.swap
      if (swap === undefined) {
        // 数据还没到、与「这台机器没有 swap」两种情形分开说
        return card(
          api,
          "交换空间",
          empty(api, data.value === undefined ? "读取中" : "本机未配置交换空间"),
          note.value
        )
      }
      const ratio = api.fmt.ratioOf(swap.used, swap.total)
      return card(
        api,
        "交换空间",
        bar(
          api,
          "已用",
          ratio,
          `${api.fmt.percent(ratio)} · ${api.fmt.bytes(swap.used)} / ${api.fmt.bytes(swap.total)}`
        ),
        note.value
      )
    }
  }
}
