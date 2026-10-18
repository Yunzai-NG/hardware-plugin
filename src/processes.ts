/**
 * 模块职责：进程表 —— 占用最高的若干个进程
 * 依赖方向：只依赖 `systeminformation` 与 node 的 `os.cpus()`；不认识 HTTP，也不认识面板
 * 生命周期：无状态，每次现采
 * 注意事项：**只给前若干条，不给全表。** 一台普通机器两三百个进程，全量下发是每 5 秒几十 KB 的 JSON，
 *          而卡片装得下十行左右。故在 node 侧截断 —— 在浏览器侧截等于把那几十 KB 传过去再丢掉。
 *
 *          **`si.processes()` 的 `pcpu` 是「占单核的百分比」，不是占全机。** 吃满两核的进程在 16 核机器上
 *          给 200，而整机占用是 12.5%，故须除以核数 —— 不换算的话进程表里的数与同一页上的整机 CPU 环
 *          无从对照，而使用者必然会拿它们相互印证。
 *
 *          **本机器人自己那个进程要标出来。** 打开这张表最常问的是「我的机器人吃了多少」，而 node 进程
 *          在表里与其他 node 进程同名，靠名字分不出，故按 `process.pid` 比对并置标记。
 *
 *          **排序按 CPU 降序，内存作并列时的次序。** 只按 CPU 排会让一批 0% 的进程以随机次序出现在表尾、
 *          每 5 秒抖动一次 —— 那种抖动看起来像数据在乱跳。
 *
 *          **不给「结束进程」之类的动作。** 这是只读组件；一个能杀进程的后台页面是另一个量级的东西
 *          （要确认、要审计、要权限），不该顺手做出来。
 */
import { cpus } from "node:os"
import si from "systeminformation"
import type { ProcTable } from "./procfs.js"

/**
 * 表里最多给几条
 *
 * **8 条是按卡片装得下多少行定的，不是随手取的整数。** 实测一行连内边距约 37px
 * （带「本机器人」药丸的那一行更高），加卡片标题与底部小字约 82px；默认 h=5 给
 * 464px（5 × 80 行高 + 4 × 16 间隙），故装得下 9 行 —— 8 条加上必然补进来的本进程
 * 那一条，恰好是 9。
 *
 * 初版取 12，于是默认尺寸下溢出 102px、卡片自带一条滚动条。**默认布局不该需要滚动**
 * （同一条原则）：滚动是「使用者把格子缩小了」的退路，不是出厂状态。
 * 要看更多的人把格子拉高即可 —— 这一格声明了 `resizable`。
 */
export const TOP_N = 8

/** 一个进程 */
export interface ProcessEntry {
  /** 进程号 */
  readonly pid: number
  /** 进程名 */
  readonly name: string
  /** 占整机 CPU 的比例（0-1） */
  readonly cpu: number
  /** 常驻内存（字节）；取不到时不出现 */
  readonly memory?: number
  /** 是否为本机器人自己的进程 */
  readonly self?: boolean
}

/** 进程概况 */
export interface ProcessInfo {
  /** 进程总数 */
  readonly total: number
  /** 占用最高的若干个 */
  readonly top: readonly ProcessEntry[]
}

/**
 * 把 `si.processes()` 的结果收成前若干条
 *
 * 导出以便用例直接喂夹具：真机上跑不出「某个进程正好吃满两个核」这种情形，而那恰是
 * `pcpu` 换算最容易错的地方。
 * @param list `si.processes().list`
 * @param total 进程总数
 * @param cores 逻辑核数，用于把 `pcpu` 换算成占整机的比例
 * @param selfPid 本进程号
 * @returns 进程概况
 */
export function toProcesses(
  list: readonly {
    readonly pid?: number
    readonly name?: string
    readonly pcpu?: number
    readonly memRss?: number
  }[],
  total: number,
  cores: number,
  selfPid: number
): ProcessInfo {
  const divisor = Number.isFinite(cores) && cores > 0 ? cores : 1
  const rows: ProcessEntry[] = []
  for (const item of list) {
    const pid = Number(item.pid)
    if (!Number.isFinite(pid)) continue

    const pcpu = Number(item.pcpu)
    // `pcpu` 是占单核的百分比，故除以 100 再除以核数，见文件头
    const cpu = Number.isFinite(pcpu) && pcpu > 0 ? Math.min(1, pcpu / 100 / divisor) : 0

    // `memRss` 的单位在各平台上不一致：Windows 上是字节，Linux 上是 KB。
    // 库自己在 Linux 那一路乘了 1024，故此处照原样取，不再二次换算
    const rss = Number(item.memRss)

    rows.push({
      pid,
      name: item.name === undefined || item.name === "" ? String(pid) : item.name,
      cpu,
      ...(Number.isFinite(rss) && rss > 0 ? { memory: rss } : {}),
      ...(pid === selfPid ? { self: true } : {})
    })
  }

  rows.sort((a, b) => (b.cpu !== a.cpu ? b.cpu - a.cpu : (b.memory ?? 0) - (a.memory ?? 0)))

  /*
   * 本机器人自己那一条**一定在表里**，哪怕它排不进前若干名
   *
   * 初版只是给排进来的那一条置标记，而机器人多数时候是闲着的（实测 `pcpu` 为 0，
   * 在一台三百多个进程的机器上排在两百名之后）—— 于是「标出自己」这件事恰在
   * 最常见的情形下不生效，而文件头把它列为本模块的要点之一。
   *
   * 做法是截断之后补一条，而不是把它提到表首：表的语义是「占用最高的若干个」，
   * 把一个 0% 的进程排到第一行会让这张表不再是按占用排序的。补在末尾则读作
   * 「以上是占用最高的，另外这是你的机器人」。
   */
  const top = rows.slice(0, TOP_N)
  if (!top.some(row => row.self === true)) {
    const own = rows.find(row => row.self === true)
    if (own !== undefined) top.push(own)
  }
  return { total, top }
}

/**
 * 采一份进程概况
 * @param warn 出错时的告知方式
 * @param proc Linux 上读 /proc 的进程表；缺省（及其他平台）走 si
 * @returns 进程概况；探不到时总数为 0、表为空
 */
export async function sampleProcesses(
  warn: (message: string, err: unknown) => void,
  proc?: ProcTable
): Promise<ProcessInfo> {
  // Linux 上先直接读 /proc（见 procfs.ts 文件头）；读不了（安卓收紧 /proc 是常态）就静默退回 si
  if (proc !== undefined) {
    try {
      const got = await proc.sample()
      return toProcesses(got.list, got.all, cpus().length, process.pid)
    } catch {
      // 落到下面 si 那一路
    }
  }
  try {
    const all = await si.processes()
    return toProcesses(all.list ?? [], Number(all.all) || (all.list ?? []).length, cpus().length, process.pid)
  } catch (err) {
    warn("探测进程表失败", err)
    return { total: 0, top: [] }
  }
}
