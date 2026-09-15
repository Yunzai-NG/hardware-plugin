/**
 * 模块职责：探测整机的 CPU / 内存 / 显卡占用，以及一次性的硬件型号
 * 依赖方向：只依赖 node 内置模块、`@yunzai-ng/core` 的公开入口与 `systeminformation`；
 *          不认识 HTTP，也不认识面板
 * 生命周期：状态全在 `HardwareSampler` 实例里，随插件 setup 建立一份
 * 注意事项：这里给的是**整机**，内核那套是本进程，两者并存，故面板上必须写明口径 ——
 *          否则使用者只会看到「两个 CPU 占用不是一个数」。五个决定：
 *          1) 型号与占用分开探、型号只探一次：`si.cpu()` 2131ms、`si.graphics()` 2250ms 且都不缓存，
 *             而面板按 5 秒轮询。首次请求不等它探完，型号在下一轮出现
 *          2) 整机 CPU 用 `os.cpus()` 的时间累计量作差而非 `si.currentLoad()`（后者 511ms 且每次起子进程）。
 *             代价是要两次采样才有第一个数，故首次**不返回该字段**而非记 0 —— 0 会被读成「机器闲着」
 *          3) 整机内存用 `totalmem() - freemem()`，与任务管理器同源；`si.mem()` 的 `active` 各平台含义不一
 *          4) 显卡两路合并：占用率复用内核已公开的 `probeGpus()`，**不自己再写一份 CSV 解析**（两份迟早
 *             给出两个数）。有 N 卡时丢掉型号表里的 N 卡条目免得同一块卡出现两次；虚拟显示器按名字排掉
 *             （启发式，PCI 总线号更准但 `bus` 在 Linux 上常为空）
 *          5) `systeminformation` 静态 import：它是本插件的依赖而非内核的，改成动态换不来任何取舍空间
 */
import { cpus, freemem, totalmem } from "node:os"
import { probeGpus } from "@yunzai-ng/core"
import si from "systeminformation"

/**
 * 快照缓存生存期
 *
 * 取 4 秒而非 5 秒，理由同内核 `platform/system.ts`：面板按 5 秒轮询，缓存若与轮询
 * 同为 5 秒，两个周期的相位差会让每隔几次出现一次「这次读的是上一次的数」。
 */
const CACHE_MS = 4000

/**
 * 型号表里按名字排掉的东西
 *
 * 都不是真显卡，或是真显卡但给不出任何可显示的信息：
 * - `virtual` / `idd` / `usbmmidd`：各类虚拟显示器驱动
 * - `todesk` / `gameviewer` / `parsec` / `sunshine` / `oray`：远程串流软件装的虚拟屏
 * - `basic display`：Windows 未装驱动时的兜底适配器
 * - `mirror`：老式镜像驱动
 */
const FAKE_GPU_HINTS = [
  "virtual",
  "usbmmidd",
  "iddsample",
  "todesk",
  "gameviewer",
  "parsec",
  "sunshine",
  "oray",
  "basic display",
  "mirror driver"
]

/** 判定为 N 卡的名字特征，用于合并时去重 */
const NVIDIA_HINTS = ["nvidia", "geforce", "quadro", "tesla", "rtx ", "gtx "]

/**
 * 一个核心的时间累计量，即 `os.cpus()[i].times`
 *
 * 单列一个类型而不直接用 `os.CpuInfo`：`cpuTimes` 只看 `times` 这一个字段，而
 * `CpuInfo` 还要求 `model` 与 `speed` —— 那两个字段会让每条用例的夹具多两行噪声。
 */
export interface CpuTimeBuckets {
  /** 用户态 */
  readonly user: number
  /** 低优先级用户态 */
  readonly nice: number
  /** 内核态 */
  readonly sys: number
  /** 空闲 */
  readonly idle: number
  /** 中断处理 */
  readonly irq: number
}

/** `os.cpus()` 的时间累计量之和，单位毫秒 */
export interface CpuTimes {
  /** 空闲状态的累计 */
  readonly idle: number
  /** 全部状态的累计 */
  readonly total: number
}

/** 一块显卡的型号信息，即 `si.graphics()` 里可用的那部分 */
export interface GpuModel {
  /** 型号名 */
  readonly name: string
  /** 显存总量（字节）；集显与虚拟显示器上常为 0 */
  readonly memoryTotal?: number
}

