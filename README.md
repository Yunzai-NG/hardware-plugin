# hardware-plugin

Yunzai NG 的硬件信息插件：整机 CPU、内存与各显卡占用，兼作**面板插件的示例**。

本仓库是 [Yunzai NG](https://github.com/Yunzai-NG/yunzai-ng) 的官方可选插件，不随内核分发。
插件名为 `hardware`（目录名为 `hardware-plugin`）。

## 它做什么

装上并重载面板之后，概览页的「添加组件」里会多出十二枚组件：**系统**、**负载趋势**、**CPU**、
**内存**、**交换空间**、**显卡**、**磁盘**、**网络**、**进程**、**系统信息**、**完整配置**、**Redis**。

其中**「系统」与「负载趋势」默认上板**（8 + 4 列并排）；余下十枚出现在编辑态的「已移除」一栏里。
装一个插件不该重排任何人已排好的版面，而十二枚一齐上板等于把概览页整个换掉。

「系统」那一枚：标题下是 CPU 型号，两枚环各带三段图例 —— **Yunzai NG 占用 / 其他占用 / 空闲**，
三行加起来恰是 100%（「其他占用」是整机减本进程算出来的）；其下一排指标片（核心、频率、温度、内存、
规格、机器人内存、电池）。右上角「完整配置」弹出整机清单：处理器（核心、频率、插槽、各级缓存、
虚拟化）、每根内存条、主板与 BIOS、显卡与显示器、存储设备（接口、固件、健康）、系统版本与时区、
网络适配器。**序列号、UUID 与 MAC 不在其中**。同一份清单也可作为「完整配置」组件摊在版面上。

「负载趋势」画整机 CPU 与内存近五分钟的走势，与「系统」共用同一次采样；历史只在浏览器里记，
打开页面时从零开始。

CPU 与内存那两枚单环仍在包里，给「只想要一枚环」的人。**它们与「系统」不该同时上板** ——
同一份采样在一页上出现两次，读者只会怀疑哪一个是错的。

组件默认按 8 / 4 列布局，高度随内容变化，不在卡内滚动；颜色取面板的强调色，随外观页一起变。
需要 **webui 0.6.0 及以上**。不再贡献「硬件」页签。

数据也可直接取用：`GET /plugin/hardware/hardware`（照常鉴权）。

## 为什么它不在内核里

`systeminformation` 是 858 KB / 27 个文件，而它换来的东西对一台只跑机器人的服务器并非必需。
内核只用 `node:os` 与 `nvidia-smi` 能拿到的那些，想要更细的由本插件补上。

## 两半

面板插件是**浏览器侧的 ESM**，碰不到 `statfs` 与 `nvidia-smi`，故本插件分两半：

```
src/index.ts             node 侧：注册 GET /plugin/hardware/hardware 等端点
src/probe.ts             型号探测（只探一次）与占用采样
src/rings.ts             双色环与三段图例的几何，由 vitest 钉住
src/procfs.ts            Linux 上直读 /proc 的进程表与网卡累计量
src/throttle.ts          限频与并发合并：同一时刻的多次请求共用一次采样
src/specs.ts             完整配置清单：打开时才探，探完记住，序列号一类不出
index.js                 面板侧入口：把十二枚组件汇总成一个数组
widgets/hardware-*.js    十二枚组件，手写 ESM，不经构建
widgets/lib/store.js     共用的取数、画环、画走势与卡片外壳
widgets/lib/specs.js     完整配置的取数、分节渲染与对话框
widgets/lib/icons.js     卡片与清单用的线性图标
style.css                本包自带的样式表，由 webuiPanel.style 声明
```

浏览器入口固定是包根的 `index.js`，其余靠相对路径由它自己引 —— 整个包目录都是静态可取的。
写法见[面板插件](https://yunzai-ng.github.io/panel-plugin)，本包这几个文件即是带注释的
完整示例。

**几何写在 `src/` 而不是 `widgets/`。** 两段弧的 dasharray 算错**不报错**，只表现为「环画得
不对」，故它写成 TypeScript 由用例钉住，浏览器侧 import 编译产物（`dist/rings.js`）。这条路
走得通的前提是 `src/rings.ts` **不 import 任何东西** —— 一旦引了 `node:` 内置模块或 `si`，
浏览器那侧就会在 import 时报错。

**`.legend-*`、`.sys-*` 与 `.ring-own` 这些类名在面板样式表里没有**，故本包自带一份
`style.css`。面板会把其中每条选择器限定到本包之后才注入，改不到面板别处；但 `@keyframes`
的名字是全局的，若要写动画须自加前缀。

## 取数口径

- **CPU** 取 `os.cpus()` 各核时间累计量作差，不用 `si.currentLoad()`（后者 511ms 且每次起
  子进程）。首次采样无差可作，此时该值**不出现**而非记 0 —— 0 会被读成「机器闲着」
- **内存** 优先用 `si.mem().available` 计算已用量，探测失败时退回 `totalmem() - freemem()`
- **显卡** 两路合并：`nvidia-smi` 管占用率（复用内核的 `probeGpus()`，不另写一份解析 ——
  两份解析迟早会对同一块卡给出两个数），`si.graphics()` 管型号与集显。集显有型号而无占用率，
  故槽为空而非 0%。虚拟显示器（ToDesk、GameViewer 一类）按名字排掉
- **型号**（CPU 型号、内存规格）只探一次：`si.cpu()` 2131ms、`si.graphics()` 2250ms、
  `si.memLayout()` 683ms，且均不缓存。首次请求**不等**它探完，型号在下一轮出现
- **网络** Windows 上一次 PowerShell 读完全部网卡的累计量（si 每张网卡各起一个，约 6 倍慢），
  Linux 直读 `/proc/net/dev`
- **进程** Linux 直读 `/proc/<pid>/stat`，不经 `ps` 与逐进程的 `cat`；读不到时回落 si。
  si 的 `memRss` 是 KiB，换算为字节后显示；直接读 `/proc` 已是字节
- **电池** 60 秒、**温度** 15 秒才重探一次，读不到的项 10 分钟内不再探 —— 这两项在 Windows 上
  各要起一个 PowerShell，而它们几乎不变
- 页面切到后台时不轮询；多个页签同时打开，同一端点 2 秒内共用一次采样

## 安装

推荐经**面板商店**安装：面板 → 面板商店 → 搜索 `hardware` → 安装。

**不是插件市场** —— 那是内核插件的市场，两者的索引与落点都不同。填错地方的表现是「找不到这个
条目」，因为两份索引的顶层键刻意不同名（`panels` 对 `plugins`）。

商店会代跑装后步骤：装完在包目录内执行 `pnpm install`（连 devDependencies），再跑
`pnpm run build`。**这一步不能省** —— 本包的 `webuiPanel.server` 指向 `dist/index.js`，
而 `dist/` 不在 git 里，不编译就只有源码，全部组件取数失败。确认框会把要跑的步骤列出来。

亦可手工克隆至 webui 的面板插件目录下：

```powershell
cd <主目录>\plugins\webui\plugins
git clone https://github.com/Yunzai-NG/hardware-plugin.git hardware
cd hardware
pnpm install
pnpm run build
```

手放这条路没有安装动作可挂，故两步要自己跑。

更新 webui 时，git 安装的面板包会保留，其余文件被暂存；本机没有 git 或卸载 webui 时整目录删除，请保留自己的备份。

装好后到插件页**重载 webui**：本包带 node 侧，它的入口只在 webui 的 `setup()` 里 import
一次，只刷新页面取不到那六条采样路由。

## 开发

本插件依赖 `@yunzai-ng/core` 与 `@yunzai-ng/types`，两者声明为 `peerDependencies`
（运行期由宿主内核提供，插件目录内不应再装一份）。**框架发布至 npm 之前**，需先链接本地
框架 checkout：

```powershell
git clone https://github.com/Yunzai-NG/yunzai-ng.git
cd yunzai-ng
pnpm install
pnpm run build          # 必需：本插件的 tsc 读取框架的 dist/*.d.ts

cd ..\hardware-plugin
pnpm install
pnpm run link:framework # 在 node_modules/@yunzai-ng 下建立指向框架的链接
pnpm run verify         # build → typecheck:test → lint → test
```

`link:framework` 按 `YZNG_FRAMEWORK` 环境变量 → `../yunzai-ng` → `../../yunzai-ng` →
`../../code` 的顺序查找框架仓库。目录布局与上述不同时设置该环境变量即可。

框架发布之后，`pnpm install` 即可满足依赖，该步骤不再必需。

`widgets/` 下的 js 不经构建，也**不能 import 裸包名** —— 浏览器按 URL 解析模块说明符，
`import si from "systeminformation"` 在那里是一条网络错误。要用的能力一概经注入的 `api` 取；
同目录的相对路径（如 `./lib/store.js`）是 URL，故可以引。

## 许可

AGPL-3.0-or-later
