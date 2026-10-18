/**
 * `net.ts` 的用例
 *
 * **`probeOne` 注入 fetch，不发真请求。** 一次真探测要么依赖外网（离线时用例红）、
 * 要么依赖一个本地服务（那就得在用例里起一个 HTTP 服务器）。而它要验的是「四类结果
 * 各自归到哪个字段」，那与网络无关。
 *
 * 速率那两支与磁盘同理：真机上跑不出「累计量倒退」，而那恰是最需要钉住的一条。
 */
import { describe, expect, it, vi } from "vitest"
import { netRates, parseWinStats, pickUsed, probeOne, toNetCounters } from "./net.js"

describe("parseWinStats", () => {
  it("一行一块网卡，中文名与回环照收，交给 toNetCounters 再筛", () => {
    const out = parseWinStats("以太网\t1024\t2048\r\nLoopback Pseudo-Interface 1\t0\t0\r\n\r\n")
    expect(out).toEqual([
      { iface: "以太网", rx_bytes: 1024, tx_bytes: 2048 },
      { iface: "Loopback Pseudo-Interface 1", rx_bytes: 0, tx_bytes: 0 }
    ])
    expect(toNetCounters(out, 1).map(item => item.iface)).toEqual(["以太网"])
  })

  it("数字读不出的行交给 toNetCounters 排掉，而不是记成 0", () => {
    expect(toNetCounters(parseWinStats("坏行\tx\ty"), 1)).toEqual([])
  })
})

describe("toNetCounters", () => {
  it("收下各网卡的累计量并记下采样时刻", () => {
    const out = toNetCounters([{ iface: "eth0", rx_bytes: 100, tx_bytes: 50 }], 1000)
    expect(out).toEqual([{ iface: "eth0", rx: 100, tx: 50, at: 1000 }])
  })

  it("**排掉回环** —— 本机自己跟自己通信不是「网络状况」，且其数值常大得盖住真网卡", () => {
    const out = toNetCounters(
      [
        { iface: "lo", rx_bytes: 9e9, tx_bytes: 9e9 },
        { iface: "eth0", rx_bytes: 1, tx_bytes: 1 }
      ],
      1000
    )
    expect(out.map(item => item.iface)).toEqual(["eth0"])
  })

  it("Windows 上的 Loopback 名字同样排掉", () => {
    expect(toNetCounters([{ iface: "Loopback Pseudo-Interface 1", rx_bytes: 1, tx_bytes: 1 }], 0)).toEqual([])
  })

  it("没有名字的条目跳过", () => {
    expect(toNetCounters([{ rx_bytes: 1, tx_bytes: 1 }], 0)).toEqual([])
  })

  it("累计量非数时整条跳过 —— 半条记录不如没有", () => {
    expect(toNetCounters([{ iface: "eth0", rx_bytes: Number.NaN, tx_bytes: 5 }], 0)).toEqual([])
  })
})

describe("netRates", () => {
  it("按网卡名配对，算出每秒收发", () => {
    const prev = [{ iface: "eth0", rx: 1000, tx: 500, at: 1000 }]
    const next = [{ iface: "eth0", rx: 3000, tx: 1500, at: 3000 }]
    expect(netRates(prev, next)).toEqual([{ iface: "eth0", rx: 1000, tx: 500 }])
  })

  it("**首次只给网卡名，不给速率** —— 没有前一个采样点就没有速率可言", () => {
    expect(netRates([], [{ iface: "eth0", rx: 1, tx: 1, at: 0 }])).toEqual([{ iface: "eth0" }])
  })

  it("**累计量倒退时不给该字段** —— 「-3 MB/s」比没有这个数更糟", () => {
    const prev = [{ iface: "eth0", rx: 5000, tx: 5000, at: 1000 }]
    const next = [{ iface: "eth0", rx: 100, tx: 6000, at: 2000 }]
    expect(netRates(prev, next)).toEqual([{ iface: "eth0", tx: 1000 }])
  })

  it("时间没有前进时同样不给", () => {
    const prev = [{ iface: "eth0", rx: 0, tx: 0, at: 1000 }]
    expect(netRates(prev, [{ iface: "eth0", rx: 100, tx: 100, at: 1000 }])).toEqual([{ iface: "eth0" }])
  })

  it("新插上的网卡（上一批里没有）只给名字，其余照常算", () => {
    const prev = [{ iface: "eth0", rx: 0, tx: 0, at: 0 }]
    const next = [
      { iface: "eth0", rx: 1000, tx: 0, at: 1000 },
      { iface: "wlan0", rx: 9, tx: 9, at: 1000 }
    ]
    expect(netRates(prev, next)).toEqual([{ iface: "eth0", rx: 1000, tx: 0 }, { iface: "wlan0" }])
  })
})