/** 一块显卡在面板上呈现所需的全部数据 */
export interface GpuCard {
  /** 型号名 */
  readonly name: string
  /** 占用率（0-1）；取不到时不出现，**不是 0** */
  readonly load?: number
  /** 显存已用（字节） */
  readonly memoryUsed?: number
  /** 显存总量（字节） */
  readonly memoryTotal?: number
}

/** 整机内存占用 */
export interface MemoryInfo {
  /** 物理内存总量（字节） */
  readonly total: number
  /** 已用（字节） */
  readonly used: number
  /** 可用（字节） */
  readonly free: number
  /**
   * 缓冲区与页面缓存（字节）；取不到时不出现
   *
   * 单列一项是为了解释 `used` 为何常与别的工具对不上：这部分随时可回收，`available`
   * 已把它算作可用，而 `top` 的「已用」把它算在内。写出来，那个差额就有了名字。
   */
  readonly cached?: number
}

/**
 * 交换空间占用
 *
 * 总量为 0 时整个字段不出现，而不是给一份 `0 / 0`：关掉交换是正常配置，而「SWAP 0%」
 * 会被读成「很空闲」。组件据此隐去自己。
 */
export interface SwapInfo {
  /** 交换空间总量（字节） */
  readonly total: number
  /** 已用（字节） */
  readonly used: number
  /** 可用（字节） */
  readonly free: number
}

/** 一次运行里不会变的硬件型号 */
export interface HardwareModels {
  /** CPU 型号，如 `Ultra 9 285H` */
  readonly cpu?: string
  /** 逻辑核数 */
  readonly cores?: number
  /** 物理核数 */
  readonly physicalCores?: number
  /** 内存规格，如 `DDR5` */
  readonly memoryType?: string
  /** 内存频率（MHz） */
  readonly memoryClock?: number
}

/**
 * `hardware` 端点的响应
 *
 * 只装「每台机器都要、且取数便宜」的那几样：磁盘、进程、Redis、网络、系统信息各自另开端点。
 * 取数代价差两个数量级（这里的 CPU 是纯内存读取，`si.processes()` 要遍历整张进程表），
 * 并成一份会让一个没人在看的进程表也每 5 秒被采一次。
 */
export interface HardwareInfo {
  /** 整机 CPU 占用（0-1）；首次采样时不出现，见文件头第 2 条 */
  readonly cpu?: number
  /**
   * 各逻辑核各自的占用（0-1），顺序同 `os.cpus()`
   *
   * 与 `cpu` 同一份采样算出，故不多花任何代价。给它是因为整机那一个数会把
   * 「一个线程吃满、其余闲着」与「所有核都在半忙」显示成同一个值 —— 前者是某个
   * 单线程任务卡住了，后者是机器真的在干活，而这两件事的处置完全不同。
   */
  readonly cores?: readonly number[]
  /** 整机内存占用 */
  readonly memory: MemoryInfo
  /** 交换空间占用；没有交换空间时不出现（总量为 0）而非给一个 0/0，见 `sampleSwap` */
  readonly swap?: SwapInfo
  /** 各显卡；一块都认不出时为空数组 */
  readonly gpus: readonly GpuCard[]
  /** 硬件型号；尚未探完时不出现，见文件头第 1 条 */
  readonly models?: HardwareModels
  /** CPU 温度；取不到时不出现，见 `tempOf` */
  readonly temperature?: TempInfo
  /** CPU 实时频率（MHz）；取不到时不出现 */
  readonly clock?: number
  /** 电池；没有电池的机器上不出现，见 `batteryOf` */
  readonly battery?: BatteryInfo
}

/**
 * CPU 温度
 *
 * **取不到时整项不出现，不记 0。** 台式机、虚拟机与多数容器里读不到温度传感器，
 * 而「0 ℃」会被读成「凉得出奇」。`si` 在这些机器上给的是 `null` 或 `-1`，两者都要挡掉。
 */
export interface TempInfo {
  /** 主传感器读数（摄氏度） */
  readonly main: number
  /** 各核读数；给不出时不出现 */
  readonly cores?: readonly number[]
  /** 厂商标称的临界温度；给不出时不出现 */
  readonly max?: number
}

