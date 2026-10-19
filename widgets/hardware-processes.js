/** 前八名与本机器人；CPU 已换算为占整机比例，内存为字节。 */
import { card, empty, useEndpoint } from "./lib/store.js"

export default {
  id: "hardware.processes",
  page: "overview",
  title: "进程监控",
  defaultLayout: { w: 8, h: 4, minW: 4, minH: 1, resizable: true, fit: true },
  defaultHidden: true,

  setup(api) {
    const { data, error } = useEndpoint(api, "processes")
    return () => {
      const top = data.value?.top ?? []
      const note = error.value === ""
        ? `共 ${data.value?.total ?? "—"} 个进程 · 按 CPU、内存排序`
        : `更新失败：${error.value}`
      if (top.length === 0) return card(api, "进程监控", empty(api, data.value === undefined ? "读取中…" : "未探测到进程"), note)

      const rows = top.map(item => api.h("tr", { key: item.pid }, [
        api.h("td", {}, [
          api.h("span", { class: "hw-process-name", title: `PID ${item.pid}` }, item.name),
          item.self === true ? api.h("span", { class: "hw-own-label" }, "本机器人") : null
        ]),
        api.h("td", { class: "mono" }, api.fmt.percent(item.cpu)),
        api.h("td", { class: "mono" }, item.memory === undefined ? "—" : api.fmt.bytes(item.memory))
      ]))
      return card(api, "进程监控", api.h("table", { class: "hw-processes" }, [
        api.h("thead", {}, [api.h("tr", {}, [
          api.h("th", { scope: "col" }, "进程"),
          api.h("th", { scope: "col" }, "CPU"),
          api.h("th", { scope: "col" }, "内存")
        ])]),
        api.h("tbody", {}, rows)
      ]), note)
    }
  }
}
