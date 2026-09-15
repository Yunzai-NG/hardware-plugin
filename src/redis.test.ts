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
import {
  countDatabases,
  countKeys,
  encodeCommand,
  explainRedisError,
  hitRateOf,
  parseInfo,
  readReply,
  toRedisInfo
} from "./redis.js"

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

describe("encodeCommand", () => {
  it("拼成 RESP 数组", () => {
    expect(encodeCommand("INFO")).toBe("*1\r\n$4\r\nINFO\r\n")
    expect(encodeCommand("AUTH", "pw")).toBe("*2\r\n$4\r\nAUTH\r\n$2\r\npw\r\n")
  })

  it("**长度按字节算而不是按字符** —— 否则中文密码会被对方截成半个字符", () => {
    // 「密」是 3 字节
    expect(encodeCommand("AUTH", "密")).toBe("*2\r\n$4\r\nAUTH\r\n$3\r\n密\r\n")
  })
})

describe("readReply", () => {
  /**
   * 造一个缓冲
   * @param text 原文
   * @returns 缓冲
   */
  const buf = (text: string): Buffer => Buffer.from(text, "utf8")

  it("读简单字符串，并给出下一条的起点", () => {
    const reply = readReply(buf("+OK\r\n$2\r\nhi\r\n"))
    expect(reply).toMatchObject({ text: "OK", failed: false })
    // 从那个起点接着读，拿到的是第二条 —— 流水线时靠这条才不会错位
    const next = readReply(buf("+OK\r\n$2\r\nhi\r\n"), reply?.next)
    expect(next?.text).toBe("hi")
  })

  it("读批量字符串，正文里的 \\r\\n 不当作结束", () => {
    const body = "a\r\nb"
    const reply = readReply(buf(`$${body.length}\r\n${body}\r\n`))
    expect(reply?.text).toBe(body)
    expect(reply?.failed).toBe(false)
  })

  it("错误回复标为 failed，正文去掉前导减号", () => {
    expect(readReply(buf("-NOAUTH Authentication required.\r\n"))).toMatchObject({
      text: "NOAUTH Authentication required.",
      failed: true
    })
  })

  it("整数回复读得出", () => {
    expect(readReply(buf(":12\r\n"))).toMatchObject({ text: "12", failed: false })
  })

  it("**`$-1` 是 nil，不是错误** —— 一条命令正常地什么都没返回", () => {
    expect(readReply(buf("$-1\r\n"))).toMatchObject({ text: "", failed: false })
  })

  it("字节还不够时给 undefined，等下一个包", () => {
    // 声明 10 字节却只到了 2 个
    expect(readReply(buf("$10\r\nhi"))).toBeUndefined()
    // 连首行都没收完
    expect(readReply(buf("$10"))).toBeUndefined()
  })

  it("**尾部的 \\r\\n 也要等** —— 不等它下一条的起点会偏两个字节", () => {
    expect(readReply(buf("$2\r\nhi"))).toBeUndefined()
    expect(readReply(buf("$2\r\nhi\r\n"))?.next).toBe(8)
  })

  it("认不出的前缀作错误，不静默当成空正文", () => {
    expect(readReply(buf("?什么\r\n"))?.failed).toBe(true)
  })
})

describe("explainRedisError", () => {
  it("NOAUTH 指向「该填密码」", () => {
    expect(explainRedisError("NOAUTH Authentication required.")).toContain("要密码")
  })

  it("WRONGPASS 指向「密码或用户名不对」", () => {
    expect(explainRedisError("WRONGPASS invalid username-password pair")).toContain("不对")
  })

  it("**「没设密码却填了密码」单独一句** —— 与密码错是相反的处置", () => {
    expect(
      explainRedisError("ERR Client sent AUTH, but no password is set. Did you mean AUTH <username> <password>?")
    ).toContain("清空")
  })

  it("LOADING 说明稍后即可，不是配置错", () => {
    expect(explainRedisError("LOADING Redis is loading the dataset in memory")).toContain("稍后")
  })

  it("认不出的原样返回，不吞掉信息", () => {
    expect(explainRedisError("ERR 某个新错误")).toBe("ERR 某个新错误")
  })
})