describe("pickUsed", () => {
  /** 三块网卡：一块在用、两块从未走过字节（虚拟网卡的常态） */
  const counters = [
    { iface: "WLAN", rx: 50_000, tx: 9_000, at: 1000 },
    { iface: "VMnet1", rx: 0, tx: 0, at: 1000 },
    { iface: "Teredo", rx: 0, tx: 0, at: 1000 }
  ]

  it("**只留累计收发不为 0 的网卡** —— 一台 Windows 机器上多半有五六块从未用过的虚拟网卡", () => {
    const rates = [{ iface: "WLAN", rx: 1 }, { iface: "VMnet1" }, { iface: "Teredo" }]
    expect(pickUsed(rates, counters)).toEqual([{ iface: "WLAN", rx: 1 }])
  })

  it("**判据是累计量而非速率**：主网卡空闲的那几拍速率为 0，但它不该消失", () => {
    const rates = [{ iface: "WLAN", rx: 0, tx: 0 }, { iface: "VMnet1", rx: 0, tx: 0 }]
    expect(pickUsed(rates, counters)).toEqual([{ iface: "WLAN", rx: 0, tx: 0 }])
  })

  it("**全都没用过时一个都不筛** —— 空表说的是「探不到网卡」，而事实是「都还没动过」", () => {
    const idle = [
      { iface: "VMnet1", rx: 0, tx: 0, at: 1000 },
      { iface: "Teredo", rx: 0, tx: 0, at: 1000 }
    ]
    const rates = [{ iface: "VMnet1" }, { iface: "Teredo" }]
    expect(pickUsed(rates, idle)).toEqual(rates)
  })

  it("一块网卡都没有时给空数组", () => {
    expect(pickUsed([], [])).toEqual([])
  })
})

describe("probeOne", () => {
  it("记下状态码与耗时", async () => {
    const fake = vi.fn(async () => new Response(null, { status: 204 }))
    const out = await probeOne({ name: "本机", url: "http://127.0.0.1/" }, fake as unknown as typeof fetch)
    expect(out.status).toBe(204)
    expect(out.error).toBeUndefined()
    expect(typeof out.latency).toBe("number")
  })

  it("**4xx / 5xx 不算错**：那是一个答复，探测本身成功了", async () => {
    const fake = vi.fn(async () => new Response(null, { status: 503 }))
    const out = await probeOne({ name: "x", url: "http://x/" }, fake as unknown as typeof fetch)
    expect(out.status).toBe(503)
    expect(out.error).toBeUndefined()
  })

  it("**连不上时给 error 而不抛** —— 失败是它要报告的结果之一", async () => {
    const fake = vi.fn(async () => {
      throw Object.assign(new Error("boom"), { code: "ENOTFOUND" })
    })
    const out = await probeOne({ name: "x", url: "http://nope/" }, fake as unknown as typeof fetch)
    expect(out.error).toBe("ENOTFOUND")
    expect(out.status).toBeUndefined()
  })

  it("没有 code 的错退回用错误名，不留空", async () => {
    const fake = vi.fn(async () => {
      throw new DOMException("timed out", "TimeoutError")
    })
    const out = await probeOne({ name: "x", url: "http://slow/" }, fake as unknown as typeof fetch)
    expect(out.error).toBe("TimeoutError")
  })

  /*
   * 假实现须**显式声明两个参数**
   *
   * 写成 `vi.fn(async () => ...)` 时 vitest 推出的参数元组是空的，于是
   * `fake.mock.calls[0][1]` 在类型层面越界（用例本身跑得过，`tsc` 那一关才报）。
   * 下面两条断言查的正是第二个参数（请求选项），故签名不能省。
   * @returns 一个空响应
   */
  const fakeFetch = (status: number): typeof fetch =>
    vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(null, { status })) as unknown as typeof fetch

  it("用 HEAD 而不是 GET —— 探的是「通不通」，不必把整个页面拉回来", async () => {
    const fake = fakeFetch(200)
    await probeOne({ name: "x", url: "http://x/" }, fake)
    expect(vi.mocked(fake).mock.calls[0]?.[1]).toMatchObject({ method: "HEAD" })
  })

  it("**不跟随重定向**：跟随会把一次 301 记成目标站点的延迟", async () => {
    const fake = fakeFetch(301)
    await probeOne({ name: "x", url: "http://x/" }, fake)
    expect(vi.mocked(fake).mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" })
  })
})
