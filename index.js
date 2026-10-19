/**
 * 模块职责：浏览器侧入口 —— 把本包提供的十二枚组件汇总成一份清单交给 webui
 * 依赖方向：只 import 同目录下的 `widgets/*.js`（同源相对路径）；不 import 任何包
 * 生命周期：webui 在页面加载期 `import()` 本文件一次
 * 注意事项：**多文件面板插件包的浏览器入口固定是包根的 `index.js`。** webui 只 import 这一个文件，
 *          其余靠相对路径由它自己引 —— 整个包目录都是静态可取的。
 *
 *          **默认导出是一个数组。** 本包给出十二枚组件，若坚持「一文件一组件」使用者就得装十二个包。
 *          数组里有一枚写错时其余照常上板，被丢掉的那枚在控制台留一句「第 N 个组件：……」。
 *
 *          **数组顺序即默认版面顺序**（注册表按注册顺序补空位）。故排法是「先占用、后清单」：
 *          「系统」与「负载趋势」在最前（默认上板），其余占用类随后，磁盘与网络居中，进程表、
 *          系统信息、完整配置与 Redis 在后 —— 那几枚是「要查什么才去看」的，不该占据视线最先落到的位置。
 *
 *          **十二枚里只有两枚默认上板。** 装一个插件不该重排任何人的版面，而一齐上板等于把概览页整个
 *          换掉。「系统」接替 webui 撤掉的本进程 CPU 环与显卡环，否则升级后的概览页会**少掉**两枚环；
 *          「负载趋势」与它共用同一次采样，占 4 列与它并排。CPU 与内存那两枚单环与「系统」取自同一份
 *          采样，默认不上板 —— 否则同一个数会在概览页上出现两次。
 *
 *          **不能 import 裸包名。** 浏览器按 URL 解析模块说明符，`import si from "systeminformation"`
 *          在这里是一条网络错误。要用的能力一概经注入的 `api` 取；node 侧的依赖是那一半的事。
 */
import cpu from "./widgets/hardware-cpu.js"
import disk from "./widgets/hardware-disk.js"
import gpu from "./widgets/hardware-gpu.js"
import memory from "./widgets/hardware-memory.js"
import net from "./widgets/hardware-net.js"
import processes from "./widgets/hardware-processes.js"
import redis from "./widgets/hardware-redis.js"
import specs from "./widgets/hardware-specs.js"
import swap from "./widgets/hardware-swap.js"
import sysinfo from "./widgets/hardware-sysinfo.js"
import system from "./widgets/hardware-system.js"
import trend from "./widgets/hardware-trend.js"

export default [system, trend, cpu, memory, swap, gpu, disk, net, processes, sysinfo, specs, redis]
