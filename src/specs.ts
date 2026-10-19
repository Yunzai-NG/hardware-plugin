/**
 * 模块职责：「完整配置」—— 处理器、内存条、主板与固件、显卡与显示器、存储设备、系统、网络适配器
 * 依赖方向：只依赖 `systeminformation` 与 node 内置模块；不认识 HTTP，也不认识面板
 * 生命周期：`SpecsSampler` 随插件建立一份；**只在有人打开配置清单时才探**，探完记住
 * 注意事项：**整份由 node 侧整理成「分节 → 行」再给浏览器。** 浏览器侧只管画，不必认识
 *          systeminformation 的几十个字段；字段改名或某平台给不出时，改这一处即可。
 *
 *          **序列号、UUID、MAC 一律不出。** 面板可能经内网地址给别人看，而这几样能唯一认出这台
 *          机器或这块网卡，对「看配置」毫无用处。IP 也不在这里 —— 那归「系统信息」那一枚。
 *
 *          **只探一次。** 十来项合计要起若干子进程（Windows 上是 PowerShell），耗时数秒；配置在
 *          一次运行里不会变，换了内存条重载一次 webui 即可。首次请求不等它探完，先回 `ready: false`。
 *
 *          探不到、或厂商留了占位串（「To be filled by O.E.M.」一类）的项一律不出现，不填「未知」。
 */
import si from "systeminformation"
import type { Systeminformation } from "systeminformation"

/** 一行：名与值 */
export type SpecRow = readonly [string, string]

/** 一节里的一个子项，如一根内存条、一块硬盘 */
export interface SpecItem {
  /** 子项名，如内存条的插槽、硬盘的型号 */
  readonly title: string
  /** 该子项的各行 */
  readonly rows: readonly SpecRow[]
}

/** 一节 */
export interface SpecSection {
  /** 节标识，浏览器按它挑图标 */
  readonly id: string
  /** 节名 */
  readonly title: string
  /** 整节共有的行 */
  readonly rows?: readonly SpecRow[]
  /** 节内的子项 */
  readonly items?: readonly SpecItem[]
}

/** 完整配置 */
export interface Specs {
  /** 是否已探完；为假时 `sections` 为空 */
  readonly ready: boolean
  /** 各节；一行都没有的节不出现 */
  readonly sections: readonly SpecSection[]
}

/** 探到的原始数据；每一项都可能缺（那一路探测失败） */
export interface SpecsRaw {
  /** `si.cpu()` */
  readonly cpu?: Partial<Systeminformation.CpuData>
  /** `si.mem()` */
  readonly mem?: Partial<Systeminformation.MemData>
  /** `si.memLayout()` */
  readonly memLayout?: readonly Partial<Systeminformation.MemLayoutData>[]
  /** `si.system()` */
  readonly system?: Partial<Systeminformation.SystemData>
  /** `si.baseboard()` */
  readonly baseboard?: Partial<Systeminformation.BaseboardData>
  /** `si.bios()` */
  readonly bios?: Partial<Systeminformation.BiosData>
  /** `si.chassis()` */
  readonly chassis?: Partial<Systeminformation.ChassisData>
  /** `si.graphics()` */
  readonly graphics?: {
    /** 显卡 */
    readonly controllers?: readonly Partial<Systeminformation.GraphicsControllerData>[]
    /** 显示器 */
    readonly displays?: readonly Partial<Systeminformation.GraphicsDisplayData>[]
  }
  /** `si.diskLayout()` */
  readonly disks?: readonly Partial<Systeminformation.DiskLayoutData>[]
  /** `si.osInfo()` */
  readonly os?: Partial<Systeminformation.OsData>
  /** `si.networkInterfaces()` */
  readonly nets?: readonly Partial<Systeminformation.NetworkInterfacesData>[]
  /** 时区名与 UTC 偏移（分钟，东为正） */
  readonly timezone?: {
    /** IANA 名，如 `Asia/Shanghai` */
    readonly name: string
    /** 偏移分钟数 */
    readonly offset: number
  }
}

/** 厂商留的占位串，见到即当作没有 */
const PLACEHOLDER = /^(to be filled by o\.?e\.?m\.?|default string|system (product name|manufacturer|version)|not (applicable|specified|available)|unknown|none|n\/a|0+|-)$/i

/**
 * 一个值是否有内容
 * @param value 任意值
 * @returns 去掉首尾空白后的串；空串、占位串与非字符串一律 undefined
 */
