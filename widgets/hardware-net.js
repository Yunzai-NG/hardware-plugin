/**
 * 模块职责：概览页的「网络」组件 —— 各网卡收发速率，以及对外探测的结果
 * 依赖方向：只依赖注入的 `api` 与同目录 `lib/store.js`
 * 生命周期：随所在格子
 * 注意事项：**对外探测默认为空，故那一段默认不出现。** 替使用者决定去连某个网站是他没同意过的事
 *          （离网部署上那还是一串必然失败的探测），故目标由配置给出。一个都没配时只显示网卡速率，
 *          并在底部说明这一点。
 *
 *          **速率那一段读的是 `rates`。** node 侧给的是 `{ rates, probes }`（见 `net.ts` 的 `NetInfo`）——
 *          曾经写成 `interfaces`，于是速率恒为空、卡片上永远「未探测到网卡」，而它不报任何错。
 *          字段名对不上这类错只有把两边并排看才发现，故此处点明取的是哪一个。
 *
 *          **从未收发过字节的网卡不在里头**（node 侧的 `pickUsed` 已筛掉）：一台机器常有五六块虚拟
 *          网卡，逐块列出只会让一行有数的表高出一倍。
 *
 *          **速率为 undefined 时不写 0 B/s。** 首次采样必然没有速率（非两点不可得），而「0 B/s」会被
 *          读成「这张网卡没有流量」。node 侧在累计量倒退时（网卡重置）也不给该字段。
 *
 *          **状态码不着色成「成功 / 失败」两档。** 探测拿到 301 或 403 都说明「通了」，而那正是探测要
 *          回答的问题；按 2xx 才算成功会把一个健康的站点标红。只有真正没拿到响应才是失败。
 */
import { card, empty, kv, rate, useEndpoint } from "./lib/store.js"

export default {
  id: "hardware.net",
  page: "overview",
  title: "网络",
  defaultLayout: { w: 4, h: 2, minW: 3, minH: 1, resizable: true, fit: true },
  defaultHidden: true,

  /**
   * 建立组件状态
   * @param {object} api 注入的面板能力
   * @returns {Function} 渲染函数
   */
  setup(api) {
    const { data, error } = useEndpoint(api, "net")

    /** 底部小字 */
    const note = api.computed(() => {
      if (error.value !== "") return `更新失败：${error.value}`
      const probes = data.value?.probes ?? []
      return probes.length === 0 ? "网卡速率 · 未配置探测目标" : "网卡速率与对外探测"
    })

    return () => {
      const info = data.value
      if (info === undefined) return card(api, "网络", empty(api, "读取中"), note.value)

      const rows = []

      for (const item of info.rates ?? []) {
        // 两个方向都没有速率时说明还没有第二个采样点，此时给一句话而不是两个 0
        const text =
          item.rx === undefined && item.tx === undefined
            ? "等待下一次采样"
            : `↓ ${item.rx === undefined ? "—" : rate(api, item.rx)} · ↑ ${item.tx === undefined ? "—" : rate(api, item.tx)}`
        rows.push([item.iface, text])
      }

      if (rows.length === 0) rows.push(["网卡", "未探测到网卡"])

      for (const item of info.probes ?? []) {
        // 拿到任何状态码都算「通了」，理由见文件头
        rows.push([
          item.name,
          item.error === undefined
            ? `${item.status} · ${item.latency}ms`
            : `失败：${item.error}`
        ])
      }

      return card(api, "网络", kv(api, rows), note.value)
    }
  }
}
