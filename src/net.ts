/**
 * 模块职责：网络监控 —— 网卡的收发速率，以及对指定地址的可达性探测
 * 依赖方向：只依赖 `systeminformation` 与全局 `fetch`（node 18+ 内置）
 * 生命周期：速率需要两个采样点，故采样器持有上一个
 * 注意事项：四条约定 ——
 *          1) 默认不探测任何对外地址：出厂带默认目标等于让这台机器每 5 秒向第三方发一次请求，
 *             而使用者没要求过。目标一律由配置给出，空配置时组件显示「未配置」
 *          2) 网卡速率用 `si.networkStats()` 的累计量作差，不用它自带的 `rx_sec` / `tx_sec` ——
 *             那是「距上次调用以来」的平均值，而谁调过取决于同进程里还有谁在用这个库
 *          3) 探测用 HEAD，且对方回 405 时**不退回 GET**：405 本身已是一次成功往返，证明「可达」
 *          4) 「连不上」与「连上了但状态码非 2xx」分开呈现，否则「我的服务挂了」与「我的网断了」
 *             在面板上是同一个红点
 */
import si from "systeminformation"

/** 探测的超时 */
const PROBE_TIMEOUT_MS = 4000

/** 一块网卡的累计收发量 */
export interface NetCounters {
  /** 网卡名 */
  readonly iface: string
  /** 累计接收（字节） */
  readonly rx: number
  /** 累计发送（字节） */
  readonly tx: number
  /** 采样时刻 */
  readonly at: number
}

/** 一块网卡的收发速率 */
export interface NetRates {
  /** 网卡名 */
  readonly iface: string
  /** 接收速率（字节每秒）；首次采样时不出现 */
  readonly rx?: number
  /** 发送速率（字节每秒）；首次采样时不出现 */
  readonly tx?: number
}

/** 一次对外探测的结果 */
export interface ProbeResult {
  /** 探测的名字，由配置给出 */
  readonly name: string
  /** 探测的地址 */
  readonly url: string
  /** HTTP 状态码；连不上时不出现 */
  readonly status?: number
  /** 往返耗时（毫秒） */
  readonly latency?: number
  /** 连不上的原因；连上了就不出现（哪怕状态码是 500） */
  readonly error?: string
}

/** 一个探测目标 */
export interface ProbeTarget {
  /** 显示用的名字 */
  readonly name: string
  /** 完整地址 */
  readonly url: string
}

/** 网络状况 */
export interface NetInfo {
  /** 各网卡的收发速率 */
  readonly rates: readonly NetRates[]
  /** 各探测结果；未配置目标时为空数组 */
  readonly probes: readonly ProbeResult[]
}

/**
 * 把 `si.networkStats()` 的返回值整理成累计量
 *
 * 排掉回环网卡：本机自己跟自己通信的流量不是「网络状况」，而它在有些机器上
 * 数值极大（本地服务之间的通信全走它），会把真正的网卡挤到看不见。
 * @param list `si.networkStats()` 的返回值
 * @param now 采样时刻
 * @returns 各网卡的累计量
 */
export function toNetCounters(
  list: readonly {
    readonly iface?: string
    readonly rx_bytes?: number
    readonly tx_bytes?: number
  }[],
  now: number
): NetCounters[] {
  const out: NetCounters[] = []
  for (const item of list) {
    const iface = item.iface ?? ""
    if (iface === "") continue
    const lower = iface.toLowerCase()
    if (lower === "lo" || lower.startsWith("loopback")) continue
    const rx = Number(item.rx_bytes)
    const tx = Number(item.tx_bytes)
    if (!Number.isFinite(rx) || !Number.isFinite(tx)) continue
    out.push({ iface, rx, tx, at: now })
  }
  return out
}

/**
 * 由两个采样点算出各网卡的收发速率
 *
 * 累计量倒退（网卡重置、系统重启）时该字段不出现，与磁盘读写同一处置：
 * 负的速率比没有这个数更糟。
 * @param prev 上一批采样点，首次为空
 * @param next 本批采样点
 * @returns 各网卡的速率，顺序同 next
 */
