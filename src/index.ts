/**
 * 模块职责：面板插件包的 node 侧入口 —— 注册整机硬件占用的查询端点
 * 依赖方向：只依赖本目录的 probe；**不再 import `@yunzai-ng/core` 的 definePlugin**
 * 生命周期：`setup` 由 webui 在其 setup 期间调用一次；采样器随之建立，无需清理
 * 注意事项：本插件是「面板插件包」而非内核插件：webui 扫到它、`import()` 其 node 侧入口并调
 *          `setup(ctx)`，故没有 `definePlugin`，拿到的是只有 `name` / `dir` / `dataDir` / `logger` /
 *          `route` / `config` 六项的受限上下文。
 *
 *          配置声明写在 package.json 的 `webuiPanel.config` 里：webui 读它、渲染表单、存值、填默认值，
 *          本包只管取用（`ctx.config()`），取值处一律带兜底。
 *
 *          路由路径相对本包，完整地址由 webui 拼好经清单交给浏览器侧，故 js 那半用 `api.own("hardware")`
 *          而不自拼前缀 —— 两处各拼一遍会漂移，表现为接口一齐 404。
 *
 *          端点照常鉴权：整机负载是这台机器的运行状况。反过来，浏览器侧那些 js 是不鉴权的静态资源
 *          （`import()` 设不了请求头），故**那些文件里不可写入任何令牌或密钥**。
 *
 *          `setup` 不抛错：webui 逐个 try 每个包，抛错会让整个包失效，而「端点没注册上」只该少几个格子。
 */
import { DiskSampler } from "./disks.js"
import { NetSampler } from "./net.js"
import type { ProbeTarget } from "./net.js"
import { HardwareSampler } from "./probe.js"
import { sampleProcesses } from "./processes.js"
import { DEFAULT_HOST, DEFAULT_PORT, sampleRedis } from "./redis.js"
import { SysInfoSampler } from "./sysinfo.js"

export {
  HardwareSampler,
  batteryOf,
  clockOf,
  cpuLoad,
  cpuTimes,
  looksFakeGpu,
  looksNvidia,
  mergeGpus,
  namesMatch,
  perCoreLoad,
  perCoreTimes,
  sampleMemory,
  swapOf,
  tempOf
} from "./probe.js"
export type {
  BatteryInfo,
  CpuTimeBuckets,
  CpuTimes,
  GpuCard,
  GpuModel,
  HardwareInfo,
  HardwareModels,
  MemoryInfo,
  ProbeWarn,
  SwapInfo,
  TempInfo
} from "./probe.js"
export { DiskSampler, ioRates, toIoCounters, toPartitions } from "./disks.js"
export type { DiskInfo, DiskIoCounters, DiskIoRates, DiskPartition } from "./disks.js"
export { sampleProcesses, toProcesses } from "./processes.js"
export type { ProcessEntry, ProcessInfo } from "./processes.js"
export { PLATFORM, SysInfoSampler, kernelOf, toAddresses } from "./sysinfo.js"
export type { LocalAddress, SysInfo } from "./sysinfo.js"
export {
  DEFAULT_HOST,
  DEFAULT_PORT,
  countDatabases,
  countKeys,
  fetchInfo,
  hitRateOf,
  parseInfo,
  sampleRedis,
  toRedisInfo
} from "./redis.js"
export type { RedisInfo } from "./redis.js"
export { NetSampler, netRates, pickUsed, probeOne, toNetCounters } from "./net.js"
export type { NetCounters, NetInfo, NetRates, ProbeResult, ProbeTarget } from "./net.js"

/**
 * 六条查询端点相对本包的路径
 *
 * **一类采样一条路由，不并成一个大响应。** 合成一条看似省事（浏览器侧一次请求就够），
 * 代价是最慢的那一类决定全部：Redis 连不上要等一个 TCP 超时，`si.processes()` 在进程多的
 * 机器上要几百毫秒，而使用者可能只摆了一枚内存条。分开之后，没上板的组件根本不发请求 ——
 * 那是「组件化」本身的要求：一枚组件的开销应当只在它出现时才付。
 *
 * 代价写明：摆满六类时是每拍六次 HTTP，而不是一次。这在本地回环上无关紧要，
 * 且浏览器对同源连接的复用使其只是六个请求、不是六次握手。
 */
export const HARDWARE_PATH = "hardware"

/** 磁盘分区与读写速率 */
export const DISKS_PATH = "disks"

/** 进程表 */
export const PROCESSES_PATH = "processes"

/** neofetch 式系统信息清单 */
export const SYSINFO_PATH = "sysinfo"

/** Redis 状态 */
export const REDIS_PATH = "redis"

/** 网卡速率与对外探测 */
export const NET_PATH = "net"

