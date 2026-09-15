/**
 * 模块职责：概览页的「Redis」组件 —— 连接状态、内存、键数、命中率
 * 依赖方向：只依赖注入的 `api` 与同目录 `lib/store.js`
 * 生命周期：随所在格子
 * 注意事项：**连不上时这一格照常画出来并写明原因。** 空白或消失的组件说不出「Redis 没起来」这件事，
 *          而那恰是使用者最需要知道的。原因取错误码加一句人话：码便于搜，人话便于当场明白。
 *
 *          **地址由配置给出**，故底部小字写出实际连的是哪个地址 —— 否则「连不上」会让人以为面板连的
 *          是他配的那个远端。小字取自 `api.config`，改完配置那行字立刻就变，不必刷新页面。
 *
 *          **命中率缺失与命中率为 0 是两件事。** node 侧在累计命中与未命中皆为 0 时不给这个字段
 *          （那台 Redis 还没被读过），此处相应地不显示那一行 —— 显示「命中率 0%」会被读成「缓存全都
 *          没命中」，意思正相反。
 *
 *          **默认 h=4 是量出来的。** 连上时七行表共 266px，加标题、小字与内边距实测 317px；h=3 只给
 *          270px，于是默认布局自带一条滚动条。**默认布局不该需要滚动** —— 滚动是「使用者把格子缩小了」
 *          的退路，不是出厂状态。连不上时这一格显得空，但那是异常态，不该由它决定常态的尺寸。
 */
import { card, empty, kv, useEndpoint } from "./lib/store.js"

export default {
  id: "hardware.redis",
  page: "overview",
  title: "Redis",
  defaultLayout: { w: 3, h: 4, minW: 2, minH: 2, resizable: true },
  defaultHidden: true,

  /**
   * 建立组件状态
   * @param {object} api 注入的面板能力
   * @returns {Function} 渲染函数
   */
  setup(api) {
    const { data, error } = useEndpoint(api, "redis")

    /**
     * 当前配置的地址
     *
     * 与 node 侧那半的兜底逐字一致（主机填空即取默认值）：两处不一致时，小字上写的地址
     * 与实际连的那个不是同一台，而那正是这行小字要防的误会。
     */
    const target = api.computed(() => {
      const redis = api.config.value.redis ?? {}
      const host = String(redis.host ?? "").trim()
      return `${host === "" ? "127.0.0.1" : host}:${redis.port ?? 6379}`
    })

    /** 底部小字：写出实际连的地址，理由见文件头 */
    const note = api.computed(() =>
      error.value === "" ? `${target.value} · 地址可在插件页的「配置」里改` : `更新失败：${error.value}`
    )

    return () => {
      const info = data.value
      if (info === undefined) return card(api, "Redis", empty(api, "读取中"), note.value)

      if (info.connected !== true) {
        return card(
          api,
          "Redis",
          empty(api, info.reason === undefined ? "连接失败" : `连接失败：${info.reason}`),
          note.value
        )
      }

      const rows = []
      if (info.version !== undefined) rows.push(["版本", info.version])
      if (info.clients !== undefined) rows.push(["连接数", String(info.clients)])
      if (info.memoryUsed !== undefined) {
        // 有内存上限时给出比例，无上限（maxmemory=0）时只给用量 —— 分母不存在
        const ratio =
          info.memoryMax === undefined
            ? undefined
            : api.fmt.ratioOf(info.memoryUsed, info.memoryMax)
        rows.push([
          "内存",
          ratio === undefined
            ? api.fmt.bytes(info.memoryUsed)
            : `${api.fmt.bytes(info.memoryUsed)} / ${api.fmt.bytes(info.memoryMax)} · ${api.fmt.percent(ratio)}`
        ])
      }
      if (info.keys !== undefined) {
        // 库数与键数写在同一行：它答的是「键摊在几个库里」，单列一行会让这张表
        // 为一个次要事实多占 40px，而这一格的高度是按行数量出来的
        const dbs = info.databases === undefined ? "" : ` · ${info.databases} 个库`
        rows.push(["键数", `${info.keys}${dbs}`])
      }
      // 缺失与 0 是两件事，故缺时整行不出现（见文件头）
      if (info.hitRate !== undefined) rows.push(["命中率", api.fmt.percent(info.hitRate)])
      if (info.ops !== undefined) rows.push(["命令/秒", String(info.ops)])
      if (info.uptime !== undefined) rows.push(["运行", api.fmt.duration(info.uptime)])

      return card(api, "Redis", kv(api, rows), note.value)
    }
  }
}