/**
 * 电池
 *
 * **没有电池的机器上整项不出现。** 台式机与服务器占了部署的多数，给一枚恒为
 * 「0%、未充电」的电池卡片是错的 —— `si.battery()` 在那些机器上照样返回一个对象，
 * 故判据是它的 `hasBattery` 而非「有没有拿到数据」。
 */
export interface BatteryInfo {
  /** 剩余电量（0-1） */
  readonly level: number
  /** 是否正在充电 */
  readonly charging: boolean
  /** 剩余可用时间（分钟）；充电中或算不出时不出现 */
  readonly minutesLeft?: number
}

/** 出错时的告知方式，由调用方接到 `ctx.logger` 上 */
export type ProbeWarn = (message: string, err: unknown) => void

/**
 * 汇总 `os.cpus()` 的时间累计量
 *
 * 这些数是自开机以来的累计值，单次读取毫无意义 —— 必须与上一次相减，见 `cpuLoad`。
 * @param list `os.cpus()` 的返回值，或任何只带 `times` 的等价物
 * @returns 全部核心的空闲与总计累计量
 */
export function cpuTimes(list: readonly { readonly times: CpuTimeBuckets }[]): CpuTimes {
  let idle = 0
  let total = 0
  for (const core of list) {
    const t = core.times
    idle += t.idle
    total += t.user + t.nice + t.sys + t.idle + t.irq
  }
  return { idle, total }
}

/**
 * 由两个采样点算出这段时间里的 CPU 占用
 *
 * 没有上一个采样点时返回 undefined 而非 0，见文件头第 2 条。总计量没有前进也返回
 * undefined：两次采样落在同一毫秒内，或系统时间被回拨，都会这样，此时算出来的比例
 * 是个噪声。
 * @param prev 上一个采样点，首次为 undefined
 * @param next 本次采样点
 * @returns 占用率（0-1）；算不出时 undefined
 */
export function cpuLoad(prev: CpuTimes | undefined, next: CpuTimes): number | undefined {
  if (prev === undefined) return undefined
  const span = next.total - prev.total
  if (!Number.isFinite(span) || span <= 0) return undefined
  const idleSpan = Math.max(next.idle - prev.idle, 0)
  return Math.min(1, Math.max(0, 1 - idleSpan / span))
}

/**
 * 逐核汇总时间累计量
 *
 * 与 `cpuTimes` 同一算式，只是不相加 —— 整机那个数就是这些的合计，故两者必然自洽。
 * @param list `os.cpus()` 的返回值
 * @returns 各核的累计量，顺序同入参
 */
export function perCoreTimes(list: readonly { readonly times: CpuTimeBuckets }[]): CpuTimes[] {
  return list.map(core => cpuTimes([core]))
}

/**
 * 由两批采样点算出各核占用
 *
 * **核数变了就整批不给。** 热插拔 CPU、容器被改了 cpuset 都会让两批长度不同，此时按
 * 下标配对得到的是「拿 3 号核的新值减 5 号核的旧值」—— 那种数看起来是真的，却毫无意义。
 * @param prev 上一批采样点，首次为 undefined
 * @param next 本批采样点
 * @returns 各核占用（0-1）；算不出时 undefined
 */
export function perCoreLoad(
  prev: readonly CpuTimes[] | undefined,
  next: readonly CpuTimes[]
): number[] | undefined {
  if (prev === undefined || prev.length !== next.length || next.length === 0) return undefined
  const out: number[] = []
  for (const [i, one] of next.entries()) {
    const load = cpuLoad(prev[i], one)
    // 某一核算不出就整批不给：一个缺口会让下标与核号错位，而条形图是按下标画的
    if (load === undefined) return undefined
    out.push(load)
  }
  return out
}

/**
 * 把 `si.cpuTemperature()` 的返回值整理成温度项
 *
 * **`0` 与 `-1` 都当作「读不到」。** 前者是 `si` 在拿不到传感器时的填充值，后者是它
 * 在部分平台上的表示；照收的话卡片上会出现「0 ℃」，而那会被读成「凉得出奇」。一个真在
 * 运转的 CPU 不可能是 0 ℃，故这条判断不会误伤真实读数。
 * @param raw `si.cpuTemperature()` 的返回值；取不到时为 undefined
 * @returns 温度；读不到时 undefined
 */
