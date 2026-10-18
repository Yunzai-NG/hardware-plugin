/**
 * 模块职责：采样节流 —— 并发的调用共用一次采样，结果在存活期内复用
 * 依赖方向：无依赖
 * 生命周期：随采样器创建，与之同寿
 * 注意事项：**节流的是「起子进程」，不是数据新鲜度。** Windows 上 `systeminformation` 的多数调用要起一个
 *          PowerShell（本机实测每个 0.5–0.8 秒），两个开着面板的标签页各发一拍就是双份；带速率的采样器
 *          （磁盘、网卡）还会因两次采样相隔几毫秒而算出离谱的速率。
 *
 *          存活期可随结果而定：探不到的东西（台式机的电池、没有传感器的温度）不会忽然出现，
 *          不必每拍都起一个进程去确认它还是没有。
 */

/**
 * 并发合流、限时复用的取数器
 * @template T 结果类型
 */
export class Throttled<T> {
  /** 取数函数 */
  readonly #load: (force: boolean) => Promise<T>
  /** 结果的存活毫秒，可按结果决定 */
  readonly #ttl: (value: T) => number
  /** 上一次的结果 */
  #last: { at: number; value: T } | undefined
  /** 正在进行的那一次 */
  #inflight: Promise<T> | undefined

  /**
   * @param load 取数函数，收到 `get` 的 `force`；抛错时不缓存，原样抛给每个等待者
   * @param ttl 结果存活毫秒，或按结果给出存活毫秒的函数
   */
  constructor(load: (force: boolean) => Promise<T>, ttl: number | ((value: T) => number)) {
    this.#load = load
    this.#ttl = typeof ttl === "number" ? () => ttl : ttl
  }

  /**
   * 取结果
   * @param force 绕过缓存（并发合流照旧）
   * @returns 结果
   */
  get(force = false): Promise<T> {
    if (this.#inflight !== undefined) return this.#inflight
    const last = this.#last
    if (!force && last !== undefined && Date.now() - last.at < this.#ttl(last.value)) return Promise.resolve(last.value)

    const task = this.#load(force).then(value => {
      this.#last = { at: Date.now(), value }
      return value
    })
    this.#inflight = task
    const clear = (): void => {
      this.#inflight = undefined
    }
    task.then(clear, clear)
    return task
  }
}