export function textOf(value: unknown): string | undefined {
  // 数字原样给（步进 0 是真值），占位串只出现在字符串里
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : undefined
  if (typeof value !== "string") return undefined
  const text = value.trim()
  return text === "" || PLACEHOLDER.test(text) ? undefined : text
}

/**
 * 拼几段，空段丢掉
 * @param parts 各段
 * @param sep 分隔
 * @returns 拼好的串；全空时 undefined
 */
function join(parts: readonly unknown[], sep = " "): string | undefined {
  const kept = parts.map(textOf).filter((part): part is string => part !== undefined)
  return kept.length === 0 ? undefined : kept.join(sep)
}

/**
 * 字节数 → 「16 GB」这类写法，1024 进位
 * @param value 字节数
 * @returns 文案；不是正数时 undefined
 */
export function sizeText(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined
  const units = ["B", "KB", "MB", "GB", "TB", "PB"]
  let n = value
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i += 1
  }
  return `${n >= 100 || Number.isInteger(n) ? Math.round(n) : n.toFixed(1)} ${units[i]}`
}

/**
 * 是否为正数
 * @param value 任意值
 * @returns 是否为有限的正数
 */
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
}

/**
 * 收集行：值为空的整行丢掉
 * @param pairs 名与值
 * @returns 行
 */
function rows(pairs: readonly (readonly [string, string | undefined])[]): SpecRow[] {
  return pairs.filter((pair): pair is readonly [string, string] => pair[1] !== undefined && pair[1] !== "")
}

/**
 * 整理成分节的配置清单
 * @param raw 探到的原始数据
 * @returns 各节；一行都没有的节不出现
 */
