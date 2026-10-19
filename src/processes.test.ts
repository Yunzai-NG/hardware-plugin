/**
 * `processes.ts` 的用例
 *
 * 重点是 **`pcpu` 的换算**。`si.processes()` 给的是「占单核的百分比」，在一台 16 核的
 * 机器上一个吃满两核的进程给 200 —— 直接除以 100 会得到 200%，而正确答案是 12.5%。
 * 这一处错了不会报错，只表现为「进程表里的数加起来远超 100%」，而使用者多半会以为
 * 那是正常的（任务管理器在某些视图下正是这么显示的）。故用例直接喂夹具，不靠真机。
 */
import { describe, expect, it, vi } from "vitest"

const siProcesses = vi.fn<() => Promise<unknown>>()

vi.mock("systeminformation", () => ({
  default: { processes: (): Promise<unknown> => siProcesses() }
}))

const { TOP_N, sampleProcesses, toProcesses } = await import("./processes.js")

describe("toProcesses", () => {
  it("**pcpu 除以核数**：16 核上吃满两核（pcpu 200）是 12.5%，不是 200%", () => {
    const out = toProcesses([{ pid: 1, name: "a", pcpu: 200 }], 1, 16, 999)
    expect(out.top[0]?.cpu).toBeCloseTo(0.125)
  })

  it("单核机器上 pcpu 50 即 50%", () => {
    expect(toProcesses([{ pid: 1, name: "a", pcpu: 50 }], 1, 1, 999).top[0]?.cpu).toBeCloseTo(0.5)
  })

  it("**换算后仍夹到 1**：采样窗口错位会让 pcpu 超过核数乘 100", () => {
    expect(toProcesses([{ pid: 1, name: "a", pcpu: 5000 }], 1, 4, 999).top[0]?.cpu).toBe(1)
  })

  it("核数取不到或为 0 时按 1 算，不产出 NaN 或除零", () => {
    expect(toProcesses([{ pid: 1, name: "a", pcpu: 50 }], 1, 0, 999).top[0]?.cpu).toBeCloseTo(0.5)
    expect(
      toProcesses([{ pid: 1, name: "a", pcpu: 50 }], 1, Number.NaN, 999).top[0]?.cpu
    ).toBeCloseTo(0.5)
  })

  it("pcpu 缺失或为负时记 0 —— 这一处 0 是对的，进程确实没在用 CPU", () => {
    expect(toProcesses([{ pid: 1, name: "a" }], 1, 4, 999).top[0]?.cpu).toBe(0)
    expect(toProcesses([{ pid: 2, name: "b", pcpu: -5 }], 1, 4, 999).top[0]?.cpu).toBe(0)
  })

  it("**标出本进程**，好让使用者在表里认出机器人自己", () => {
    const out = toProcesses(
      [
        { pid: 100, name: "node", pcpu: 10 },
        { pid: 200, name: "chrome", pcpu: 20 }
      ],
      2,
      4,
      100
    )
    expect(out.top.find(item => item.pid === 100)?.self).toBe(true)
    // 别人的进程不带这个字段，而不是 self: false —— 少一个字段比多一个假值好读
    expect(out.top.find(item => item.pid === 200)?.self).toBeUndefined()
  })

  it("按 CPU 降序，CPU 相同则按内存降序", () => {
    const out = toProcesses(
      [
        { pid: 1, name: "low", pcpu: 10, memRss: 100 },
        { pid: 2, name: "high", pcpu: 90, memRss: 1 },
        { pid: 3, name: "tie", pcpu: 10, memRss: 500 }
      ],
      3,
      1,
      999
    )
    expect(out.top.map(item => item.name)).toEqual(["high", "tie", "low"])
  })

  /*
   * 条数一律由 `TOP_N` 推出，不写死数字
   *
   * 这个数会随卡片的默认高度调整（初版 12，实测溢出后改为 8）。写死的话，每次调整
   * 都要改产品与用例两处，而漏改的那一处正是断言 —— 于是用例开始报错，而报错的原因
   * 与它要验的事（截断本身）无关。
   */
  it("只留前若干条 —— 一台机器几百个进程，全给等于让浏览器渲染一张没人看的表", () => {
    const many = Array.from({ length: 50 }, (_unused, i) => ({ pid: i + 1, name: `p${i}`, pcpu: i }))
    const out = toProcesses(many, 50, 1, 999)
    expect(out.top).toHaveLength(TOP_N)
    // 总数仍是真实的 50，不是截断后的条数：使用者要知道「一共多少」
    expect(out.total).toBe(50)
  })

  /*
   * 这一条钉住的是真机上实际发生过的失败
   *
   * 上面那条「标出本进程」的用例里，本进程恰好在表内 —— 而机器人多数时候闲着，
   * `pcpu` 为 0，在三百多个进程的机器上排到两百名之后。初版只给排进来的那条置标记，
   * 于是「标出自己」恰在最常见的情形下不生效。首轮真浏览器核对正是在此处发现
   *「没有 self 标记」的。
   */
  it("**本进程闲着排不进前若干名时，仍补在表末** —— 这是真机上的常态，不是边缘情形", () => {
    const busy = Array.from({ length: 40 }, (_unused, i) => ({ pid: i + 1, name: `p${i}`, pcpu: 50 }))
    const idleSelf = { pid: 4242, name: "node", pcpu: 0, memRss: 90_000_000 }
    const out = toProcesses([...busy, idleSelf], 41, 1, 4242)

    const own = out.top.find(row => row.self === true)
    expect(own?.pid).toBe(4242)
    // 比 TOP_N 多一条：前若干名照旧，本进程补在其后
    expect(out.top).toHaveLength(TOP_N + 1)
    // **补在末尾，不是提到表首** —— 表的语义是「占用最高的若干个」，
    // 把一个 0% 的进程排到第一行会让这张表不再是按占用排序的
    expect(out.top.at(-1)?.self).toBe(true)
  })

  it("本进程不在 list 里时（权限不足看不到自己）不硬造一条", () => {
    const out = toProcesses([{ pid: 1, name: "a", pcpu: 1 }], 1, 1, 4242)
    expect(out.top).toHaveLength(1)
    expect(out.top.some(row => row.self === true)).toBe(false)
  })

  it("没有 pid 的条目丢掉；没有名字时用 pid 顶上", () => {
    const out = toProcesses([{ name: "无 pid", pcpu: 1 }, { pid: 7, pcpu: 1 }], 2, 1, 999)
    expect(out.top).toHaveLength(1)
    expect(out.top[0]?.name).toBe("7")
  })

  it("内存为 0 或缺失时不出现该字段", () => {
    expect(toProcesses([{ pid: 1, name: "a", pcpu: 1, memRss: 0 }], 1, 1, 999).top[0]?.memory).toBeUndefined()
    expect(toProcesses([{ pid: 1, name: "a", pcpu: 1 }], 1, 1, 999).top[0]?.memory).toBeUndefined()
  })
})

