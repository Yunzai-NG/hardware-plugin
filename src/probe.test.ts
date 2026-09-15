/**
 * `probe.ts` 的用例
 *
 * 三处 mock，都是为了让用例跑得动而不是为了省事：
 * - `systeminformation` 的三个探测各要 0.7~2.3 秒，且返回值随机器而变 —— 真跑一遍
 *   既慢又没法断言。
 * - `@yunzai-ng/core` 的 `probeGpus` 会 spawn nvidia-smi。用工厂 mock 而非 spy，
 *   这样连 core 那个模块都不会被加载（它带 level / sqlite 等原生模块）。
 * - `node:os` 的 `cpus`。**这一处非 mock 不可**：整机 CPU 靠两个采样点作差，而用例里
 *   两次采样相隔几毫秒，真实的累计量尚未前进，于是 `span <= 0`、按设计返回 undefined。
 *   也就是说「第二次采样带上 cpu」这条用例在真时钟下永远量不到东西 —— 它要验的是
 *   差分算得对，而不是「跑够一个时钟节拍会发生什么」。`totalmem` / `freemem` 仍走真的，
 *   内存那几条用例断言的正是真实数值之间的关系。
 *
 * 断言的重点是「测不到时缺字段而不是给 0」这一类决定 —— 那是本模块存在的理由所在，
 * 也是唯一会被日后改动悄悄破坏的东西。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const probeGpus = vi.fn<() => Promise<unknown>>()
const siCpu = vi.fn<() => Promise<unknown>>()
const siMemLayout = vi.fn<() => Promise<unknown>>()
const siGraphics = vi.fn<() => Promise<unknown>>()
const siMem = vi.fn<() => Promise<unknown>>()
const siTemp = vi.fn<() => Promise<unknown>>()
const siSpeed = vi.fn<() => Promise<unknown>>()
const siBattery = vi.fn<() => Promise<unknown>>()
const osCpus = vi.fn<() => { times: { user: number; nice: number; sys: number; idle: number; irq: number } }[]>()

vi.mock("@yunzai-ng/core", () => ({ probeGpus: (): Promise<unknown> => probeGpus() }))
vi.mock("systeminformation", () => ({
  default: {
    cpu: (): Promise<unknown> => siCpu(),
    memLayout: (): Promise<unknown> => siMemLayout(),
    graphics: (): Promise<unknown> => siGraphics(),
    mem: (): Promise<unknown> => siMem(),
    cpuTemperature: (): Promise<unknown> => siTemp(),
    cpuCurrentSpeed: (): Promise<unknown> => siSpeed(),
    battery: (): Promise<unknown> => siBattery()
  }
}))
vi.mock("node:os", async () => {
  const real = await vi.importActual<typeof import("node:os")>("node:os")
  return { ...real, cpus: () => osCpus() }
})

const {
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
} = await import("./probe.js")

/**
 * 造一个核心的时间累计量
 * @param idle 空闲累计
 * @param busy 非空闲累计，摊进 user
 * @returns 一个形如 `os.cpus()[i]` 的对象
 */
function core(idle: number, busy: number): { times: { user: number; nice: number; sys: number; idle: number; irq: number } } {
  return { times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } }
}

