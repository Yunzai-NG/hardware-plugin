/**
 * 模块职责：概览页的「系统」组件 —— CPU 与内存合成一张卡，左侧事实、右侧两枚带图例的环
 * 依赖方向：只依赖注入的 `api` 与同目录 `lib/store.js`
 * 生命周期：随所在格子
 * 注意事项：**这一枚把 CPU 与内存合起来说，而不是两枚各占一格。** 两者是「这台机器现在忙不忙」
 *          的同一个问题的两半：型号、核数、主频、总量、使用量都是一眼要扫完的事实，分成两格
 *          之后使用者的视线要来回两趟，而两格之间还夹着别的卡片。
 *
 *          **占用分三段：本核心 / 其他占用 / 空闲。** 早先只有「整机」与「本进程」两段，而那
 *          留下一个读不出来的问题 —— 整机 29% 里有多少不是机器人干的？三段之后每一种颜色都
 *          有名字，且三行加起来恰是 100%。三个比例一律取 `dist/rings.js` 的 `ringLegend`
 *          （有用例钉住）：「其他占用」是整机减本进程，没有任何接口直接给这个数。
 *
 *          **本核心那一段就叫「Yunzai NG」，是一个常量。** 曾想从 `/api/overview` 读一个内核名，
 *          而那个响应里**没有**这样的字段（只有 `version` / `status` / `platform` 一类）——
 *          写 `overview.name` 不报错，只会永远取到 undefined 而静默退回兜底文案，
 *          于是「读取内核身份」这件事看起来做了、实际从未生效。故直接写常量。
 *
 *          **CPU 首次采样没有数**（要两个采样点才作得出差），此时环心是破折号而非 0% ——
 *          0% 会被读成「机器闲着」。三段图例同理，缺则整条给破折号。
 *
 *          **它替掉了原先的 CPU 与内存两枚组件。** 那两枚仍在包里、仍可单独上板（有人只想要
 *          一枚环），但默认上板的是这一枚：装一个插件不该让概览页多出两格。
 */
import { card, kv, ringWithLegend, useHardware, useOverview } from "./lib/store.js"

/**
 * 本核心那一段叫什么
 *
 * 常量而非从接口读，理由见文件头：概览响应里没有内核名这个字段。
 */
const OWN_LABEL = "Yunzai NG"