export function tempOf(
  raw:
    | {
        readonly main?: number | null
        readonly cores?: readonly (number | null)[] | null
        readonly max?: number | null
      }
    | undefined
): TempInfo | undefined {
  /**
   * 一个温度读数是否可用
   * @param value 读数
   * @returns 是否可用
   */
  const usable = (value: unknown): value is number => {
    const num = Number(value)
    return Number.isFinite(num) && num > 0
  }

  const main = Number(raw?.main)
  if (!usable(main)) return undefined

  const cores = (raw?.cores ?? []).filter(usable)
  const max = Number(raw?.max)
  return {
    main,
    ...(cores.length > 0 ? { cores } : {}),
    ...(usable(max) ? { max } : {})
  }
}

/**
 * 把 `si.cpuCurrentSpeed()` 的返回值整理成频率（MHz）
 *
 * `si` 给的是 GHz，面板上其余频率（内存那一项）用的是 MHz，故在此换算成同一单位 ——
 * 一张卡上两个频率各用一套单位，使用者要先看清后缀才能比较。
 * @param raw `si.cpuCurrentSpeed()` 的返回值；取不到时为 undefined
 * @returns 频率（MHz）；取不到时 undefined
 */
export function clockOf(raw: { readonly avg?: number | null } | undefined): number | undefined {
  const ghz = Number(raw?.avg)
  if (!Number.isFinite(ghz) || ghz <= 0) return undefined
  return Math.round(ghz * 1000)
}

/**
 * 把 `si.battery()` 的返回值整理成电池项
 *
 * **判据是 `hasBattery`，不是「有没有拿到数据」。** 台式机上这个调用照样成功，只是
 * `hasBattery: false` 且各项为 0 —— 照收会让服务器上多出一枚恒为「0%、未充电」的卡片。
 * @param raw `si.battery()` 的返回值；取不到时为 undefined
 * @returns 电池；没有电池时 undefined
 */
export function batteryOf(
  raw:
    | {
        readonly hasBattery?: boolean
        readonly percent?: number | null
        readonly isCharging?: boolean
        readonly timeRemaining?: number | null
      }
    | undefined
): BatteryInfo | undefined {
  if (raw?.hasBattery !== true) return undefined

  const percent = Number(raw.percent)
  const minutes = Number(raw.timeRemaining)
  return {
    // 电量夹在 0-1：`si` 偶尔给出 101（校准偏差），而一枚超过满圈的环画不出来
    level: Number.isFinite(percent) ? Math.min(Math.max(percent / 100, 0), 1) : 0,
    charging: raw.isCharging === true,
    // 充电中时 `timeRemaining` 是「充满还要多久」而非「还能用多久」，语义不同故不给
    ...(raw.isCharging !== true && Number.isFinite(minutes) && minutes > 0
      ? { minutesLeft: Math.round(minutes) }
      : {})
  }
}

/**
 * 这个名字看起来是不是虚拟显示器
 *
 * 启发式，见文件头第 4 条。
 * @param name 型号名
 * @returns 是否应从型号表里排掉
 */
export function looksFakeGpu(name: string): boolean {
  const lower = name.toLowerCase()
  return FAKE_GPU_HINTS.some(hint => lower.includes(hint))
}

/**
 * 这个名字看起来是不是 N 卡
 *
 * 仅用于「nvidia-smi 已经报过这块卡，型号表里的同一条要丢掉」这一处去重。
 * @param name 型号名
 * @returns 是否为 N 卡
 */
export function looksNvidia(name: string): boolean {
  const lower = name.toLowerCase()
  return NVIDIA_HINTS.some(hint => lower.includes(hint))
}

/**
 * 两个显卡名是否指同一块卡
 *
 * nvidia-smi 报 `NVIDIA GeForce RTX 4090`，而 `si.graphics()` 可能报同一串、也可能只报
 * `RTX 4090`，故做包含式比较而非精确相等 —— 精确比较会让两路永远配不上，表现为同一块卡
 * 在列表里出现两次。
 * @param a 名字一
 * @param b 名字二
 * @returns 是否认为是同一块
 */
