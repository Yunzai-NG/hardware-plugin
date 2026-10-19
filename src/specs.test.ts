/**
 * `specs.ts` 的用例
 *
 * 断言的重点：占位串与空值不出行、序列号一类不出现、首次请求不等探测、探完记住。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

// vi.mock 会被提到文件顶部，它用到的东西须经 vi.hoisted 一并提上去
const { calls, mock } = vi.hoisted(() => {
  const calls = vi.fn<(name: string) => void>()
  const mock = (name: string, value: unknown) => (): Promise<unknown> => {
    calls(name)
    return Promise.resolve(value)
  }
  return { calls, mock }
})

vi.mock("systeminformation", () => ({
  default: {
    cpu: mock("cpu", { manufacturer: "AMD", brand: "Ryzen 7 6800H", physicalCores: 8, cores: 16, speed: 3.2, speedMax: 4.79, socket: "FP7", cache: { l1d: 262144, l1i: 262144, l2: 4194304, l3: 16777216 }, virtualization: true, stepping: "1" }),
    mem: mock("mem", { total: 17179869184 }),
    memLayout: mock("memLayout", [
      { size: 8589934592, bank: "DIMM 0", type: "LPDDR5", clockSpeed: 6400, manufacturer: "Samsung", serialNum: "S3CR3T" },
      { size: 0, bank: "DIMM 1" }
    ]),
    system: mock("system", { manufacturer: "LENOVO", model: "82SN", serial: "PF-SERIAL", uuid: "UUID-1" }),
    baseboard: mock("baseboard", { manufacturer: "LENOVO", model: "LNVNB161216", memSlots: 2, serial: "MB-SERIAL" }),
    bios: mock("bios", { vendor: "LENOVO", version: "JNCN38WW", releaseDate: "2023-05-10" }),
    chassis: mock("chassis", { type: "Notebook", serial: "To be filled by O.E.M." }),
    graphics: mock("graphics", { controllers: [{ vendor: "AMD", model: "Radeon Graphics", vram: 2048, driverVersion: "31.0" }], displays: [{ builtin: true, currentResX: 2560, currentResY: 1600, currentRefreshRate: 165 }] }),
    diskLayout: mock("diskLayout", [{ vendor: "SAMSUNG", name: "MZVL21T0", size: 1024 ** 4, interfaceType: "NVMe", type: "SSD", smartStatus: "Ok", serialNum: "DISK-SN" }]),
    osInfo: mock("osInfo", { distro: "Windows 11", release: "10.0.26200", arch: "x64", uefi: true, serial: "OS-SERIAL" }),
    networkInterfaces: mock("networkInterfaces", [
      { iface: "WLAN", type: "wireless", operstate: "up", speed: 1200, mac: "aa:bb:cc:dd:ee:ff", dhcp: true },
      { iface: "lo", internal: true },
      { iface: "vEthernet", virtual: true }
    ])
  }
}))

const { SpecsSampler, sizeText, textOf, toSpecs } = await import("./specs.js")

describe("textOf / sizeText", () => {
  it("占位串与空白当作没有，数字原样", () => {
    expect(textOf("To be filled by O.E.M.")).toBeUndefined()
    expect(textOf("Default string")).toBeUndefined()
    expect(textOf("  ")).toBeUndefined()
    expect(textOf(0)).toBe("0")
    expect(textOf(" LENOVO ")).toBe("LENOVO")
  })

  it("字节按 1024 进位", () => {
    expect(sizeText(17179869184)).toBe("16 GB")
    expect(sizeText(262144)).toBe("256 KB")
    expect(sizeText(1.5 * 1024 ** 3)).toBe("1.5 GB")
    expect(sizeText(0)).toBeUndefined()
  })
})

describe("SpecsSampler", () => {
  beforeEach(() => {
    calls.mockClear()
  })

  it("**首次不等探测**，探完之后给整份并记住", async () => {
    const sampler = new SpecsSampler()
    const warn = vi.fn()
    expect(sampler.sample(warn)).toEqual({ ready: false, sections: [] })
    await vi.waitFor(() => expect(sampler.sample(warn).ready).toBe(true))
    const before = calls.mock.calls.length
    sampler.sample(warn)
    expect(calls.mock.calls.length).toBe(before)
    expect(warn).not.toHaveBeenCalled()
  })

  it("**序列号、UUID、MAC 一律不出**", async () => {
    const sampler = new SpecsSampler()
    await vi.waitFor(() => expect(sampler.sample(vi.fn()).ready).toBe(true))
    const text = JSON.stringify(sampler.sample(vi.fn()))
    for (const secret of ["S3CR3T", "PF-SERIAL", "UUID-1", "MB-SERIAL", "DISK-SN", "OS-SERIAL", "aa:bb:cc"]) {
      expect(text).not.toContain(secret)
    }
  })

  it("各节按预期整理；空容量的内存条与虚拟、回环网卡丢掉", async () => {
    const sampler = new SpecsSampler()
    await vi.waitFor(() => expect(sampler.sample(vi.fn()).ready).toBe(true))
    const { sections } = sampler.sample(vi.fn())
    const byId = new Map(sections.map(section => [section.id, section]))
    expect(byId.get("cpu")?.rows).toEqual(
      expect.arrayContaining([
        ["型号", "AMD Ryzen 7 6800H"],
        ["核心 / 线程", "8 / 16"],
        ["基础 / 最高频率", "3.2 / 4.79 GHz"],
        ["缓存", "L1d 256 KB · L1i 256 KB · L2 4 MB · L3 16 MB"],
        ["虚拟化", "支持"]
      ])
    )
    expect(byId.get("memory")?.rows).toEqual(expect.arrayContaining([["插槽", "1 / 2 已用"]]))
    expect(byId.get("memory")?.items).toHaveLength(1)
    expect(byId.get("disk")?.items?.[0]?.rows).toEqual(expect.arrayContaining([["健康", "正常"]]))
    expect(byId.get("net")?.items?.map(item => item.title)).toEqual(["WLAN"])
    expect(byId.get("os")?.rows?.some(([name]) => name === "时区")).toBe(true)
  })
})

describe("toSpecs", () => {
  it("一行都没有的节不出现", () => {
    expect(toSpecs({ chassis: { type: "Unknown" } })).toEqual([])
  })
})
