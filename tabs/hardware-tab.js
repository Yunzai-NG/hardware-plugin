/**
 * 模块职责：插件页上的「硬件」页签 —— 把本包十枚组件一次铺开，无须逐个添加到概览页
 * 依赖方向：只 import 同包的 `widgets/*.js` 与注入的 `api`；不 import 任何裸包名
 * 生命周期：页签被点开时挂载，切走即卸载（插件页给页签内容加了 key）
 * 注意事项：**页签复用各组件自己的 `setup`，不另写一份渲染。** 两份画法迟早在某个字段上分岔，
 *          而那种差别的表现是「概览页和硬件页显示的不是一个数」—— 最难被当成缺陷报出来。
 *
 *          由此得到的是：十枚组件默认仍不上板（装一个插件不该重排别人的版面），而想看全部
 *          硬件的人有一处一次看完的地方。两处的数据也必然一致 —— `lib/store.js` 按端点归集
 *          共享状态，同一端点的多枚组件每拍只发一次请求，页签与概览页同时开着也不会翻倍。
 *
 *          **格子尺寸取各组件自己声明的 `defaultLayout`**，不在这里另定一套宽高：那几个数是
 *          按内容实测出来的（见各组件文件头的量算），另写一套等于把那些结论重来一遍，且改了
 *          组件之后这里不会跟着变。栅格算式与概览页一致：12 列、行高 80px、间隙 16px。
 */
import cpu from "../widgets/hardware-cpu.js"
import disk from "../widgets/hardware-disk.js"
import gpu from "../widgets/hardware-gpu.js"
import memory from "../widgets/hardware-memory.js"
import net from "../widgets/hardware-net.js"
import processes from "../widgets/hardware-processes.js"
import redis from "../widgets/hardware-redis.js"
import swap from "../widgets/hardware-swap.js"
import sysinfo from "../widgets/hardware-sysinfo.js"
import system from "../widgets/hardware-system.js"

/**
 * 页签里的排布顺序
 *
 * 与 `index.js` 的默认版面顺序刻意一致：「先占用、后清单」。两处若各排一套，同一个人在
 * 概览页与这一页看到的次序不同，而他会以为其中一处漏了什么。
 */
const WIDGETS = [system, cpu, memory, swap, gpu, disk, net, processes, sysinfo, redis]

/** 概览页栅格的行高（px），与 webui 的 GridBoard 一致 */
const ROW_H = 80

/** 概览页栅格的行间隙（px） */
const GAP = 16

/**
 * 由组件声明的格数算出这一格该占多高
 *
 * `h` 行高加其间的 `h-1` 道间隙，与概览页同一个算式 —— 各组件文件头里那些「h=5 只给 464px」
 * 的量算才对得上。
 * @param {number} h 纵向格数
 * @returns {string} CSS 长度
 */
function heightOf(h) {
  return `${h * ROW_H + (h - 1) * GAP}px`
}

/** 硬件页签 */
export default {
  id: "hardware.all",
  title: "硬件",

  /**
   * 建立页签状态
   * @param {object} api 注入的面板能力
   * @returns {Function} 渲染函数
   */
  setup(api) {
    /*
     * 各组件的 setup 在此刻各调一次，拿到它们的渲染函数
     *
     * **只调一次，不在渲染函数里调。** `setup` 里会 `api.ref` 建状态、`api.onTick` 订节拍，
     * 每次重画都调一遍等于每帧多一份状态与一个订阅 —— 表现是越用越慢，且节拍订阅数无上限地涨。
     */
    const cells = WIDGETS.map(widget => ({
      widget,
      render: widget.setup(api)
    }))

    return () =>
      api.h(
        "div",
        { class: "hw-tab" },
        cells.map(cell =>
          api.h(
            "div",
            {
              // key 用组件 id：列表顺序固定，但显式给出可免去 Vue 按下标复用节点
              key: cell.widget.id,
              class: "hw-tab-cell",
              style: {
                gridColumn: `span ${cell.widget.defaultLayout.w}`,
                height: heightOf(cell.widget.defaultLayout.h)
              }
            },
            [cell.render()]
          )
        )
      )
  }
}