export function namesMatch(a: string, b: string): boolean {
  const x = a.toLowerCase().trim()
  const y = b.toLowerCase().trim()
  if (x === "" || y === "") return false
  return x.includes(y) || y.includes(x)
}

/**
 * 合并两路显卡信息
 *
 * nvidia-smi 那一路带占用率，全部保留并排在前；型号表那一路只有型号与标称显存。
 * 见文件头第 4 条。
 *
 * **两路先按名字配对**（`namesMatch`），配上的把型号表里的标称显存补给测到的那条 ——
 * nvidia-smi 在虚拟化环境里常把显存报成 `[N/A]`，而 `si.graphics()` 的 `vram` 还在。
 * 此前只按 `looksNvidia` 整条丢弃，那个数便跟着丢了。
 *
 * 配不上的型号条目仍照旧处置：排掉虚拟显示器，且 nvidia-smi 有结果时排掉其中的 N 卡 ——
 * 那是名字比对失败时的兜底，少了它同一块卡会两现。
 * @param models `si.graphics()` 给出的型号表；尚未探到时为 undefined
 * @param measured nvidia-smi 量到的显卡；测不到时为 undefined
 * @returns 合并后的显卡列表；两路都空时为空数组
 */
export function mergeGpus(
  models: readonly GpuModel[] | undefined,
  measured: readonly GpuCard[] | undefined
): GpuCard[] {
  /** 已被某条测量结果认领的型号条目，不再单独列出 */
  const claimed = new Set<GpuModel>()

  const merged: GpuCard[] = (measured ?? []).map(card => {
    const model = (models ?? []).find(item => !claimed.has(item) && namesMatch(item.name, card.name))
    if (model !== undefined) claimed.add(model)
    // 测到的那条为准，只补它缺的标称显存 —— 占用率与显存已用只有 nvidia-smi 给得出
    return card.memoryTotal !== undefined || model?.memoryTotal === undefined
      ? card
      : { ...card, memoryTotal: model.memoryTotal }
  })

  const hasNvidia = merged.length > 0
  for (const model of models ?? []) {
    if (claimed.has(model)) continue
    if (looksFakeGpu(model.name)) continue
    if (hasNvidia && looksNvidia(model.name)) continue
    merged.push({
      name: model.name,
      ...(model.memoryTotal === undefined || model.memoryTotal <= 0
        ? {}
        : { memoryTotal: model.memoryTotal })
    })
  }
  return merged
}

/**
 * 读一份整机内存占用
 *
 * **优先用 `si.mem()` 的 `available`，`freemem()` 只作兜底。** 这是本函数唯一的要点：
 * Linux 的 `freemem()` 答的是「完全没被碰过的页」，而页面缓存与 slab 不在其中 ——
 * 那些是随时可回收的。于是一台真正空闲的 Linux 机器会显示 80% 占用，而 `free -h` 的
 * available 说还有一大半可用。`available` 正是内核自己算出的「不触发换页就能给出多少」，
 * 与 `free -h` 同源，也与 Windows 上任务管理器的口径一致（那里两者本就接近）。
 *
 * 兜底仍是 `totalmem() - freemem()`：`si.mem()` 取不到时（它在少数平台上会失败）
 * 有个偏高的数仍胜过没有这一格。偏高与缺失比起来，前者仍指得出「内存在涨」这件事。
 * @param mem `si.mem()` 的返回值；取不到时为 undefined
 * @returns 内存占用
 */
export function sampleMemory(
  mem?: { readonly total?: number; readonly available?: number; readonly buffcache?: number }
): MemoryInfo {
  // 总量以 `si` 那份为准（它与 available 同源），取不到才用 os 的
  const siTotal = Number(mem?.total)
  const total = Number.isFinite(siTotal) && siTotal > 0 ? siTotal : totalmem()

  const available = Number(mem?.available)
  const free = Number.isFinite(available) && available >= 0 ? available : freemem()
  const capped = Math.min(Math.max(free, 0), total)

  const cached = Number(mem?.buffcache)
  return {
    total,
    used: total - capped,
    free: capped,
    // 0 也照给：Windows 上这个数确实可能是 0，而「有这一项且为 0」与「没有这一项」
    // 在组件里是两种画法（后者整行不出现）
    ...(Number.isFinite(cached) && cached >= 0 ? { cached } : {})
  }
}