beforeEach(() => {
  probeGpus.mockResolvedValue(undefined)
  siCpu.mockResolvedValue({})
  siMemLayout.mockResolvedValue([])
  siGraphics.mockResolvedValue({ controllers: [] })
  // 缺省不给交换空间：`swaptotal` 为 0 时按设计不出现 swap 字段，故多数用例无须理它
  siMem.mockResolvedValue({ swaptotal: 0, swapused: 0 })
  /*
   * 温度、频率、电池缺省都「取不到」
   *
   * 这三项在虚拟机与多数容器里本就读不到，故缺省即那种处境 —— 于是「读不到时整项
   * 不出现」成为默认行为，不必每条用例各安排一遍。要验有数据那一路的用例自己覆盖。
   */
  siTemp.mockResolvedValue({ main: null, cores: [], max: null })
  siSpeed.mockResolvedValue({ avg: 0 })
  siBattery.mockResolvedValue({ hasBattery: false })
  // 缺省让累计量停着不动：多数用例并不关心 CPU，而停着的时钟正好让
  //「无差可作时不给 cpu 字段」成为默认行为，不必每条用例都去安排
  osCpus.mockReturnValue([core(1000, 1000)])
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("cpuTimes", () => {
  it("把各核的累计量相加", () => {
    expect(cpuTimes([core(100, 50), core(200, 150)])).toEqual({ idle: 300, total: 500 })
  })

  it("一个核都没有时给两个 0，交由 cpuLoad 判定算不出", () => {
    expect(cpuTimes([])).toEqual({ idle: 0, total: 0 })
  })

  it("total 含 idle —— 它是分母而不是「忙的时间」", () => {
    const sum = cpuTimes([core(700, 300)])
    expect(sum.total).toBe(1000)
  })
})

describe("cpuLoad", () => {
  it("没有上一个采样点时给 undefined 而不是 0", () => {
    expect(cpuLoad(undefined, { idle: 700, total: 1000 })).toBeUndefined()
  })

  it("由两点之差算出占用率", () => {
    // 这段时间里总计走了 1000，其中空闲 300，即忙了 70%
    expect(cpuLoad({ idle: 700, total: 1000 }, { idle: 1000, total: 2000 })).toBeCloseTo(0.7)
  })

  it("总计量没有前进时给 undefined —— 两次采样落在同一毫秒", () => {
    expect(cpuLoad({ idle: 700, total: 1000 }, { idle: 700, total: 1000 })).toBeUndefined()
  })

  it("总计量倒退时给 undefined —— 系统时间被回拨", () => {
    expect(cpuLoad({ idle: 700, total: 2000 }, { idle: 700, total: 1000 })).toBeUndefined()
  })

  it("空闲量倒退时不会算出大于 1 的比例", () => {
    expect(cpuLoad({ idle: 900, total: 1000 }, { idle: 800, total: 2000 })).toBeLessThanOrEqual(1)
  })

  it("全程空闲给 0", () => {
    expect(cpuLoad({ idle: 700, total: 1000 }, { idle: 1700, total: 2000 })).toBe(0)
  })
})

describe("looksFakeGpu", () => {
  it("认得出本机那两个虚拟显示器", () => {
    expect(looksFakeGpu("ToDesk Virtual Display")).toBe(true)
    expect(looksFakeGpu("GameViewer Display Adapter")).toBe(true)
  })

  it("不认大小写", () => {
    expect(looksFakeGpu("PARSEC VIRTUAL DISPLAY ADAPTER")).toBe(true)
  })

  it("放过真显卡", () => {
    expect(looksFakeGpu("NVIDIA GeForce RTX 4060 Laptop GPU")).toBe(false)
    expect(looksFakeGpu("Intel(R) Arc(TM) 140V GPU")).toBe(false)
    expect(looksFakeGpu("AMD Radeon 780M")).toBe(false)
  })
})

describe("looksNvidia", () => {
  it("认得出 N 卡的几种写法", () => {
    expect(looksNvidia("NVIDIA GeForce RTX 4060")).toBe(true)
    expect(looksNvidia("Quadro P2000")).toBe(true)
    expect(looksNvidia("Tesla T4")).toBe(true)
  })

  it("不把别家的卡认成 N 卡", () => {
    expect(looksNvidia("Intel(R) UHD Graphics")).toBe(false)
    expect(looksNvidia("AMD Radeon 780M")).toBe(false)
  })
})

describe("namesMatch", () => {
  it("一方是另一方的子串即算同一块 —— 两路对同一块卡的写法长短不同", () => {
    expect(namesMatch("NVIDIA GeForce RTX 4090", "RTX 4090")).toBe(true)
    expect(namesMatch("rtx 4090", "NVIDIA GeForce RTX 4090")).toBe(true)
  })

  it("空名字一律不配对，否则它会配上所有卡", () => {
    expect(namesMatch("", "RTX 4090")).toBe(false)
    expect(namesMatch("RTX 4090", "  ")).toBe(false)
  })

  it("不同型号不配对", () => {
    expect(namesMatch("RTX 4090", "RTX 4060")).toBe(false)
  })
})

describe("mergeGpus", () => {
  it("两路都空时给空数组", () => {
    expect(mergeGpus(undefined, undefined)).toEqual([])
  })

  it("**nvidia-smi 没报显存时，用型号表里的标称值补上** —— 虚拟化环境里它报 [N/A]", () => {
    const merged = mergeGpus(
      [{ name: "NVIDIA GeForce RTX 4090", memoryTotal: 24 * 1024 ** 3 }],
      [{ name: "RTX 4090", load: 0.42 }]
    )
    expect(merged).toEqual([{ name: "RTX 4090", load: 0.42, memoryTotal: 24 * 1024 ** 3 }])
  })

  it("nvidia-smi 已报显存时不被型号表覆盖 —— 前者是实测值", () => {
    const merged = mergeGpus(
      [{ name: "RTX 4090", memoryTotal: 24 * 1024 ** 3 }],
      [{ name: "RTX 4090", load: 0.42, memoryTotal: 23 * 1024 ** 3 }]
    )
    expect(merged[0]?.memoryTotal).toBe(23 * 1024 ** 3)
  })

  it("配对过的型号条目不再单独列出", () => {
    const merged = mergeGpus([{ name: "RTX 4090" }], [{ name: "NVIDIA GeForce RTX 4090", load: 0.1 }])
    expect(merged).toHaveLength(1)
  })

  it("两块同型号的卡各配一条型号条目，不都认领同一条", () => {
    const merged = mergeGpus(
      [
        { name: "RTX 4090", memoryTotal: 24 * 1024 ** 3 },
        { name: "RTX 4090", memoryTotal: 24 * 1024 ** 3 }
      ],
      [
        { name: "RTX 4090", load: 0.1 },
        { name: "RTX 4090", load: 0.2 }
      ]
    )
    expect(merged).toHaveLength(2)
    expect(merged.every(item => item.memoryTotal === 24 * 1024 ** 3)).toBe(true)
  })

  it("只有型号表时保留型号，不编造占用率", () => {
    const merged = mergeGpus([{ name: "Intel Arc 140V", memoryTotal: 0 }], undefined)
    expect(merged).toEqual([{ name: "Intel Arc 140V" }])
    expect(merged[0]?.load).toBeUndefined()
  })

  it("排掉虚拟显示器", () => {
    const merged = mergeGpus(
      [{ name: "Intel Arc 140V" }, { name: "ToDesk Virtual Display" }, { name: "GameViewer" }],
      undefined
    )
    expect(merged.map(item => item.name)).toEqual(["Intel Arc 140V"])
  })

  it("有 nvidia-smi 的结果时丢掉型号表里的 N 卡，同一块卡不出现两次", () => {
    const merged = mergeGpus(
      [{ name: "NVIDIA GeForce RTX 4060 Laptop GPU" }, { name: "Intel Arc 140V" }],
      [{ name: "NVIDIA GeForce RTX 4060 Laptop GPU", load: 0.31 }]
    )
    expect(merged).toHaveLength(2)
    expect(merged[0]).toEqual({ name: "NVIDIA GeForce RTX 4060 Laptop GPU", load: 0.31 })
    expect(merged[1]).toEqual({ name: "Intel Arc 140V" })
  })

  it("量到的那一路排在前面", () => {
    const merged = mergeGpus([{ name: "Intel Arc 140V" }], [{ name: "RTX 4060", load: 0.5 }])
    expect(merged[0]?.name).toBe("RTX 4060")
  })

  it("显存为 0 的型号不带 memoryTotal —— 集显与虚拟屏都是 0", () => {
    const merged = mergeGpus([{ name: "Intel Arc 140V", memoryTotal: 0 }], undefined)
    expect(merged[0]).toEqual({ name: "Intel Arc 140V" })
    expect(Object.keys(merged[0] ?? {})).toEqual(["name"])
  })

  it("显存非 0 时带上", () => {
    const merged = mergeGpus([{ name: "RTX 4060", memoryTotal: 8 * 1024 ** 3 }], undefined)
    expect(merged[0]?.memoryTotal).toBe(8 * 1024 ** 3)
  })
})

describe("sampleMemory", () => {
  it("已用加可用等于总量", () => {
    const mem = sampleMemory()
    expect(mem.used + mem.free).toBe(mem.total)
  })

  it("总量是个正数", () => {
    expect(sampleMemory().total).toBeGreaterThan(0)
  })

  /*
   * 这一条是本次改动的理由
   *
   * 夹具照一台空闲 Linux 抄：16G 内存、`free` 只剩 1G（页面缓存占着 11G），而内核说
   * available 有 12G。按 freemem 算是 94% 占用，按 available 算是 25% —— 后者才是
   * `free -h` 与使用者的认知。
   */
  it("**有 si.mem() 时按 available 算可用**，不按 freemem 那个偏低的数", () => {
    const total = 16 * 1024 ** 3
    const mem = sampleMemory({ total, available: 12 * 1024 ** 3, buffcache: 11 * 1024 ** 3 })
    expect(mem.total).toBe(total)
    expect(mem.free).toBe(12 * 1024 ** 3)
    expect(mem.used).toBe(4 * 1024 ** 3)
    expect(mem.cached).toBe(11 * 1024 ** 3)
  })

  it("available 缺失时退回 os 的 freemem，仍给得出一份数", () => {
    const mem = sampleMemory({ total: 0, available: Number.NaN })
    expect(mem.total).toBeGreaterThan(0)
    expect(mem.used + mem.free).toBe(mem.total)
  })

  it("**buffcache 为 0 也照给**（Windows 上确有此数），与「没有这一项」是两种画法", () => {
    expect(sampleMemory({ total: 100, available: 40, buffcache: 0 }).cached).toBe(0)
    expect(sampleMemory({ total: 100, available: 40 }).cached).toBeUndefined()
  })

  it("available 超过总量时夹到总量，不给出负的已用", () => {
    expect(sampleMemory({ total: 100, available: 400 })).toMatchObject({ used: 0, free: 100 })
  })
})

describe("swapOf", () => {
  it("取总量与已用，可用由两者相减", () => {
    expect(swapOf({ swaptotal: 1000, swapused: 400 })).toEqual({ total: 1000, used: 400, free: 600 })
  })

  /*
   * 这一条是本函数存在的理由
   *
   * 未配置交换空间是常态（容器里、以及刻意关掉 swap 的机器）。若给出一条 0% 的槽，
   * 使用者读到的是「交换空间没在用」，而事实是「这台机器没有交换空间」—— 两者相反：
   * 前者说明内存宽裕，后者说明内存吃紧时会直接 OOM。故该让这一条整个不出现。
   */
  it("**总量为 0 时不出现，而不是一条 0% 的槽** —— 没有交换空间与没在用交换空间是相反的两件事", () => {
    expect(swapOf({ swaptotal: 0, swapused: 0 })).toBeUndefined()
  })

  it("取不到 si.mem() 时同样不出现", () => {
    expect(swapOf(undefined)).toBeUndefined()
  })

  it("已用缺失时记 0，但总量在故这一条照常出现 —— 有交换空间这件事本身要说出来", () => {
    expect(swapOf({ swaptotal: 2000 })).toEqual({ total: 2000, used: 0, free: 2000 })
  })

  it("已用超过总量时夹到总量，不给出负的可用量", () => {
    expect(swapOf({ swaptotal: 100, swapused: 500 })).toEqual({ total: 100, used: 100, free: 0 })
  })
})

describe("perCoreTimes / perCoreLoad", () => {
  it("逐核汇总，且各核之和等于整机那一份 —— 两处必然自洽", () => {
    const list = [core(100, 50), core(200, 150)]
    const per = perCoreTimes(list)
    expect(per).toEqual([
      { idle: 100, total: 150 },
      { idle: 200, total: 350 }
    ])
    const whole = cpuTimes(list)
    expect(per.reduce((sum, one) => sum + one.total, 0)).toBe(whole.total)
    expect(per.reduce((sum, one) => sum + one.idle, 0)).toBe(whole.idle)
  })

  it("首次没有上一批时不给", () => {
    expect(perCoreLoad(undefined, [{ idle: 0, total: 100 }])).toBeUndefined()
  })

  /*
   * 这一条是 perCoreLoad 存在检查的理由
   *
   * 核数变了仍按下标配对，得到的是「3 号核的新值减 5 号核的旧值」—— 那种数看起来
   * 完全正常，却毫无意义，而条形图照样画得出来。热插拔与改 cpuset 都会走到这里。
   */
  it("**核数变了就整批不给**，不按下标硬配", () => {
    const prev = [{ idle: 0, total: 100 }, { idle: 0, total: 100 }]
    const next = [{ idle: 50, total: 200 }]
    expect(perCoreLoad(prev, next)).toBeUndefined()
  })

  it("逐核算出占用，半忙的核得 0.5", () => {
    const prev = [{ idle: 100, total: 200 }]
    const next = [{ idle: 150, total: 300 }]
    expect(perCoreLoad(prev, next)).toEqual([0.5])
  })

  it("某一核算不出就整批不给 —— 一个缺口会让下标与核号错位", () => {
    const prev = [{ idle: 0, total: 100 }, { idle: 0, total: 100 }]
    // 第二核的累计量没有前进，`cpuLoad` 于是给 undefined
    const next = [{ idle: 50, total: 200 }, { idle: 0, total: 100 }]
    expect(perCoreLoad(prev, next)).toBeUndefined()
  })
})

describe("tempOf", () => {
  it("取主读数、各核与临界值", () => {
    expect(tempOf({ main: 52, cores: [50, 54], max: 100 })).toEqual({
      main: 52,
      cores: [50, 54],
      max: 100
    })
  })

  /*
   * 这两条是本函数存在的理由
   *
   * 台式机、虚拟机与多数容器里读不到传感器，而 `si` 在那时给的是 0 或 -1 而非抛错。
   * 照收会让卡片上写「0 ℃」，那会被读成「凉得出奇」—— 一个真在运转的 CPU 不可能是 0 ℃，
   * 故这条判断不会误伤真实读数。
   */
  it("**主读数为 0 时整项不出现**", () => {
    expect(tempOf({ main: 0 })).toBeUndefined()
  })

  it("**主读数为 -1 时同样不出现**（部分平台的表示）", () => {
    expect(tempOf({ main: -1 })).toBeUndefined()
  })

  it("取不到时不出现", () => {
    expect(tempOf(undefined)).toBeUndefined()
    expect(tempOf({ main: null })).toBeUndefined()
  })

  it("各核里混着读不到的那些，只留可用的", () => {
    expect(tempOf({ main: 52, cores: [50, 0, -1, 54, null] })?.cores).toEqual([50, 54])
  })

  it("各核全都读不到时那一项不出现，主读数照常给", () => {
    const out = tempOf({ main: 52, cores: [0, 0] })
    expect(out).toEqual({ main: 52 })
    expect(out?.cores).toBeUndefined()
  })

  it("临界值为 0 时不给 —— 分母为 0 的槽画不出来", () => {
    expect(tempOf({ main: 52, max: 0 })?.max).toBeUndefined()
  })
})

describe("clockOf", () => {
  it("**GHz 换算成 MHz** —— 一张卡上两个频率不该各用一套单位", () => {
    expect(clockOf({ avg: 3.4 })).toBe(3400)
  })

  it("取不到时不给，不记 0", () => {
    expect(clockOf(undefined)).toBeUndefined()
    expect(clockOf({ avg: 0 })).toBeUndefined()
    expect(clockOf({ avg: null })).toBeUndefined()
  })
})

describe("batteryOf", () => {
  /*
   * 这一条是本函数存在的理由
   *
   * `si.battery()` 在台式机上照样成功返回，只是 `hasBattery: false` 且各项为 0。
   * 按「有没有拿到数据」判断会让每台服务器都多出一枚恒为「0%、未充电」的卡片。
   */
  it("**判据是 hasBattery，不是有没有拿到数据**", () => {
    expect(batteryOf({ hasBattery: false, percent: 0, isCharging: false })).toBeUndefined()
    expect(batteryOf(undefined)).toBeUndefined()
  })

  it("百分数换成 0-1 的比例", () => {
    expect(batteryOf({ hasBattery: true, percent: 87, isCharging: false })?.level).toBeCloseTo(0.87, 10)
  })

  it("电量夹在 0-1：si 偶尔给 101，而超过满圈的环画不出来", () => {
    expect(batteryOf({ hasBattery: true, percent: 101, isCharging: true })?.level).toBe(1)
  })

  it("放电中给出剩余分钟数", () => {
    expect(batteryOf({ hasBattery: true, percent: 50, isCharging: false, timeRemaining: 96 })).toEqual({
      level: 0.5,
      charging: false,
      minutesLeft: 96
    })
  })

  /*
   * 充电中那个数的语义是相反的
   *
   * `timeRemaining` 在充电时是「充满还要多久」，放电时是「还能用多久」。同一个字段
   * 两种含义，照搬会让面板在充电时写「还剩 96 分钟」，而实情是「96 分钟后充满」。
   */
  it("**充电中不给 minutesLeft** —— 那个字段此时说的是「充满还要多久」", () => {
    expect(batteryOf({ hasBattery: true, percent: 50, isCharging: true, timeRemaining: 96 })).toEqual({
      level: 0.5,
      charging: true
    })
  })

  it("剩余时间取不到时那一项不出现", () => {
    expect(batteryOf({ hasBattery: true, percent: 50, isCharging: false, timeRemaining: 0 })?.minutesLeft)
      .toBeUndefined()
  })
})

describe("HardwareSampler", () => {
  it("首次采样不带 cpu 字段 —— 无差可作，0 会被读成机器闲着", async () => {
    const sampler = new HardwareSampler()
    const first = await sampler.sample()
    expect("cpu" in first).toBe(false)
  })

  it("第二次采样带上 cpu，且取的是两点之间那一段", async () => {
    const sampler = new HardwareSampler()
    osCpus.mockReturnValue([core(1000, 1000)])
    await sampler.sample()
    // 这一段里空闲走了 30、总计走了 100，故占用为 70%。断言确切的数而不只是
    //「是个 number」：后者在把差分写成「拿本次的累计量直接算比例」时照样能过
    osCpus.mockReturnValue([core(1030, 1070)])
    const second = await sampler.sample(true)
    expect(second.cpu).toBeCloseTo(0.7, 10)
  })

  it("内存每次都有 —— 它不需要两个采样点", async () => {
    const sampler = new HardwareSampler()
    const first = await sampler.sample()
    expect(first.memory.total).toBeGreaterThan(0)
  })

  it("缓存生效时不重复调 probeGpus", async () => {
    const sampler = new HardwareSampler()
    await sampler.sample()
    await sampler.sample()
    expect(probeGpus).toHaveBeenCalledTimes(1)
  })

  it("force 绕过缓存", async () => {
    const sampler = new HardwareSampler()
    await sampler.sample()
    await sampler.sample(true)
    expect(probeGpus).toHaveBeenCalledTimes(2)
  })

  it("型号探测只发起一次，五秒一轮的请求不会各起一趟", async () => {
    const sampler = new HardwareSampler()
    await sampler.sample()
    await sampler.sample(true)
    await sampler.sample(true)
    expect(siCpu).toHaveBeenCalledTimes(1)
  })

  it("首次采样不等型号探完，故那一份里没有 models", async () => {
    let release = (): void => {}
    siCpu.mockImplementation(
      () =>
        new Promise(resolve => {
          release = (): void => resolve({ brand: "Ultra 9 285H" })
        })
    )
    const sampler = new HardwareSampler()
    const first = await sampler.sample()
    expect(first.models).toBeUndefined()
    release()
  })

  it("型号探完后的下一轮带上 models", async () => {
    siCpu.mockResolvedValue({ brand: "Ultra 9 285H", cores: 16, physicalCores: 10 })
    siMemLayout.mockResolvedValue([{ size: 16 * 1024 ** 3, type: "DDR5", clockSpeed: 6400 }])
    const sampler = new HardwareSampler()
    await sampler.sample()
    await sampler.probeModels()
    const later = await sampler.sample(true)
    expect(later.models).toEqual({
      cpu: "Ultra 9 285H",
      cores: 16,
      physicalCores: 10,
      memoryType: "DDR5",
      memoryClock: 6400
    })
  })

  it("型号里取不到的项不出现，而不是空字符串或 0", async () => {
    siCpu.mockResolvedValue({ brand: "", cores: 0 })
    siMemLayout.mockResolvedValue([{ size: 0, type: "", clockSpeed: 0 }])
    const sampler = new HardwareSampler()
    await sampler.probeModels()
    const info = await sampler.sample(true)
    expect(info.models).toEqual({})
  })

  it("某一项探测抛错只让该项缺失，其余照常", async () => {
    siMemLayout.mockRejectedValue(new Error("Termux 上读不到"))
    siCpu.mockResolvedValue({ brand: "Ultra 9 285H" })
    const warn = vi.fn()
    const sampler = new HardwareSampler(warn)
    await sampler.probeModels()
    const info = await sampler.sample(true)
    expect(info.models).toEqual({ cpu: "Ultra 9 285H" })
    expect(warn).toHaveBeenCalledOnce()
  })

  it("显卡占用探测抛错不影响整份快照", async () => {
    probeGpus.mockRejectedValue(new Error("nvidia-smi 崩了"))
    const warn = vi.fn()
    const sampler = new HardwareSampler(warn)
    const info = await sampler.sample()
    expect(info.memory.total).toBeGreaterThan(0)
    expect(info.gpus).toEqual([])
    expect(warn).toHaveBeenCalledOnce()
  })

  it("显卡型号表里的虚拟显示器不会进快照", async () => {
    siGraphics.mockResolvedValue({
      controllers: [
        { model: "Intel(R) Arc(TM) 140V GPU", vram: 0 },
        { model: "ToDesk Virtual Display", vram: 0 },
        { model: "GameViewer Display", vram: 0 }
      ]
    })
    const sampler = new HardwareSampler()
    await sampler.probeModels()
    const info = await sampler.sample(true)
    expect(info.gpus.map(item => item.name)).toEqual(["Intel(R) Arc(TM) 140V GPU"])
  })

  it("没有型号的控制器条目直接丢掉", async () => {
    siGraphics.mockResolvedValue({ controllers: [{ vram: 0 }, { model: "", vram: 0 }] })
    const sampler = new HardwareSampler()
    await sampler.probeModels()
    const info = await sampler.sample(true)
    expect(info.gpus).toEqual([])
  })

  it("不传 warn 时出错也不抛", async () => {
    siCpu.mockRejectedValue(new Error("坏了"))
    const sampler = new HardwareSampler()
    await expect(sampler.probeModels()).resolves.toBeUndefined()
  })
})
