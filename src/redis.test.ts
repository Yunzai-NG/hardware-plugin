/**
 * `redis.ts` 的用例
 *
 * **`INFO` 的解析全走真的，不 mock。** 这些是纯字符串函数，夹具就是 Redis 真实回文的
 * 片段 —— 抄一段真回文进夹具比造一个假 Map 更能挡住错：后者会让「字段名拼错」这类
 * 最常见的错照样通过。
 *
 * `fetchInfo` 那半（真 TCP 与 RESP 收包）不在此处测，理由是它要一台真 Redis；
 * 它的取舍（按声明长度收全再解析）由 `temp/check-batch18.mjs` 在真机上核对。
 */
import { describe, expect, it } from "vitest"
import { countDatabases, countKeys, hitRateOf, parseInfo, toRedisInfo } from "./redis.js"

/** 一段真实回文的节选，含注释行、空行与各类字段 */
const SAMPLE = [
  "# Server",
  "redis_version:7.2.4",
  "uptime_in_seconds:86400",
  "",
  "# Clients",
  "connected_clients:3",
  "# Memory",
  "used_memory:1048576",
  "maxmemory:0",
  "# Stats",
  "instantaneous_ops_per_sec:42",
  "keyspace_hits:900",
  "keyspace_misses:100",
  "# Keyspace",
  "db0:keys=12,expires=3,avg_ttl=0",
  "db1:keys=5,expires=0,avg_ttl=0"
].join("\r\n")

describe("parseInfo", () => {
  it("跳过注释行与空行，其余按第一个冒号切开", () => {
    const info = parseInfo(SAMPLE)
    expect(info.get("redis_version")).toBe("7.2.4")
    expect(info.get("# Server")).toBeUndefined()
    // 列出键名而不是只断言个数：数字对不上时「11 ≠ 10」说不出少了哪一个，
    // 而这份夹具日后会随字段增补而变长
    expect([...info.keys()]).toEqual([
      "redis_version",
      "uptime_in_seconds",
      "connected_clients",
      "used_memory",
      "maxmemory",
      "instantaneous_ops_per_sec",
      "keyspace_hits",
      "keyspace_misses",
      "db0",
      "db1"
    ])
  })

  it("**按第一个冒号切，不是最后一个** —— 值里本身可能带冒号", () => {
    const info = parseInfo("executable:/usr/bin/redis-server:x86_64")
    expect(info.get("executable")).toBe("/usr/bin/redis-server:x86_64")
  })

  it("冒号在行首的畸形行整行跳过，不产生空键", () => {
    expect(parseInfo(":oops\r\nok:1").has("")).toBe(false)
  })

  it("\\n 与 \\r\\n 两种换行都认", () => {
    expect(parseInfo("a:1\nb:2").size).toBe(2)
  })
})

describe("countKeys", () => {
  it("把各 db 的键数相加", () => {
    expect(countKeys(parseInfo(SAMPLE))).toBe(17)
  })

  it("一个 db 都没有时为 0（一台空 Redis）", () => {
    expect(countKeys(parseInfo("redis_version:7.2.4"))).toBe(0)
  })

  it("**只认 `db` 加数字的键**，`dbfilename` 之类不算", () => {
    expect(countKeys(parseInfo("dbfilename:keys=99"))).toBe(0)
  })
})

describe("countDatabases", () => {
  it("数在用的库，不数键", () => {
    expect(countDatabases(parseInfo(SAMPLE))).toBe(2)
  })

  it("**键数为 0 的库不算在用**，否则 databases 与 keys 会同时说着相反的话", () => {
    expect(countDatabases(parseInfo("db0:keys=0,expires=0,avg_ttl=0"))).toBe(0)
  })

  it("一个 db 都没有时为 0", () => {
    expect(countDatabases(parseInfo("redis_version:7.2.4"))).toBe(0)
  })
})

describe("hitRateOf", () => {
  it("命中 900、未命中 100 得 0.9", () => {
    expect(hitRateOf(parseInfo(SAMPLE))).toBeCloseTo(0.9, 10)
  })

  it("**两者皆 0 时不给这个数** —— 「还没被读过」与「全都没命中」是相反的两件事", () => {
    expect(hitRateOf(parseInfo("keyspace_hits:0\r\nkeyspace_misses:0"))).toBeUndefined()
  })

  it("两个字段都缺时同样不给", () => {
    expect(hitRateOf(parseInfo("redis_version:7.2.4"))).toBeUndefined()
  })

  it("全部命中时为 1", () => {
    expect(hitRateOf(parseInfo("keyspace_hits:50\r\nkeyspace_misses:0"))).toBe(1)
  })
})

describe("toRedisInfo", () => {
  it("整理出面板要的形状，秒转毫秒", () => {
    const out = toRedisInfo(parseInfo(SAMPLE))
    expect(out).toEqual({
      connected: true,
      version: "7.2.4",
      clients: 3,
      memoryUsed: 1048576,
      keys: 17,
      databases: 2,
      hitRate: 0.9,
      uptime: 86_400_000,
      ops: 42
    })
  })

  it("**`maxmemory: 0` 意为不限，此时不给 memoryMax** —— 分母为 0 的槽画不出来", () => {
    expect(toRedisInfo(parseInfo("maxmemory:0")).memoryMax).toBeUndefined()
  })

  it("设了 maxmemory 时照常给出", () => {
    expect(toRedisInfo(parseInfo("maxmemory:2097152")).memoryMax).toBe(2_097_152)
  })

  it("非数字的字段当作缺失，不产生 NaN", () => {
    const out = toRedisInfo(parseInfo("connected_clients:many\r\nused_memory:?"))
    expect(out.clients).toBeUndefined()
    expect(out.memoryUsed).toBeUndefined()
  })

  it("一份空回文仍给出 connected 与 keys，其余一概不出现", () => {
    expect(toRedisInfo(parseInfo(""))).toEqual({ connected: true, keys: 0 })
  })
})