export function toSpecs(raw: SpecsRaw): SpecSection[] {
  const out: SpecSection[] = []
  const push = (section: SpecSection): void => {
    if ((section.rows?.length ?? 0) + (section.items?.length ?? 0) > 0) out.push(section)
  }

  const cpu = raw.cpu
  if (cpu !== undefined) {
    const cache = cpu.cache
    const hybrid =
      positive(cpu.performanceCores) && positive(cpu.efficiencyCores)
        ? `（性能核 ${cpu.performanceCores} · 能效核 ${cpu.efficiencyCores}）`
        : ""
    push({
      id: "cpu",
      title: "处理器",
      rows: rows([
        ["型号", join([cpu.manufacturer, cpu.brand])],
        ["核心 / 线程", positive(cpu.physicalCores) && positive(cpu.cores) ? `${cpu.physicalCores} / ${cpu.cores}${hybrid}` : undefined],
        ["物理处理器", positive(cpu.processors) && cpu.processors > 1 ? String(cpu.processors) : undefined],
        [
          "基础 / 最高频率",
          positive(cpu.speed)
            ? positive(cpu.speedMax) && cpu.speedMax !== cpu.speed
              ? `${cpu.speed} / ${cpu.speedMax} GHz`
              : `${cpu.speed} GHz`
            : undefined
        ],
        ["插槽", textOf(cpu.socket)],
        [
          "缓存",
          cache === undefined
            ? undefined
            : join(
                [
                  sizeText(cache.l1d) === undefined ? undefined : `L1d ${sizeText(cache.l1d)}`,
                  sizeText(cache.l1i) === undefined ? undefined : `L1i ${sizeText(cache.l1i)}`,
                  sizeText(cache.l2) === undefined ? undefined : `L2 ${sizeText(cache.l2)}`,
                  sizeText(cache.l3) === undefined ? undefined : `L3 ${sizeText(cache.l3)}`
                ],
                " · "
              )
        ],
        ["架构细节", join([cpu.family === undefined ? undefined : `家族 ${cpu.family}`, cpu.model === undefined ? undefined : `型号 ${cpu.model}`, cpu.stepping === undefined ? undefined : `步进 ${cpu.stepping}`], " · ")],
        ["虚拟化", typeof cpu.virtualization === "boolean" ? (cpu.virtualization ? "支持" : "不支持或未开启") : undefined],
        ["调速策略", textOf(cpu.governor)]
      ])
    })
  }

  const sticks = (raw.memLayout ?? []).filter(stick => positive(stick.size))
  if (raw.mem !== undefined || sticks.length > 0) {
    const slots = raw.baseboard?.memSlots
    push({
      id: "memory",
      title: "内存",
      rows: rows([
        ["总量", sizeText(raw.mem?.total)],
        ["插槽", positive(slots) ? `${sticks.length} / ${slots} 已用` : sticks.length > 0 ? `${sticks.length} 根` : undefined],
        ["最大支持", sizeText(raw.baseboard?.memMax)]
      ]),
      items: sticks.map((stick, i) => ({
        title: textOf(stick.bank) ?? `内存条 ${i + 1}`,
        rows: rows([
          ["容量", sizeText(stick.size)],
          ["类型", join([stick.type, stick.formFactor], " · ")],
          ["频率", positive(stick.clockSpeed) ? `${stick.clockSpeed} MHz` : undefined],
          ["厂商", textOf(stick.manufacturer)],
          ["料号", textOf(stick.partNum)],
          ["电压", positive(stick.voltageConfigured) ? `${stick.voltageConfigured} V` : undefined],
          ["ECC", typeof stick.ecc === "boolean" ? (stick.ecc ? "是" : "否") : undefined]
        ])
      }))
    })
  }

  push({
    id: "board",
    title: "主板与固件",
    rows: rows([
      ["机型", join([raw.system?.manufacturer, raw.system?.model, raw.system?.version])],
      ["虚拟机", raw.system?.virtual === true ? (textOf(raw.system.virtualHost) ?? "是") : undefined],
      ["主板", join([raw.baseboard?.manufacturer, raw.baseboard?.model, raw.baseboard?.version])],
      ["BIOS", join([join([raw.bios?.vendor, raw.bios?.version]), textOf(raw.bios?.releaseDate)], " · ")],
      ["机箱", textOf(raw.chassis?.type)]
    ])
  })

  const cards = (raw.graphics?.controllers ?? []).filter(card => textOf(card.model) !== undefined)
  const screens = (raw.graphics?.displays ?? []).filter(d => positive(d.currentResX) || positive(d.resolutionX))
  push({
    id: "gpu",
    title: "显卡与显示器",
    items: [
      ...cards.map(card => ({
        title: join([card.vendor, card.model]) ?? "显卡",
        rows: rows([
          ["显存", positive(card.vram) ? `${sizeText(card.vram * 1024 * 1024)}${card.vramDynamic === true ? "（共享）" : ""}` : undefined],
          ["驱动", textOf(card.driverVersion)],
          ["总线", textOf(card.bus)],
          ["核心 / 显存频率", positive(card.clockCore) && positive(card.clockMemory) ? `${card.clockCore} / ${card.clockMemory} MHz` : undefined]
        ])
      })),
      ...screens.map((d, i) => {
        const x = positive(d.currentResX) ? d.currentResX : d.resolutionX
        const y = positive(d.currentResY) ? d.currentResY : d.resolutionY
        return {
          title: join([d.vendor, d.model]) ?? (d.builtin === true ? "内置显示器" : `显示器 ${i + 1}`),
          rows: rows([
            ["分辨率", positive(x) && positive(y) ? `${x} × ${y}${positive(d.currentRefreshRate) ? ` @ ${d.currentRefreshRate} Hz` : ""}` : undefined],
            ["尺寸", positive(d.sizeX) && positive(d.sizeY) ? `${d.sizeX} × ${d.sizeY} cm` : undefined],
            ["接口", textOf(d.connection)],
            ["主显示器", d.main === true ? "是" : undefined]
          ])
        }
      })
    ]
  })

  push({
    id: "disk",
    title: "存储设备",
    items: (raw.disks ?? [])
      .filter(disk => positive(disk.size))
      .map(disk => ({
        title: join([disk.vendor, disk.name]) ?? textOf(disk.device) ?? "磁盘",
        rows: rows([
          ["容量", sizeText(disk.size)],
          ["接口", join([disk.interfaceType, disk.type], " · ")],
          ["固件", textOf(disk.firmwareRevision)],
          ["健康", disk.smartStatus === "Ok" ? "正常" : textOf(disk.smartStatus)],
          ["温度", positive(disk.temperature) ? `${disk.temperature} °C` : undefined]
        ])
      }))
  })

  const os = raw.os
  if (os !== undefined) {
    const tz = raw.timezone
    const sign = tz !== undefined && tz.offset < 0 ? "-" : "+"
    const hours = tz === undefined ? 0 : Math.abs(tz.offset) / 60
    push({
      id: "os",
      title: "系统",
      rows: rows([
        ["发行版", join([os.distro, os.codename])],
        ["版本", join([os.release, os.build === os.release ? undefined : os.build], " · ")],
        ["内核", textOf(os.kernel)],
        ["架构", textOf(os.arch)],
        ["UEFI", typeof os.uefi === "boolean" ? (os.uefi ? "是" : "否") : undefined],
        ["运行于虚拟机", os.hypervizor === true ? "是" : undefined],
        ["远程会话", os.remoteSession === true ? "是" : undefined],
        ["时区", tz === undefined ? undefined : `${tz.name}（UTC${sign}${Number.isInteger(hours) ? hours : hours.toFixed(1)}）`]
      ])
    })
  }

  push({
    id: "net",
    title: "网络适配器",
    items: (raw.nets ?? [])
      .filter(net => net.internal !== true && net.virtual !== true)
      .map(net => ({
        title: textOf(net.ifaceName) ?? textOf(net.iface) ?? "网卡",
        rows: rows([
          ["类型", net.type === "wireless" ? "无线" : net.type === "wired" ? "有线" : textOf(net.type)],
          ["状态", net.operstate === "up" ? "已连接" : net.operstate === "down" ? "未连接" : textOf(net.operstate)],
          ["速率", positive(net.speed) ? `${net.speed} Mbit/s` : undefined],
          ["MTU", positive(net.mtu) ? String(net.mtu) : undefined],
          ["DHCP", typeof net.dhcp === "boolean" ? (net.dhcp ? "是" : "否") : undefined],
          ["默认路由", net.default === true ? "是" : undefined]
        ])
      }))
  })

  return out
}

