/**
 * 完整配置：处理器、内存条、主板与固件、显卡与显示器、存储设备、系统、网络适配器
 *
 * 与系统卡右上角那枚按钮弹出的是同一份清单，这一枚把它摊在版面上。**默认不上板**：清单很长，
 * 且多是查一次就够的事实；首次取数时 node 侧要起若干子进程，只在有人要看时才付这份开销。
 */
import { useSpecs, specsView } from "./lib/specs.js"
import { card } from "./lib/store.js"

export default {
  id: "hardware.specs",
  page: "overview",
  title: "完整配置",
  defaultLayout: { w: 12, h: 6, minW: 4, minH: 1, resizable: true, fit: true },
  defaultHidden: true,

  setup(api) {
    const { specs, error, start } = useSpecs(api)
    start()
    return () => card(api, "完整配置", specsView(api, specs.value, error.value), "序列号、UUID 与 MAC 地址不在此列")
  }
}
