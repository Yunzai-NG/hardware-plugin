/**
 * `procfs.ts` 的用例
 *
 * 用一个临时目录冒充 `/proc`：本机多半不是 Linux，且真 `/proc` 里跑不出「进程名带括号与空格」
 * 「采样途中进程退出」这两种最容易读错的情形。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ProcTable, parseNetDev, parseProcStat } from "./procfs.js"

/**
 * 造一行 `/proc/<pid>/stat`
 * @param comm 进程名
 * @param utime 用户态时间
 * @param stime 内核态时间
 * @param start 启动时刻
 * @param rss 常驻页数
 * @returns 文件内容
 */
function statLine(comm: string, utime: number, stime: number, start: number, rss: number): string {
  // 右括号后依次是第 3 列 state 到第 24 列 rss，其余列补 0
  const cols = ["S", ...Array.from({ length: 10 }, () => "0"), utime, stime, ...Array.from({ length: 6 }, () => "0"), start, "0", rss]
  return `123 (${comm}) ${cols.join(" ")} 0 0 0\n`
}

describe("parseProcStat", () => {
  it("**进程名按最后一个右括号切**：名字里的空格与括号不让其后的列错位", () => {
    expect(parseProcStat(statLine("tmux: (server)", 30, 20, 500, 256))).toEqual({
      name: "tmux: (server)",
      ticks: 50,
      start: 500,
      rssPages: 256
    })
  })

  it("格式不对时给 undefined", () => {
    expect(parseProcStat("garbage")).toBeUndefined()
  })
})

describe("parseNetDev", () => {
  it("跳过两行表头，取第 1 列收与第 9 列发", () => {
    const text =
      "Inter-|   Receive                                                |  Transmit\n" +
      " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets\n" +
      "    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0\n" +
      "  eth0: 123456 100 0 0 0 0 0 0 654321 90 0 0 0 0 0 0\n"
    expect(parseNetDev(text)).toEqual([
      { iface: "lo", rx_bytes: 1000, tx_bytes: 1000 },
      { iface: "eth0", rx_bytes: 123456, tx_bytes: 654321 }
    ])
  })
})

describe("ProcTable", () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hw-proc-"))
    await mkdir(join(root, "self"), { recursive: true })
    // 页大小靠本进程 RSS ÷ statm 页数推得，故按 4K 页写出与真实 RSS 对得上的页数
    await writeFile(join(root, "self", "statm"), `0 ${Math.round(process.memoryUsage.rss() / 4096)} 0 0 0 0 0\n`)
    await writeFile(join(root, "uptime"), "100.00 50.00\n")
    await mkdir(join(root, "net"))
    await mkdir(join(root, "1"))
    await writeFile(join(root, "1", "stat"), statLine("init", 100, 100, 0, 100))
  })

  afterEach(async () => {
    vi.useRealTimers()
    await rm(root, { recursive: true, force: true })
  })

  it("首次采样取一生的平均：运行 100 秒用了 2 秒 CPU 即 2%", async () => {
    const got = await new ProcTable(root).sample()
    expect(got.all).toBe(1)
    expect(got.list[0]?.pcpu).toBeCloseTo(2)
    expect(got.list[0]?.memRss).toBe(100 * 4096)
  })

  it("第二次取两次之间那一段：5 秒里多用 1 秒即 20%", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const table = new ProcTable(root)
    await table.sample()
    vi.advanceTimersByTime(5000)
    await writeFile(join(root, "1", "stat"), statLine("init", 150, 150, 0, 100))
    const got = await table.sample()
    expect(got.list[0]?.pcpu).toBeCloseTo(20)
  })

  it("读到一半消失的进程跳过，不让整张表失败", async () => {
    await mkdir(join(root, "2"))
    const got = await new ProcTable(root).sample()
    expect(got.list.map(row => row.pid)).toEqual([1])
  })

  it("一个进程都读不到时抛错，由调用方退回 si", async () => {
    await rm(join(root, "1"), { recursive: true })
    await expect(new ProcTable(root).sample()).rejects.toThrow("一个进程都读不到")
  })
})