/** webui 给面板插件包 node 侧的受限上下文，与 `panelserver.ts` 的 `PanelServerContext` 同形 */
export interface HardwareContext {
  /** 包名 */
  readonly name: string
  /** 包目录绝对路径 */
  readonly dir: string
  /** webui 的数据目录 */
  readonly dataDir: string
  /** 日志器，前缀已带包名 */
  readonly logger: {
    /**
     * 记一条警告
     * @param msg 内容
     */
    warn(msg: string): void
    /**
     * 记一条错误
     * @param msg 内容
     */
    error(msg: string): void
    /**
     * 记一条调试信息
     * @param msg 内容
     */
    debug(msg: string): void
  }
  /**
   * 注册一条 GET 路由，落在本包自己的前缀之下
   * @param path 相对本包的路径
   * @param handler 处理函数，返回值即响应体
   */
  route(path: string, handler: () => unknown): void
  /**
   * 取本包当前的配置值
   *
   * **每次要用时都调一次，不要在 `setup` 里取一次存起来。** 使用者在面板上改了配置之后，
   * webui 更新的是它那份缓存，存下来的对象不会跟着变 —— 表现为「改了配置，重启前一直不生效」。
   * @returns 当前配置值，已按声明填过默认值、查过类型
   */
  config<T = Record<string, unknown>>(): T
}

/**
 * 本包的配置形状，与 package.json 里 `webuiPanel.config` 的声明一一对应
 *
 * **每一项都是可选的，且取值处一律带兜底。** webui 保证类型（声明为 number 的一定是
 * number），但不保证字段一定在 —— 一个手改过的配置文件、或一个刚更新过的声明都可能少一项。
 * 而这里少一项的后果是「连了个 undefined:6379」，那个错在日志里看起来像网络问题。
 */
export interface HardwareConfig {
  /** Redis 连接地址与鉴权 */
  readonly redis?: {
    /** 主机 */
    readonly host?: string
    /** 端口 */
    readonly port?: number
    /** 密码；留空即不鉴权 */
    readonly password?: string
    /** 用户名，Redis 6 起的 ACL 才有；留空按 `AUTH <密码>` 的老形式发 */
    readonly username?: string
  }
  /** 对外探测目标：名字 → 地址 */
  readonly probes?: Record<string, string>
}

/**
 * 把配置里那份「名字 → 地址」整理成探测目标
 *
 * **地址为空的条目丢掉。** 键值对控件里新增一行时键与值都是空的，若原样交给探测，
 * 每一拍都会去请求一个空地址并在卡片上留一行「失败」—— 而使用者只是还没填完。
 * @param probes 配置里的那份键值对
 * @returns 探测目标
 */
export function toProbeTargets(probes: Record<string, string> | undefined): ProbeTarget[] {
  const out: ProbeTarget[] = []
  for (const [name, url] of Object.entries(probes ?? {})) {
    if (name.trim() === "" || typeof url !== "string" || url.trim() === "") continue
    out.push({ name: name.trim(), url: url.trim() })
  }
  return out
}

export default {
  /**
   * 注册本包的 node 侧能力
   * @param ctx 受限上下文
   */
  setup(ctx: HardwareContext): void {
    /**
     * 各采样器共用的告知方式
     * @param message 出错的是什么事
     * @param err 错误本身
     */
    const warn = (message: string, err: unknown): void => {
      ctx.logger.warn(`${message}：${err instanceof Error ? err.message : String(err)}`)
    }

    const hardware = new HardwareSampler(warn)
    const disks = new DiskSampler()
    const sysinfo = new SysInfoSampler()
    const net = new NetSampler()

    ctx.route(HARDWARE_PATH, () => hardware.sample())
    ctx.route(DISKS_PATH, () => disks.sample(warn))
    ctx.route(PROCESSES_PATH, () => sampleProcesses(warn))
    ctx.route(SYSINFO_PATH, () => sysinfo.sample(warn))

    /*
     * Redis 与网络探测按配置采样
     *
     * 两者本就该由使用者说了算（连哪个 Redis、探测哪些地址），这两枚组件先于配置支持落地，
     * 故当时给的是「Redis 取本机默认、探测目标留空」。现在两者都读 `ctx.config()`：
     *
     * - **每一拍都重新取一次配置**，不在 setup 里读一次存起来 —— 使用者改完配置不必重启，
     *   下一拍即生效。这也是 `ctx.config()` 被设计成一次调用而非一份快照的缘由。
     * - Redis 的默认地址仍是 `127.0.0.1:6379`；主机填空等同于取默认值，而非「不采集」——
     *   不想要这一格的人把它从版面上移走即可（它本就 `defaultHidden`），而「连不上」
     *   本身是这一格该说出来的话（见该组件的文件头）。
     * - 探测目标**默认仍为空**，故默认不发任何对外请求：替使用者决定去连某个网站是他没
     *   同意过的事，何况在离网部署上那是一串必然失败的探测。
     */
    ctx.route(REDIS_PATH, () => {
      const redis = ctx.config<HardwareConfig>().redis
      const host = (redis?.host ?? "").trim()
      const password = (redis?.password ?? "").trim()
      const username = (redis?.username ?? "").trim()
      /*
       * 密码与用户名留空即整项不传，而不是传一个空串
       *
       * 空串会让 `fetchInfo` 走 AUTH 那一路、发出 `AUTH ""` —— 一台没设密码的 Redis
       * 会以 `ERR Client sent AUTH, but no password is set` 拒掉，而那台机器本来是连得上的。
       */
      return sampleRedis(host === "" ? DEFAULT_HOST : host, redis?.port ?? DEFAULT_PORT, {
        ...(password === "" ? {} : { password }),
        ...(username === "" ? {} : { username })
      })
    })
    ctx.route(NET_PATH, () => net.sample(warn, toProbeTargets(ctx.config<HardwareConfig>().probes)))

    ctx.logger.debug("整机硬件、磁盘、进程、系统信息、Redis 与网络六个采样端点已注册")
  }
}
