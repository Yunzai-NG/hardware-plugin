/**
 * 模块职责：概览页的「CPU」组件 —— 一枚双色环，整机与本进程占用同环异色
 * 依赖方向：只 import 同目录下的 `lib/store.js`（同源相对路径）；不 import 任何包
 * 生命周期：随所在格子；节拍订阅由 `api.onTick` 在卸载时自动退订
 * 注意事项：**标题就叫「CPU」，不带「（全机）」。** webui 已撤掉那枚本进程环，故这一页上不再有第二个
 *          叫 CPU 的东西，限定词失去意义。反过来说这个标题与「撤掉内置环」互为前提 —— 内置环还在时
 *          不加限定词就有两个「CPU 占用」。
 *
 *          **默认不上板，因为「系统」那一枚已经把 CPU 说了。** 这一枚留着是给「只想要一枚 CPU 环、
 *          不要那张事实表」的人：两枚同时上板会让概览页出现两个 CPU 占用，而它们取自同一份采样 ——
 *          同一个数在一页上出现两次，读者只会怀疑哪一个是错的。见 `hardware-system.js`。
 *
 *          **两个数取自两个来源，各取所长。** 整机数走本包的 node 侧（`os.cpus()` 作差），本进程数走
 *          内核既有的 `/api/overview` —— 后者内核本就在算，再采一遍就是同一事实的第二个来源，而两处
 *          采样时刻不同必然给出两个数。
 *
 *          首次请求时整机 CPU **没有数**（要两个采样点才作得出差），此时环心是破折号而非 0% ——
 *          0% 会被读成「机器闲着」。本进程那段同理，缺则不画。
 */
import { gaugeCard, ring, useHardware, useOverview } from "./lib/store.js"

export default {
  id: "hardware.cpu",
  page: "overview",
  title: "CPU",
  defaultLayout: { w: 3, h: 3, minW: 2, minH: 3, resizable: true },
  defaultHidden: true,

  /**
   * 建立组件状态
   * @param {object} api 注入的面板能力
   * @returns {Function} 渲染函数
   */
  setup(api) {
    const { data, error } = useHardware(api)
    const overview = useOverview(api)

    /*
     * 环下的一行小字：两段颜色的图例，其后是型号
     *
     * **必须点明「整机」二字。** 初版只写「其中本进程 0%」，而环心那个数没有任何
     * 文字说明它是谁 —— 一枚双色环上，读者要先知道大的那一段是整机、亮的那一小段
     * 是本进程，才看得懂这枚环。「其中」这个词假定读者已经知道了前半句。
     */
    const note = api.computed(() => {
      if (error.value !== "") return `更新失败：${error.value}`
      const own = overview.data.value?.usage?.cpu
      const parts = [own === undefined ? "整机占用" : `整机占用，其中本进程 ${api.fmt.percent(own)}`]

      const info = data.value
      const models = info?.models
      if (models?.cpu !== undefined) {
        parts.push(models.cpu)
        parts.push(
          models.physicalCores === undefined
            ? `${models.cores ?? "?"} 线程`
            : `${models.physicalCores} 核 ${models.cores} 线程`
        )
      }

      /*
       * 温度与实时频率各自缺则不写，不留「—— ℃」这样的空位
       *
       * 台式机、虚拟机与多数容器读不到温度传感器，那是常态而非故障；一行小字里
       * 出现一个空着的字段，看起来像这一格坏了。node 侧在读不到时整项不给（见
       * `probe.ts` 的 `tempOf`），故此处只需判断「在不在」。
       */
      const temp = info?.temperature?.main
      if (temp !== undefined) parts.push(`${Math.round(temp)} ℃`)
      const clock = info?.clock
      if (clock !== undefined) parts.push(`${(clock / 1000).toFixed(1)} GHz`)

      return parts.join(" · ")
    })

    return () =>
      gaugeCard(
        api,
        ring(api, "CPU", data.value?.cpu, overview.data.value?.usage?.cpu, note.value)
      )
  }
}
