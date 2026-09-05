/**
 * 模块职责：概览页的「进程监控」组件 —— 占用最高的若干个进程
 * 依赖方向：只依赖注入的 `api` 与同目录 `lib/store.js`
 * 生命周期：随所在格子
 * 注意事项：**本机器人自己那一行标出来。** node 侧按 `process.pid` 打了 `self` 标记 ——
 *          「机器人自己吃了多少」是使用者看这个组件的首要目的，让他在十几行里按名字
 *          自己找等于把最要紧的事藏起来。
 *
 *          **CPU 列已换算成占整机的比例**（node 侧除以核数，见 `processes.ts`）。
 *          `si.processes()` 原始的 `pcpu` 是占**单核**的百分比，16 核机器上一个吃满
 *          两个核的进程给 200 —— 直接显示就会出现「某进程 CPU 200%」。
 *
 *          **默认不上板**：一张十几行的表是给排查用的，不该默认占掉概览页一大格。
 */
import { card, empty, useEndpoint } from "./lib/store.js"

/*
 * 默认 h=6，由实测定出而非估算
 *
 * 本机实测（1600px 宽、6 列）：表头 35px + 九行各 40px = 395px，内容盒共要 396px。
 * 卡片里除内容之外的壳子固定占 87px（标题 24px + 其下 8px + 小字 21px + 上下内边距
 * 各 16px），故卡片至少要 483px。行高 80px、间隙 16px，h=5 只有 464px（内容盒 377px，
 * 差 19px），只能上到 h=6 的 560px。**默认布局不该需要滚动**，（另有一处同源的结论）
 * 及 `hardware-sysinfo.js` 的结论同一条。
 *
 * 九行是这张表的**上限**而非偶然：node 侧取前 `TOP_N`（8）个，本机器人不在其中时
 * 再补它自己一行（见 `processes.ts`），故正文最多九行。h=6 于是有余量而非刚好卡住。
 *
 * 另一条路是把 `TOP_N` 减到 7 —— 表降到 356px 便装进 h=5。不取：少列一个进程换一行
 * 高度，而这一枚存在的理由正是「把占用最高的那几个摊开」。
 */
export default {
  id: "hardware.processes",
  page: "overview",
  title: "进程监控",
  defaultLayout: { w: 6, h: 6, minW: 4, minH: 3, resizable: true },
  defaultHidden: true,

  /**
   * 建立组件状态
   * @param {object} api 注入的面板能力
   * @returns {Function} 渲染函数
   */
  setup(api) {
    const { data, error } = useEndpoint(api, "processes")

    /** 底部小字 */
    const note = api.computed(() => {
      if (error.value !== "") return `更新失败：${error.value}`
      const total = data.value?.total
      return total === undefined ? "占用最高的进程" : `共 ${total} 个进程，列出占用最高的若干个`
    })

    return () => {
      const top = data.value?.top ?? []
      if (top.length === 0) {
        return card(
          api,
          "进程监控",
          empty(api, data.value === undefined ? "读取中" : "未探测到进程"),
          note.value
        )
      }

      const head = api.h("tr", {}, [
        api.h("th", {}, "进程"),
        api.h("th", { style: "text-align: right" }, "CPU"),
        api.h("th", { style: "text-align: right" }, "内存")
      ])

      const rows = top.map(item =>
        api.h("tr", {}, [
          api.h(
            "td",
            {},
            // 自己那一行加一枚标记；用文字而非仅靠颜色，色觉障碍者同样看得出
            item.self === true
              ? [api.h("span", { class: "pill" }, "本机器人"), ` ${item.name}`]
              : item.name
          ),
          api.h(
            "td",
            { class: "mono", style: "text-align: right" },
            api.fmt.percent(item.cpu)
          ),
          api.h(
            "td",
            { class: "mono", style: "text-align: right" },
            item.memory === undefined ? "—" : api.fmt.bytes(item.memory)
          )
        ])
      )

      /*
       * 表外面包一层 div：表格不能做卡片的直接子元素
       *
       * 面板样式表那条 `.board .card.fill > :not(h2, .sub:last-child)` 会给直接子元素
       * 写 `display: flex` —— 表格被改写成 flex 容器后，thead 与 tbody 各自块化成一枚
       * flex 项，浏览器再把两者的行各包进一张匿名表：两张匿名表各自算列宽，表头按
       * 内容收成窄条、表体被长进程名撑宽，两者从此对不齐。与本包 style.css 里
       * `.sys-body` 记的是同一个坑，照那样多包一层躲开。
       */
      return card(
        api,
        "进程监控",
        api.h("div", null, [
          api.h("table", { class: "table" }, [
            api.h("thead", {}, [head]),
            api.h("tbody", {}, rows)
          ])
        ]),
        note.value
      )
    }
  }
}
