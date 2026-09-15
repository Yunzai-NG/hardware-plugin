/**
 * 模块职责：Redis 监控 —— 连一次、发 `INFO`、把回文解析成几个可显示的数
 * 依赖方向：只依赖 node 的 `net`；**不引 redis 客户端库**
 * 生命周期：每次采样各建一条短连接，用完即关
 * 注意事项：不引 redis 客户端库：要做的只是发一条 `INFO`（RESP 里是 `*1\r\n$4\r\nINFO\r\n`）读回一段
 *          文本，而客户端库带来的连接池、集群、Lua 与数百 KB 产物没有一项用得上 —— 面板插件包的依赖
 *          要使用者自己装。
 *
 *          短连接不常驻：采样 5 秒一次，本机握手是亚毫秒级，常驻换不来可测的提升，却要维护断线重连、
 *          心跳与退出清理三类状态。
 *
 *          连不上是一种状态而非错误：多数部署没有 Redis，此时显示「未连接」并说明原因；该报警的是
 *          「配置了却连不上」。
 *
 *          `INFO` 回文只取要显示的那几个字段：它有上百个且随版本变动，全解析等于维护一份版本兼容表。
 */
import { createConnection } from "node:net"

/** 默认连接地址：Redis 的约定端口 */
export const DEFAULT_HOST = "127.0.0.1"

/** 默认端口 */
export const DEFAULT_PORT = 6379

/**
 * 连接与读取的超时
 *
 * 取 1.5 秒：本机 Redis 的 `INFO` 是毫秒级的，而没有 Redis 时连接会立刻被拒
 * （ECONNREFUSED，不必等超时）。这个数只用于兜住「地址可达但对方不回话」那种情形 ——
 * 一个防火墙丢包的地址会让请求悬着，而面板 5 秒一拍，悬 5 秒以上就会拖住整份快照。
 */
const TIMEOUT_MS = 1500

/** Redis 的运行状况 */
export interface RedisInfo {
  /** 是否连上了 */
  readonly connected: boolean
  /** 连不上时的原因，如 `ECONNREFUSED` */
  readonly reason?: string
  /** 版本号，如 `7.2.4` */
  readonly version?: string
  /** 当前客户端连接数 */
  readonly clients?: number
  /** 已用内存（字节） */
  readonly memoryUsed?: number
  /** 内存上限（字节）；未设 `maxmemory` 时不出现 */
  readonly memoryMax?: number
  /** 键总数（全部 db 之和） */
  readonly keys?: number
  /**
   * 装着键的库数
   *
   * 与 `keys` 分开给：一台「16 个库、键都在 db0」的实例与一台「键摊在 5 个库里」的实例，
   * 键总数可能一样，而后者上一句 `FLUSHDB` 只清掉五分之一 —— 面板上区分得出这件事。
   * 空库不计入，故它答的是「有几个库在用」而非 `databases` 配置项。
   */
  readonly databases?: number
  /** 命中率（0-1）；累计命中与未命中都为 0 时不出现 */
  readonly hitRate?: number
  /** 运行时长（毫秒） */
  readonly uptime?: number
  /** 每秒处理的命令数 */
  readonly ops?: number
}

/**
 * 把 `INFO` 的回文解析成键值表
 *
 * 回文形如 `# Server\r\nredis_version:7.2.4\r\n...`。注释行（`#` 开头）与空行跳过。
 * @param text `INFO` 的回文
 * @returns 键值表
 */
export function parseInfo(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    if (line === "" || line.startsWith("#")) continue
    const at = line.indexOf(":")
    if (at <= 0) continue
    out.set(line.slice(0, at), line.slice(at + 1))
  }
  return out
}

/**
 * 取一个数字字段
 * @param info 键值表
 * @param key 字段名
 * @returns 数值；缺失或非数时 undefined
 */
