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
  /** 整机内存占用 */
  readonly memory: MemoryInfo
  /** 交换空间占用；没有交换空间时不出现（总量为 0）而非给一个 0/0，见 `sampleSwap` */
  readonly swap?: SwapInfo
  /** 各显卡；一块都认不出时为空数组 */
  readonly gpus: readonly GpuCard[]
  /** 硬件型号；尚未探完时不出现，见文件头第 1 条 */
  readonly models?: HardwareModels
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
 * @returns 内存占用
 */
export function sampleMemory(): MemoryInfo {
  const total = totalmem()
  const free = freemem()
  const capped = Math.min(Math.max(free, 0), total)
  return { total, used: total - capped, free: capped }
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

    const next = cpuTimes(cpus())
    const load = cpuLoad(this.#prev, next)
    this.#prev = next

    /*
     * 显卡占用与 swap 并发取
     *
     * 两者互不相关，串行只是把耗时相加。各自带 catch：一台取不到 swap 的机器
     * （容器里常见）仍该看得见显卡，反之亦然。
     */
    const [measured, mem] = await Promise.all([
      probeGpus().catch((err: unknown) => {
        this.#warn("探测显卡占用失败", err)
        return undefined
      }),
      si.mem().catch((err: unknown) => {
        this.#warn("探测交换空间失败", err)
        return undefined
      })
    ])

    const swap = swapOf(mem)

    const value: HardwareInfo = {
      ...(load === undefined ? {} : { cpu: load }),
      memory: sampleMemory(),
      ...(swap === undefined ? {} : { swap }),
      gpus: mergeGpus(this.#gpuModels, measured),
      ...(this.#models === undefined ? {} : { models: this.#models })
    }
    this.#cache = { at: now, value }
    return value
  }
}