export function netRates(
  prev: readonly NetCounters[],
  next: readonly NetCounters[]
): NetRates[] {
  const before = new Map(prev.map(item => [item.iface, item]))
  return next.map(now => {
    const was = before.get(now.iface)
    if (was === undefined) return { iface: now.iface }
    const span = (now.at - was.at) / 1000
    if (!Number.isFinite(span) || span <= 0) return { iface: now.iface }
    const rx = (now.rx - was.rx) / span
    const tx = (now.tx - was.tx) / span
    return {
      iface: now.iface,
      ...(Number.isFinite(rx) && rx >= 0 ? { rx } : {}),
      ...(Number.isFinite(tx) && tx >= 0 ? { tx } : {})
    }
  })
}

/**
 * 只留下用过的网卡
 *
 * 一台 Windows 机器上多半有五六块从未收发过一个字节的网卡（虚拟网卡、Teredo、蓝牙网络……）。
 * **判据取累计量而非速率**：速率为 0 只说明这一拍没有流量，按它筛会让主网卡在空闲的那几拍里消失。
 * **全都为 0 时一个都不筛** —— 空表的意思是「探不到网卡」，而那时的事实是「网卡都还没动过」。
 * @param rates 各网卡的速率
 * @param counters 本批采样点，带累计量
 * @returns 用过的那些；全都没用过时原样给出
 */
export function pickUsed(rates: readonly NetRates[], counters: readonly NetCounters[]): NetRates[] {
  const used = new Set(counters.filter(item => item.rx + item.tx > 0).map(item => item.iface))
  const shown = rates.filter(item => used.has(item.iface))
  return shown.length > 0 ? shown : [...rates]
}

/**
 * 探一个地址
 *
 * 不抛错：探测失败是这个函数要报告的结果之一，而不是它的异常。
 * @param target 探测目标
 * @param fetchImpl 发请求的实现，缺省为全局 fetch；仅测试时替换
 * @returns 探测结果
 */
export async function probeOne(
  target: ProbeTarget,
  fetchImpl: typeof fetch = fetch
): Promise<ProbeResult> {
  const began = Date.now()
  try {
    const res = await fetchImpl(target.url, {
      method: "HEAD",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: "manual"
    })
    return {
      name: target.name,
      url: target.url,
      status: res.status,
      latency: Date.now() - began
    }
  } catch (err) {
    /*
     * **只认字符串型的 `code`。**
     *
     * node 的网络错误带 `code: "ENOTFOUND"` 这样的字符串，那正是要显示的东西。
     * 而超时走的是 `AbortSignal.timeout`，它抛的是 `DOMException` —— 那个类带一个
     * 历史遗留的**数字** `code`（超时为 23），于是 `code ?? name` 会取到 23，
     * 面板上显示「探测失败：23」。写 `?? ` 时想的是「没有 code 就退回 name」，
     * 而 DOMException 恰是「有 code 但那个 code 毫无意义」的情形。
     *
     * 超时是对外探测最常见的失败（目标站被墙、离网部署），故这一处错得最显眼：
     * 一串数字既说不清出了什么事，也搜不到。取 `name` 得到 `TimeoutError`。
     */
    const code = (err as { code?: unknown }).code
    const named = typeof code === "string" && code !== "" ? code : undefined
    return {
      name: target.name,
      url: target.url,
      latency: Date.now() - began,
      error: named ?? (err instanceof Error ? err.name : String(err))
    }
  }
}

/** 网络采样器：持有上一批网卡累计量 */
export class NetSampler {
  /** 上一批采样点 */
  #prev: readonly NetCounters[] = []

  /**
   * 采一份网络快照
   * @param warn 出错时的告知方式
   * @param targets 探测目标；空数组时不发任何对外请求
   * @returns 网络状况
   */
  async sample(
    warn: (message: string, err: unknown) => void,
    targets: readonly ProbeTarget[] = []
  ): Promise<NetInfo> {
    let stats: Awaited<ReturnType<typeof si.networkStats>> | undefined
    try {
      stats = await si.networkStats("*")
    } catch (err) {
      warn("探测网卡流量失败", err)
    }

    const next = toNetCounters(stats ?? [], Date.now())
    /*
     * `#prev` 存的是**未经筛选**的那一份
     *
     * 筛掉从未用过的网卡是给人看的事；若连 prev 一起筛掉，一块网卡开始走流量的那一刻
     * 就没有上一个采样点可比，于是它要空等一拍才显示出速率。
     */
    const rates = pickUsed(netRates(this.#prev, next), next)
    if (next.length > 0) this.#prev = next

    // 各目标并发探测：串行会让四个目标的耗时相加，而它们彼此无关
    const probes = await Promise.all(targets.map(target => probeOne(target)))

    return { rates, probes }
  }
}
