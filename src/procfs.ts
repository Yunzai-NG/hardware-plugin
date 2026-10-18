/**
 * 模块职责：Linux 上直接读 `/proc` 取进程表与网卡累计量，代替 `systeminformation` 的那两路
 * 依赖方向：只依赖 node 内置模块
 * 生命周期：`ProcTable` 持有上一次各进程的 CPU 时间，随采样器同寿
 * 注意事项：**为什么不用 si：** `si.processes()` 在 Linux 上先起一个 `ps`，再起一个 shell 对每个进程
 *          `cat /proc/<pid>/stat` 一次（三百个进程就是三百次 fork），回填结果还用 `indexOf`，O(n²)；
 *          `si.networkStats("*")` 每块网卡起一个 shell 去 cat sysfs，首次还有一串 `execSync` 与同步的
 *          `nmcli`，那几百毫秒里事件循环是卡住的 —— 机器人收不到消息。这里全是异步读文件：
 *          进程表一次 `readdir` 加每进程一次 `readFile`，网卡一次读 `/proc/net/dev`。
 *
 *          读不到（安卓收紧了 `/proc`、容器只挂了一半）时由调用方退回 si，见 `sampleProcesses` 与 `net.ts`。
 *
 *          CPU 时间的单位取 100Hz：内核对用户态公开的 `USER_HZ` 在各主流架构上都固定为 100，
 *          与内核编译时的 `CONFIG_HZ` 无关。
 */
import { readFile, readdir } from "node:fs/promises"
import { memoryUsage } from "node:process"
import { join } from "node:path"

/** `/proc/<pid>/stat` 里 CPU 时间的单位：每秒多少个 */
const USER_HZ = 100

/** 常见的内存页大小；推得的值就近取其一 */
const PAGE_SIZES = [4096, 16_384, 65_536]

/** `/proc/<pid>/stat` 里本模块用到的那几项 */
export interface ProcStat {
  /** 进程名（`comm`，内核截到 15 字节） */
  readonly name: string
  /** 用户态 + 内核态 CPU 时间，单位 1/USER_HZ 秒 */
  readonly ticks: number
  /** 自系统启动起多久开始运行，单位 1/USER_HZ 秒 */
  readonly start: number
  /** 常驻内存页数 */
  readonly rssPages: number
}

/**
 * 解析一行 `/proc/<pid>/stat`
 *
 * **进程名按最后一个右括号切。** `comm` 可以含空格与括号（`(sd-pam)`、`tmux: server`），按空格切会让
 * 其后每一列错位，而错位不报错，只是 CPU 与内存全读成别的数。
 * @param text 文件内容
 * @returns 解析结果；格式不对时 undefined
 */
export function parseProcStat(text: string): ProcStat | undefined {
  const open = text.indexOf("(")
  const close = text.lastIndexOf(")")
  if (open < 0 || close < open) return undefined
  // 右括号之后从第 3 列（state）起，下标 = 列号 - 3
  const rest = text.slice(close + 2).split(" ")
  const utime = Number(rest[11])
  const stime = Number(rest[12])
  const start = Number(rest[19])
  const rssPages = Number(rest[21])
  if (![utime, stime, start, rssPages].every(Number.isFinite)) return undefined
  return { name: text.slice(open + 1, close), ticks: utime + stime, start, rssPages }
}

/**
 * 解析 `/proc/net/dev`，形状对齐 `si.networkStats()` 的那几个字段
 *
 * 前两行是表头；每行是「网卡名: 收字节 收包 … （共 8 列）发字节 …」。
 * @param text 文件内容
 * @returns 各网卡的累计量
 */
export function parseNetDev(text: string): { iface: string; rx_bytes: number; tx_bytes: number }[] {
  const out: { iface: string; rx_bytes: number; tx_bytes: number }[] = []
  for (const line of text.split("\n").slice(2)) {
    const colon = line.indexOf(":")
    if (colon < 0) continue
    const cols = line.slice(colon + 1).trim().split(/\s+/)
    out.push({ iface: line.slice(0, colon).trim(), rx_bytes: Number(cols[0]), tx_bytes: Number(cols[8]) })
  }
  return out
}

/**
 * 读 `/proc/net/dev`
 * @param root proc 的挂载点，仅测试时替换
 * @returns 各网卡的累计量
 */