export default {
  id: "hardware.system",
  page: "overview",
  title: "系统",
  defaultLayout: { w: 6, h: 4, minW: 4, minH: 4, resizable: true },

  /**
   * 建立组件状态
   * @param {object} api 注入的面板能力
   * @returns {Function} 渲染函数
   */
  setup(api) {
    const { data, error } = useHardware(api)
    const overview = useOverview(api)

    /** 整机内存占用（0-1） */
    const memTotal = api.computed(() => {
      const mem = data.value?.memory
      return mem === undefined ? undefined : api.fmt.ratioOf(mem.used, mem.total)
    })

    /**
     * 本进程占整机内存的比例（0-1）
     *
     * 分母是整机内存而不是堆上限：「机器人吃了整机的 2%」才与外环可比。
     */
    const memOwn = api.computed(() => {
      const rss = overview.data.value?.usage?.rss
      const mem = data.value?.memory
      return rss === undefined || mem === undefined ? undefined : api.fmt.ratioOf(rss, mem.total)
    })

    /** 底部小字：更新失败时说明缘由，正常时点明两个数的口径 */
    const note = api.computed(() =>
      error.value === ""
        ? `整机占用 · 其中 ${OWN_LABEL} 一段取自内核自身的采样`
        : `更新失败：${error.value}`
    )

    return () => {
      const info = data.value
      const models = info?.models
      const mem = info?.memory
      const usage = overview.data.value?.usage

      /*
       * 左侧的事实表
       *
       * 探不到的项整行不出现，不填「未知」—— 一行「主频：未知」会让使用者以为探测出了错，
       * 而实情多半是这个平台上取不到这个数。型号那两项要等一轮子进程探测（约两秒）。
       */
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
      rows.push(["CPU 使用率", api.fmt.percent(info?.cpu)])
      if (usage?.cpu !== undefined) rows.push([`${OWN_LABEL} 占用`, api.fmt.percent(usage.cpu)])
      /*
       * 频率与温度：探得到才出现
       *
       * 温度尤其值得看 —— 一台散热不良的机器，温度比占用率更早说明问题。台式机、
       * 虚拟机与多数容器里读不到传感器，那时整行不出现（见 node 侧的 `tempOf`）。
       */
      if (info?.clock !== undefined) rows.push(["CPU 频率", `${info.clock} MHz`])
      if (info?.temperature !== undefined) {
        const max = info.temperature.max === undefined ? "" : ` / 上限 ${info.temperature.max} ℃`
        rows.push(["CPU 温度", `${Math.round(info.temperature.main)} ℃${max}`])
      }

      if (mem !== undefined) {
        rows.push(["内存总量", api.fmt.bytes(mem.total)])
        rows.push(["内存使用量", `${api.fmt.bytes(mem.used)} / ${api.fmt.bytes(mem.total)}`])
      }
      if (usage?.rss !== undefined) rows.push([`${OWN_LABEL} 内存`, api.fmt.bytes(usage.rss)])
      /*
       * 可回收缓存单独一行，只在这个数存在时出现
       *
       * 它是「内存使用量看起来很高」的解释：Linux 把页面缓存算在已用之外的可回收部分里，
       * 而没有这一行时使用者只看到一个偏高的占用，无从知道其中多少是随时能还的。
       * Windows 上这个数常常是 0，那时照样显示 —— 「有这一项且为 0」本身也是一句回答。
       */
      if (mem?.cached !== undefined) rows.push(["可回收缓存", api.fmt.bytes(mem.cached)])
      if (models?.memoryType !== undefined) {
        rows.push([
          "内存规格",
          models.memoryClock === undefined
            ? models.memoryType
            : `${models.memoryType} ${models.memoryClock} MHz`
        ])
      }

      /*
       * 电池只在真有电池时出现
       *
       * node 侧按 `hasBattery` 判定（见 probe.ts 的 `batteryOf`），故台式机与服务器上
       * 这一行整个不出现，而不是显示一枚恒为「0%、未充电」的假电池。
       */
      if (info?.battery !== undefined) {
        const left =
          info.battery.minutesLeft === undefined ? "" : ` · 剩余约 ${api.fmt.duration(info.battery.minutesLeft * 60_000)}`
        rows.push([
          "电池",
          `${api.fmt.percent(info.battery.level)}${info.battery.charging ? " · 充电中" : left}`
        ])
      }

      /*
       * 两枚环并排，各带三段图例
       *
       * 环下的标题即那一枚说的是什么（「CPU」/「内存」），故图例里不必再重复一次。
       */
      const rings = api.h("div", { class: "sys-rings" }, [
        ringWithLegend(api, "CPU", info?.cpu, usage?.cpu, OWN_LABEL),
        ringWithLegend(api, "内存", memTotal.value, memOwn.value, OWN_LABEL)
      ])

      /*
       * 两层，不是一层
       *
       * 外层 `.sys-body` 是 `.card.fill` 的直接子元素，故它落在面板那条
       * `.board .card.fill > :not(h2, .sub:last-child)` 之下 —— 那条给它
       * `display: flex; flex-direction: column`，特指度 0,5,0。本包的样式表被限定后
       * 只有 0,2,0（一个属性选择器加一个类），压不住它：把栅格写在 `.sys-body` 上，
       * `display: grid` 会被面板改回 flex 纵排，两栏**静默**塌成一列 —— 不报错，
       * 只是环跑到表格下面去了。
       *
       * 故栅格落在内层 `.sys-grid` 上：面板那条只管直接子元素，够不到它。
       */
      const body = api.h("div", { class: "sys-body" }, [
        api.h("div", { class: "sys-grid" }, [kv(api, rows), rings])
      ])

      return card(api, "系统", body, note.value)
    }
  }
}