/**
 * 由 `si.mem()` 取出交换空间占用
 *
 * **交换空间只能靠 `si.mem()`**，`node:os` 不给这个数 —— 这是 SWAP 与物理内存
 * 取值口径不同的唯一原因（后者用 `totalmem() - freemem()`，与任务管理器同源）。
 *
 * **总量为 0 时本函数返回 undefined，而不是一条 0% 的槽。** 未配置交换空间是常态
 * （容器里、以及刻意关掉 swap 的机器），画一条恒为 0% 的槽会被读成「交换空间没在用」，
 * 而真相是「这台机器没有交换空间」—— 后者该让这一条整个不出现。
 * @param mem `si.mem()` 的返回值；取不到时为 undefined
 * @returns 交换空间占用；未配置或取不到时 undefined
 */
export function swapOf(
  mem: { readonly swaptotal?: number; readonly swapused?: number } | undefined
): MemoryInfo | undefined {
  const total = Number(mem?.swaptotal)
  if (!Number.isFinite(total) || total <= 0) return undefined
  const used = Number(mem?.swapused)
  const capped = Math.min(Math.max(Number.isFinite(used) ? used : 0, 0), total)
  return { total, used: capped, free: total - capped }
}

/**
 * 整机硬件采样器
 *
 * 持有三样状态：上一个 CPU 采样点、探过一次的型号、以及一份短命快照缓存。做成类而非
 * 模块级变量，是为了让用例能各自拿一个干净实例 —— 模块级状态会让「首次采样不给 CPU」
 * 这条用例被前一条用例留下的采样点弄假。
 */
export class HardwareSampler {
  /** 上一个 CPU 采样点 */
  #prev: CpuTimes | undefined

  /** 上一批逐核采样点，与 `#prev` 同一时刻取 */
  #prevCores: readonly CpuTimes[] | undefined

  /** 探到的型号；尚未探完时 undefined */
  #models: HardwareModels | undefined

  /** 探到的显卡型号表；尚未探完时 undefined */
  #gpuModels: readonly GpuModel[] | undefined

  /** 型号探测是否正在进行，避免五秒一轮的请求各起一次 */
  #probing = false

  /** 短命快照缓存 */
  #cache: { at: number; value: HardwareInfo } | undefined

  /** 出错时的告知方式 */
  readonly #warn: ProbeWarn

  /**
   * @param warn 出错时的告知方式，缺省为静默
   */
  constructor(warn?: ProbeWarn) {
    this.#warn = warn ?? ((): void => {})
  }