/**
 * 一项探测：出错时记一句并当作没有
 * @param name 记日志用的名字
 * @param run 探测
 * @param warn 告知方式
 * @returns 结果；出错时 undefined
 */
async function attempt<T>(name: string, run: () => Promise<T>, warn: (message: string, err: unknown) => void): Promise<T | undefined> {
  try {
    return await run()
  } catch (err) {
    warn(`探测${name}失败`, err)
    return undefined
  }
}

/** 完整配置采样器：首次请求时开探，探完记住 */
export class SpecsSampler {
  /** 探到的清单；尚未探完时 undefined */
  #specs: Specs | undefined
  /** 是否正在探，避免几次请求各起一轮 */
  #probing = false

  /**
   * 取一份完整配置
   * @param warn 出错时的告知方式
   * @returns 探完时为整份；尚在探时 `ready: false`
   */
  sample(warn: (message: string, err: unknown) => void): Specs {
    if (this.#specs !== undefined) return this.#specs
    if (!this.#probing) {
      this.#probing = true
      void this.#probe(warn).finally(() => {
        this.#probing = false
      })
    }
    return { ready: false, sections: [] }
  }

  /**
   * 并发探各项
   * @param warn 告知方式
   * @returns 探完即结束
   */
  async #probe(warn: (message: string, err: unknown) => void): Promise<void> {
    const [cpu, mem, memLayout, system, baseboard, bios, chassis, graphics, disks, os, nets] = await Promise.all([
      attempt("处理器", () => si.cpu(), warn),
      attempt("内存总量", () => si.mem(), warn),
      attempt("内存条", () => si.memLayout(), warn),
      attempt("机型", () => si.system(), warn),
      attempt("主板", () => si.baseboard(), warn),
      attempt("BIOS", () => si.bios(), warn),
      attempt("机箱", () => si.chassis(), warn),
      attempt("显卡", () => si.graphics(), warn),
      attempt("存储设备", () => si.diskLayout(), warn),
      attempt("操作系统", () => si.osInfo(), warn),
      attempt("网络适配器", () => si.networkInterfaces(), warn)
    ])
    const raw: SpecsRaw = {
      ...(cpu === undefined ? {} : { cpu }),
      ...(mem === undefined ? {} : { mem }),
      ...(memLayout === undefined ? {} : { memLayout }),
      ...(system === undefined ? {} : { system }),
      ...(baseboard === undefined ? {} : { baseboard }),
      ...(bios === undefined ? {} : { bios }),
      ...(chassis === undefined ? {} : { chassis }),
      ...(graphics === undefined ? {} : { graphics }),
      ...(disks === undefined ? {} : { disks }),
      ...(os === undefined ? {} : { os }),
      ...(nets === undefined ? {} : { nets: Array.isArray(nets) ? nets : [nets] }),
      timezone: { name: Intl.DateTimeFormat().resolvedOptions().timeZone, offset: -new Date().getTimezoneOffset() }
    }
    this.#specs = { ready: true, sections: toSpecs(raw) }
  }
}