describe("sampleProcesses", () => {
  it("si 的 KiB 转成字节，/proc 的字节不重复放大", async () => {
    siProcesses.mockResolvedValue({ all: 1, list: [{ pid: 7, name: "node", memRss: 80 * 1024 }] })
    expect((await sampleProcesses(() => {})).top[0]?.memory).toBe(80 * 1024 * 1024)
    expect(toProcesses([{ pid: 7, memRss: 80 * 1024 * 1024 }], 1, 1, 999).top[0]?.memory).toBe(80 * 1024 * 1024)
  })
  it("探不到时给「总数 0、表为空」并记一句，不抛错", async () => {
    siProcesses.mockRejectedValue(new Error("permission denied"))
    const warn = vi.fn()
    expect(await sampleProcesses(warn)).toEqual({ total: 0, top: [] })
    expect(warn).toHaveBeenCalledOnce()
  })

  it("总数取自 `all` 而不是 list 的长度 —— 库在某些平台上只给前若干条", async () => {
    siProcesses.mockResolvedValue({ all: 312, list: [{ pid: 1, name: "a", pcpu: 1 }] })
    expect((await sampleProcesses(() => {})).total).toBe(312)
  })

  it("`all` 缺失时退回 list 的长度", async () => {
    siProcesses.mockResolvedValue({ list: [{ pid: 1, name: "a", pcpu: 1 }] })
    expect((await sampleProcesses(() => {})).total).toBe(1)
  })
})