  /**
   * 探一次硬件型号并记住
   *
   * 三个 `si` 调用并发：彼此无关，串行只是把耗时相加。任一项失败只让该项缺失，
   * 不影响其余 —— Termux 上 `memLayout()` 取不到东西是常态。
   * @returns 探完即结束
   */
  async probeModels(): Promise<void> {
    if (this.#probing) return
    this.#probing = true
    try {
      const [cpu, mem, gfx] = await Promise.all([
        si.cpu().catch((err: unknown) => {
          this.#warn("探测 CPU 型号失败", err)
          return undefined
        }),
        si.memLayout().catch((err: unknown) => {
          this.#warn("探测内存规格失败", err)
          return undefined
        }),
        si.graphics().catch((err: unknown) => {
          this.#warn("探测显卡型号失败", err)
          return undefined
        })
      ])

      // 内存条可能插了多根，规格取第一根 —— 混插不同规格的机器上这个数会不准，
      // 但把「DDR4 + DDR5」这种情况完整呈现出来需要一整个列表，不值得
      const stick = mem?.find(item => Number(item.size) > 0)

      const models: HardwareModels = {
        ...(cpu?.brand === undefined || cpu.brand === "" ? {} : { cpu: cpu.brand }),
        ...(typeof cpu?.cores === "number" && cpu.cores > 0 ? { cores: cpu.cores } : {}),
        ...(typeof cpu?.physicalCores === "number" && cpu.physicalCores > 0
          ? { physicalCores: cpu.physicalCores }
          : {}),
        ...(stick?.type === undefined || stick.type === "" ? {} : { memoryType: stick.type }),
        ...(typeof stick?.clockSpeed === "number" && stick.clockSpeed > 0
          ? { memoryClock: stick.clockSpeed }
          : {})
      }
      this.#models = models

      // `vram` 的单位是 MB；给 0 或负数的那些留给 mergeGpus 里的判断去掉
      this.#gpuModels = (gfx?.controllers ?? [])
        .map(item => ({
          name: item.model ?? "",
          ...(typeof item.vram === "number" && item.vram > 0
            ? { memoryTotal: item.vram * 1024 * 1024 }
            : {})
        }))
        .filter(item => item.name !== "")
    } catch (err) {
      // Promise.all 本身不会抛（每个都带了 catch），这里兜住的是构造对象时的意外
      this.#warn("探测硬件型号失败", err)
    } finally {
      this.#probing = false
    }
  }

  /**
   * 采一份整机快照
   *
   * 型号未探过时**就地发起**探测但不等它 —— 首次请求照常返回，型号在下一轮出现，
   * 见文件头第 1 条。
   * @param force 是否绕过缓存，仅测试用
   * @returns 整机快照
   */
  async sample(force = false): Promise<HardwareInfo> {
    const now = Date.now()
    if (!force && this.#cache !== undefined && now - this.#cache.at < CACHE_MS) {
      return this.#cache.value
    }

    if (this.#models === undefined && !this.#probing) {
      // 刻意不 await：这一趟要 2 秒以上，而面板正等着第一份数据
      void this.probeModels()
    }

    // 整机与逐核取自同一次 `os.cpus()`：分两次读会让「各核之和」与整机那个数对不上
    const cores = cpus()
    const next = cpuTimes(cores)
    const nextCores = perCoreTimes(cores)
    const load = cpuLoad(this.#prev, next)
    const perCore = perCoreLoad(this.#prevCores, nextCores)
    this.#prev = next
    this.#prevCores = nextCores

    /*
     * 五路 `si` 并发取
     *
     * 彼此互不相关，串行只是把耗时相加。各自带 catch：一台读不到温度传感器的机器
     * （虚拟机、多数容器）仍该看得见显卡与内存，反之亦然。
     *
     * `si.mem()` 供两处用：交换空间（`node:os` 不给这个数）与物理内存的 `available`
     * （见 `sampleMemory`）。它失败时后者退回 `freemem()`，前者整个不出现。
     *
     * 温度、频率与电池**各自可缺**，这正是它们能进这份快照的前提 —— 三者都是纯读取
     * （Linux 读 sysfs、Windows 走 WMI），与 `si.processes()` 那种要遍历整张进程表的
     * 调用不是一个量级，故不必另开端点。
     */
    const [measured, mem, temp, speed, battery] = await Promise.all([
      probeGpus().catch((err: unknown) => {
        this.#warn("探测显卡占用失败", err)
        return undefined
      }),
      si.mem().catch((err: unknown) => {
        this.#warn("探测内存与交换空间失败", err)
        return undefined
      }),
      si.cpuTemperature().catch((err: unknown) => {
        this.#warn("探测 CPU 温度失败", err)
        return undefined
      }),
      si.cpuCurrentSpeed().catch((err: unknown) => {
        this.#warn("探测 CPU 频率失败", err)
        return undefined
      }),
      si.battery().catch((err: unknown) => {
        this.#warn("探测电池失败", err)
        return undefined
      })
    ])

    const swap = swapOf(mem)
    const temperature = tempOf(temp)
    const clock = clockOf(speed)
    const power = batteryOf(battery)

    const value: HardwareInfo = {
      ...(load === undefined ? {} : { cpu: load }),
      ...(perCore === undefined ? {} : { cores: perCore }),
      memory: sampleMemory(mem),
      ...(swap === undefined ? {} : { swap }),
      gpus: mergeGpus(this.#gpuModels, measured),
      ...(this.#models === undefined ? {} : { models: this.#models }),
      ...(temperature === undefined ? {} : { temperature }),
      ...(clock === undefined ? {} : { clock }),
      ...(power === undefined ? {} : { battery: power })
    }
    this.#cache = { at: now, value }
    return value
  }
}
