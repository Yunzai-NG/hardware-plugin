/**
 * 模块职责：浏览器侧入口 —— 把本包提供的十枚组件汇总成一份清单交给 webui
 * 依赖方向：只 import 同目录下的 `widgets/*.js`（同源相对路径）；不 import 任何包
 * 生命周期：webui 在页面加载期 `import()` 本文件一次
 * 注意事项：**多文件面板插件包的浏览器入口固定是包根的 `index.js`。** webui 只 import 这一个文件，
 *          其余靠相对路径由它自己引 —— 整个包目录都是静态可取的。
 *
 *          **默认导出是一个数组。** 本包给出十枚组件，若坚持「一文件一组件」使用者就得装十个包。
 *          数组里有一枚写错时其余照常上板，被丢掉的那枚在控制台留一句「第 N 个组件：……」。
 *
 *          **数组顺序即默认版面顺序**（注册表按注册顺序补空位）。故排法是「先占用、后清单」：
 *          「系统」那一枚在最前（它是默认唯一上板的），其余占用类随后，磁盘与网络居中，进程表、
 *          系统信息与 Redis 在后 —— 那三枚是「要查什么才去看」的，不该占据视线最先落到的位置。
 *
 *          **十枚里有九枚 `defaultHidden`。** 装一个插件不该重排任何人的版面，而十枚一齐上板等于把
 *          概览页整个换掉。唯一的例外是「系统」那一枚：webui 内置的本进程 CPU 环与显卡环已撤，若它
 *          也默认不上板，升级后的概览页会**少掉**两枚环而不是换掉它们 —— 那是使用者没要求过的减少。
 *          CPU 与内存那两枚原本各自默认上板，如今由「系统」一枚接手（三个数合在一张卡上说），故一并
 *          改为默认不上板 —— 否则同一份采样会在概览页上出现两次。
 *
 *          **不能 import 裸包名。** 浏览器按 URL 解析模块说明符，`import si from "systeminformation"`
 *          在这里是一条网络错误。要用的能力一概经注入的 `api` 取；node 侧的依赖是那一半的事。
 */
import hardwareTab from "./tabs/hardware-tab.js"
import cpu from "./widgets/hardware-cpu.js"
import disk from "./widgets/hardware-disk.js"
import gpu from "./widgets/hardware-gpu.js"
import memory from "./widgets/hardware-memory.js"
import net from "./widgets/hardware-net.js"
import processes from "./widgets/hardware-processes.js"
import redis from "./widgets/hardware-redis.js"
import swap from "./widgets/hardware-swap.js"
import sysinfo from "./widgets/hardware-sysinfo.js"
import system from "./widgets/hardware-system.js"

export default [system, cpu, memory, swap, gpu, disk, net, processes, sysinfo, redis]

/**
 * 本包提供的页签，落在插件页上
 *
 * 与组件是两个导出：组件要 `page` 与 `defaultLayout`，页签不要，混在一处会让校验无从分辨
 * 该按哪套规矩查。
 *
 * **页签存在的理由是那九枚 `defaultHidden` 的组件。** 它们默认不上板（装一个插件不该重排
 * 别人的版面），于是想看整机状况的人得先进编辑模式、逐枚添加、再调格子 —— 而他要的只是
 * 「让我看一眼这台机器」。页签把十枚一次铺开，不动概览页一格。
 */
export const tabs = [hardwareTab]
