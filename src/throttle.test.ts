/**
 * 模块职责：采样节流的合流、复用与按结果定存活期
 * 依赖方向：测试文件
 * 生命周期：每个用例一个实例，用假时钟推进
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Throttled } from "./throttle.js"

describe("Throttled", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("并发的调用共用一次取数", async () => {
    const load = vi.fn(async () => 1)
    const t = new Throttled(load, 1000)
    const [a, b] = await Promise.all([t.get(), t.get()])
    expect([a, b]).toEqual([1, 1])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("存活期内复用，过期后重取；force 绕过复用", async () => {
    let n = 0
    const t = new Throttled(async () => ++n, 1000)
    expect(await t.get()).toBe(1)
    vi.advanceTimersByTime(500)
    expect(await t.get()).toBe(1)
    expect(await t.get(true)).toBe(2)
    vi.advanceTimersByTime(1000)
    expect(await t.get()).toBe(3)
  })

  it("存活期可按结果定：探不到时留得更久", async () => {
    const load = vi.fn(async (): Promise<number | undefined> => undefined)
    const t = new Throttled(load, value => (value === undefined ? 10_000 : 1000))
    await t.get()
    vi.advanceTimersByTime(5000)
    await t.get()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("取数抛错不缓存，下一次重试", async () => {
    const load = vi.fn<() => Promise<number>>().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(7)
    const t = new Throttled(load, 1000)
    await expect(t.get()).rejects.toThrow("boom")
    expect(await t.get()).toBe(7)
  })
})