function num(info: Map<string, string>, key: string): number | undefined {
  const raw = info.get(key)
  if (raw === undefined) return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

/**
 * 数出全部 db 的键总数
 *
 * `INFO` 里每个 db 一行，形如 `db0:keys=12,expires=3,avg_ttl=0`。
 * @param info 键值表
 * @returns 键总数；一个 db 都没有时为 0
 */
export function countKeys(info: Map<string, string>): number {
  let total = 0
  for (const [key, value] of info) {
    if (!/^db\d+$/.test(key)) continue
    const found = /keys=(\d+)/.exec(value)
    if (found !== null) total += Number(found[1])
  }
  return total
}

/**
 * 数出有几个库装着键
 *
 * 只数 `keys=` 大于 0 的那些：`INFO` 压根不给空库的行，而给了行却写 `keys=0` 的实例
 * （某些代理层）会让「有几个库在用」多算。
 * @param info 键值表
 * @returns 非空库的数目
 */
export function countDatabases(info: Map<string, string>): number {
  let count = 0
  for (const [key, value] of info) {
    if (!/^db\d+$/.test(key)) continue
    const found = /keys=(\d+)/.exec(value)
    if (found !== null && Number(found[1]) > 0) count += 1
  }
  return count
}

/**
 * 算命中率
 *
 * 两者皆为 0 时返回 undefined 而非 0：那意味着这台 Redis 还没被读过，
 * 而「命中率 0%」会被读成「缓存全都没命中」—— 那是两件相反的事。
 * @param info 键值表
 * @returns 命中率（0-1）
 */
export function hitRateOf(info: Map<string, string>): number | undefined {
  const hits = num(info, "keyspace_hits") ?? 0
  const misses = num(info, "keyspace_misses") ?? 0
  const total = hits + misses
  return total <= 0 ? undefined : hits / total
}

/**
 * 把键值表整理成面板要的形状
 * @param info 键值表
 * @returns Redis 运行状况
 */
export function toRedisInfo(info: Map<string, string>): RedisInfo {
  const maxMemory = num(info, "maxmemory")
  const uptimeSec = num(info, "uptime_in_seconds")
  const hitRate = hitRateOf(info)
  const version = info.get("redis_version")
  const clients = num(info, "connected_clients")
  const used = num(info, "used_memory")
  const ops = num(info, "instantaneous_ops_per_sec")
  const databases = countDatabases(info)

  return {
    connected: true,
    ...(version === undefined || version === "" ? {} : { version }),
    ...(clients === undefined ? {} : { clients }),
    ...(used === undefined ? {} : { memoryUsed: used }),
    // maxmemory 为 0 意为「不限」，此时不给这个字段 —— 画一条分母为 0 的槽毫无意义
    ...(maxMemory === undefined || maxMemory <= 0 ? {} : { memoryMax: maxMemory }),
    keys: countKeys(info),
    // 0 个在用的库不给这个字段：一台刚起来、还没写过任何键的实例上「0 个库」说不清
    // 是「没在用」还是「探不到」，而前者由 keys 那一项已经答了
    ...(databases <= 0 ? {} : { databases }),
    ...(hitRate === undefined ? {} : { hitRate }),
    ...(uptimeSec === undefined ? {} : { uptime: Math.round(uptimeSec * 1000) }),
    ...(ops === undefined ? {} : { ops })
  }
}

/**
 * 拼一条 RESP 命令
 *
 * 长度按**字节**算而不是按字符（`Buffer.byteLength`）：密码里出现一个中文字符时，
 * 按字符算会让声明的长度比实际短，对方按声明截断后拿到半个字符 —— 表现是「密码明明
 * 是对的却说密码错」。
 * @param args 命令与其参数
 * @returns RESP 文本
 */
export function encodeCommand(...args: readonly string[]): string {
  const body = args.map(arg => `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`).join("")
  return `*${args.length}\r\n${body}`
}

/** 一条 RESP 回复 */
export interface RedisReply {
  /** 正文；错误回复时是错误原文（已去掉前导 `-`） */
  readonly text: string
  /** 是否为错误回复 */
  readonly failed: boolean
  /** 本条之后的下标，下一条回复从此处起 */
  readonly next: number
}

/**
 * 从缓冲里读一条回复；不完整时给 undefined
 *
 * **要能读多条**，不是只读一个批量字符串：带密码时一次连接要发 `AUTH` 与 `INFO` 两条命令
 * （流水线发出，省一个往返），于是回来的是「`+OK`，紧接着一个批量字符串」。原先的实现
 * 只认 `$`，那份 `+OK` 会被当成「回复不是批量字符串」而报错。
 *
 * 批量字符串**连尾部的 `\r\n` 一起等**：不等它的话下一条回复的起点会偏两个字节，
 * 而偏移之后读到的是 `\r\n+OK` 这种东西 —— 单条回复时看不出问题，流水线时必然错。
 * @param all 已收到的全部字节
 * @param from 从哪个下标开始读
 * @returns 一条回复；字节还不够时 undefined
 */
export function readReply(all: Buffer, from = 0): RedisReply | undefined {
  const head = all.indexOf("\r\n", from)
  if (head < 0) return undefined

  const line = all.subarray(from, head).toString("latin1")
  const tag = line.slice(0, 1)
  const body = line.slice(1)
  const after = head + 2

  // 简单字符串（`+OK`）与整数（`:12`）在首行里就说完了
  if (tag === "+" || tag === ":") return { text: body, failed: false, next: after }
  if (tag === "-") return { text: body, failed: true, next: after }
  if (tag !== "$") {
    return { text: `无法识别的 RESP 回复：${line.slice(0, 40)}`, failed: true, next: after }
  }

  const length = Number(body)
  if (!Number.isFinite(length)) {
    return { text: "回复声明的长度不是数字", failed: true, next: after }
  }
  // `$-1` 是 nil，不是错误 —— 一条命令正常地什么都没返回
  if (length < 0) return { text: "", failed: false, next: after }
  if (all.length < after + length + 2) return undefined
  return { text: all.subarray(after, after + length).toString("utf8"), failed: false, next: after + length + 2 }
}

/** 连 Redis 时的身份 */
export interface RedisAuth {
  /** 密码；留空即不鉴权 */
  readonly password?: string
  /** 用户名，Redis 6 起的 ACL 才有；留空则按 `AUTH <密码>` 的老形式发 */
  readonly username?: string
}

/**
 * 把 Redis 的错误回复翻成一句能照着做的话
 *
 * 原文是给程序看的（`NOAUTH Authentication required.`），照搬到面板上等于让使用者
 * 自己去搜。这几种恰好都是**配置填错**，而错在哪一项这里说得出来。
 * @param raw 错误回复原文
 * @returns 人话；认不出时原样返回
 */
export function explainRedisError(raw: string): string {
  const upper = raw.toUpperCase()
  if (upper.startsWith("NOAUTH")) return "这台 Redis 要密码，请在插件配置里填「密码」一项"
  if (upper.startsWith("WRONGPASS")) return "密码或用户名不对"
  // 没设 requirepass 的实例收到 AUTH 时的原话是
  // `ERR Client sent AUTH, but no password is set. Did you mean AUTH <username> <password>?`
  if (upper.includes("NO PASSWORD IS SET")) return "这台 Redis 没设密码，请把配置里的「密码」清空"
  if (upper.startsWith("LOADING")) return "Redis 正在从磁盘载入数据，稍后即可"
  if (upper.startsWith("BUSY")) return "Redis 正忙于执行一个脚本"
  if (upper.startsWith("MASTERDOWN")) return "这是一个从库，而它的主库当前不可达"
  return raw
}

/**
 * 连一次 Redis 并取回 `INFO` 的原文
 *
 * 手写 RESP 的两个方向：发出去的是数组形式的命令，收回来逐条按 {@link readReply} 解析。
 * 有密码时 `AUTH` 与 `INFO` **一次写出**（流水线），省掉一个往返 —— 本机往返虽只有零点几
 * 毫秒，但远端 Redis 上两个往返就是两倍延迟，而这个函数被 5 秒一次地调用。
 * @param host 主机
 * @param port 端口
 * @param auth 身份；不给或密码为空即不鉴权
 * @returns `INFO` 的正文
 */
export function fetchInfo(host: string, port: number, auth: RedisAuth = {}): Promise<string> {
  const password = auth.password ?? ""
  const username = auth.username ?? ""

  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port })
    socket.setTimeout(TIMEOUT_MS)

    /** 已收到的字节 */
    const chunks: Buffer[] = []

    /**
     * 收尾：关掉连接并只回一次
     * @param err 出错原因；成功时 undefined
     * @param text 正文
     */
    const done = (err: Error | undefined, text?: string): void => {
      socket.removeAllListeners()
      socket.destroy()
      if (err !== undefined) reject(err)
      else resolve(text ?? "")
    }

    socket.on("connect", () => {
      const auths =
        password === ""
          ? ""
          : username === ""
            ? encodeCommand("AUTH", password)
            : encodeCommand("AUTH", username, password)
      socket.write(`${auths}${encodeCommand("INFO")}`)
    })

    socket.on("data", buf => {
      chunks.push(buf)
      const all = Buffer.concat(chunks)

      /*
       * 逐条读，`AUTH` 那条的回复先落地
       *
       * 两条回复未必在同一个 TCP 包里到达，故每次 `data` 都从头重读一遍 —— 状态只有
       * 「收到的字节」这一份，不必另记「读到第几条了」。`INFO` 的正文只有几千字节，
       * 重读的代价可忽略。
       */
      let at = 0
      if (password !== "") {
        const ok = readReply(all, at)
        if (ok === undefined) return
        if (ok.failed) {
          done(new Error(explainRedisError(ok.text)))
          return
        }
        at = ok.next
      }

      const info = readReply(all, at)
      if (info === undefined) return
      if (info.failed) {
        done(new Error(explainRedisError(info.text)))
        return
      }
      done(undefined, info.text)
    })

    socket.on("timeout", () => done(new Error("ETIMEDOUT")))
    socket.on("error", err => done(err))
    socket.on("close", () => done(new Error("连接被对方关闭")))
  })
}

/**
 * 采一次 Redis 状况
 *
 * **连不上时不抛错**，返回 `connected: false` 加一句原因 —— 理由见文件头：
 * 多数部署没有 Redis，那是常态而非故障。
 * @param host 主机，缺省 `127.0.0.1`
 * @param port 端口，缺省 6379
 * @param auth 身份；不给或密码为空即不鉴权
 * @returns Redis 运行状况
 */
export async function sampleRedis(
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  auth: RedisAuth = {}
): Promise<RedisInfo> {
  try {
    return toRedisInfo(parseInfo(await fetchInfo(host, port, auth)))
  } catch (err) {
    const code = (err as { code?: string }).code
    return {
      connected: false,
      // 错误码优先（`ECONNREFUSED` 便于搜索），鉴权那类没有码，用已经翻好的那句
      reason: code ?? (err instanceof Error ? err.message : String(err))
    }
  }
}