export async function readNetDev(root = "/proc"): Promise<{ iface: string; rx_bytes: number; tx_bytes: number }[]> {
  return parseNetDev(await readFile(join(root, "net", "dev"), "utf8"))
}

/** `ProcTable.sample()` 的一条，形状对齐 `si.processes().list` 里 `toProcesses` 用到的字段 */
export interface ProcRow {
  /** 进程号 */
  readonly pid: number
  /** 进程名 */
  readonly name: string
  /** 占单核的百分比，与 `ps` 的 `pcpu` 同一口径 */
  readonly pcpu: number
  /** 常驻内存（字节） */
  readonly memRss: number
}

/** 读 `/proc` 的进程表，持有上一次各进程的 CPU 时间以作差 */
export class ProcTable {
  /** proc 的挂载点 */
  readonly #root: string
  /** 上一次各进程的 CPU 时间 */
  #prev = new Map<number, number>()
  /** 上一次采样的时刻（毫秒） */
  #prevAt = 0
  /** 内存页大小，首次采样时推得 */
  #pageSize: number | undefined

  /**
   * @param root proc 的挂载点，仅测试时替换
   */
  constructor(root = "/proc") {
    this.#root = root
  }

  /**
   * 采一份进程表
   *
   * **首次采样的 CPU 取进程一生的平均值**（与 `ps` 的 `pcpu` 同法），之后取两次采样之间那一段。
   * 首次若给 0，表的第一屏会是一列 0% 按内存排的进程，五秒后整张表才换成真实次序。
   *
   * 读一半消失的进程（采样途中退出）直接跳过；它不在下一次的 `#prev` 里，不会累积。
   * @returns 进程列表与总数
   * @throws 读不了 `/proc` 本身时（调用方据此退回 si）
   */
  async sample(): Promise<{ list: ProcRow[]; all: number }> {
    const pids = (await readdir(this.#root)).filter(name => /^\d+$/.test(name))
    const [uptimeText, pageSize] = await Promise.all([readFile(join(this.#root, "uptime"), "utf8"), this.#page()])
    const uptime = Number(uptimeText.split(" ")[0])
    const now = Date.now()
    const span = this.#prevAt === 0 ? 0 : (now - this.#prevAt) / 1000

    const stats = await Promise.all(
      pids.map(pid =>
        readFile(join(this.#root, pid, "stat"), "utf8").then(
          text => [Number(pid), parseProcStat(text)] as const,
          () => [Number(pid), undefined] as const
        )
      )
    )

    const next = new Map<number, number>()
    const list: ProcRow[] = []
    for (const [pid, stat] of stats) {
      if (stat === undefined) continue
      next.set(pid, stat.ticks)
      const was = this.#prev.get(pid)
      let seconds: number
      let used: number
      if (was !== undefined && span > 0) {
        seconds = span
        used = (stat.ticks - was) / USER_HZ
      } else {
        seconds = uptime - stat.start / USER_HZ
        used = stat.ticks / USER_HZ
      }
      const pcpu = seconds > 0 && used > 0 ? (used / seconds) * 100 : 0
      list.push({ pid, name: stat.name, pcpu, memRss: stat.rssPages * pageSize })
    }
    if (list.length === 0) throw new Error(`${this.#root} 下一个进程都读不到`)

    this.#prev = next
    this.#prevAt = now
    return { list, all: list.length }
  }

  /**
   * 内存页大小
   *
   * node 不给 `getpagesize()`，而 ARM64 上 16K、64K 页并不少见（按 4K 算会让内存列小四倍到十六倍）。
   * 故用本进程自己的常驻页数（`/proc/self/statm` 第二列）与 node 报的 RSS 对一下，就近取一个常见值。
   * @returns 页大小（字节）
   */
  async #page(): Promise<number> {
    if (this.#pageSize !== undefined) return this.#pageSize
    let size = PAGE_SIZES[0]!
    try {
      const pages = Number((await readFile(join(this.#root, "self", "statm"), "utf8")).split(" ")[1])
      const guess = memoryUsage.rss() / pages
      if (Number.isFinite(guess) && guess > 0) {
        size = PAGE_SIZES.reduce((best, one) => (Math.abs(one - guess) < Math.abs(best - guess) ? one : best))
      }
    } catch {
      // 读不到就按最常见的 4K
    }
    this.#pageSize = size
    return size
  }
}
