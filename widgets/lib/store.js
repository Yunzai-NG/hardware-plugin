/**
 * 模块职责：各硬件组件共用的取数与画法 —— 一个端点一份数据，以及若干 vnode 帮手
 * 依赖方向：只用注入的 `api` 与同包的 `dist/rings.js`；不 import 任何裸包名
 * 生命周期：模块级单例。浏览器的模块注册表保证各组件 import 到的是同一份
 * 注意事项：**取数用 `api.own()` 而不是 `api.get()` 加一个写死的路径。** 本包 node 侧的接口地址由
 *          webui 算出、经清单送来 —— 它含归属名，js 里无从知道；写死的话换一个落点就是一条 404。
 *
 *          **一个端点一份共享状态，而不是一个总状态。** 采样拆成六条路由，故此处按路径归集：同一端点
 *          的多枚组件共用一份数据、每拍只发一次请求；不同端点互不牵连，没上板的组件一次请求都不发。
 *
 *          **节拍订阅仍是各组件自己的。** `api.onTick` 在组件卸载时自动退订 —— 若只由第一枚组件订阅，
 *          使用者把它移除之后其余就再也不更新了。故各订各的，靠 `MIN_GAP_MS` 把同一拍里的多次调用
 *          收敛成一次请求。
 *
 *          **请求失败时保留上一次的数，另记一句错。** 清空会让卡片在一次网络抖动后变成破折号，
 *          而那台机器其实好着 —— 上一次的数配一句「更新失败」更有用。
 */
import { RING_RADIUS, RING_VIEWBOX, dualRing, ringLegend } from "../../dist/rings.js"

/**
 * 两次请求之间的最小间隔
 *
 * 同一端点的多枚组件在同一拍里各调一次 `refresh`，此值把后几次收敛掉。取 2 秒：
 * 比节拍（5 秒）短得多，故正常轮询一次都不会被误挡；又比一拍内几次调用的时间差长得多。
 */
const MIN_GAP_MS = 2000

/** 各端点的共享状态，键为端点路径 */
const stores = new Map()

/**
 * 取（或建立）某个端点的共享状态
 * @param {object} api 注入的面板能力
 * @param {string} path 端点相对本包的路径
 * @returns {object} 该端点的状态
 */
function storeOf(api, path) {
  let store = stores.get(path)
  if (store === undefined) {
    store = { data: api.ref(undefined), error: api.ref(""), inflight: undefined, lastAt: 0 }
    stores.set(path, store)
  }
  return store
}

/**
 * 取一次数据并写入共享状态
 * @param {object} api 注入的面板能力
 * @param {string} path 端点相对本包的路径
 * @returns {Promise<void>|undefined} 取完即结束；被间隔挡下时不发请求
 */
function refresh(api, path) {
  const store = storeOf(api, path)
  if (store.inflight !== undefined) return store.inflight
  if (Date.now() - store.lastAt < MIN_GAP_MS) return undefined

  store.lastAt = Date.now()
  store.inflight = api
    .own(path)
    .then(value => {
      store.data.value = value
      store.error.value = ""
    })
    .catch(err => {
      // 保留上一次的数，只记一句错，理由见文件头
      store.error.value = err instanceof Error ? err.message : String(err)
    })
    .finally(() => {
      store.inflight = undefined
    })

  return store.inflight
}

/**
 * 订阅某个端点的数据
 *
 * 每枚组件在自己的 setup 里调一次。除了订阅节拍，还**立即取一次** ——
 * `onTick` 不会在订阅时立刻响一下，若只等节拍，刚添加的卡片要空着五秒。
 * @param {object} api 注入的面板能力
 * @param {string} path 端点相对本包的路径
 * @returns {object} `{ data, error }` 两个 ref，同端点的各组件共用同一份
 */
export function useEndpoint(api, path) {
  const store = storeOf(api, path)

  api.onTick(() => {
    void refresh(api, path)
  })
  void refresh(api, path)

  return { data: store.data, error: store.error }
}

/**
 * 订阅整机 CPU / 内存 / 显卡 / SWAP 那一份
 * @param {object} api 注入的面板能力
 * @returns {object} `{ data, error }`
 */
export function useHardware(api) {
  return useEndpoint(api, "hardware")
}

/**
 * 订阅内核的概览接口，取**本进程**的占用
 *
 * 双色环的内圈那一段来自这里。**不在本包里另采一遍本进程占用**：内核早有这个数
 * （`GET /api/overview` 的 `usage`），再采一份就是同一事实的第二个来源，而两处的
 * 采样时刻不同必然给出两个数 —— 那正是双色环要消除的东西。
 *
 * 用 `api.get` 而非 `api.own`：这是内核的接口，不在本包的前缀之下。
 * @param {object} api 注入的面板能力
 * @returns {object} `{ data, error }`
 */
export function useOverview(api) {
  const path = "/api/overview"
  let store = stores.get(path)
  if (store === undefined) {
    store = { data: api.ref(undefined), error: api.ref(""), inflight: undefined, lastAt: 0 }
    stores.set(path, store)
  }

  /**
   * 取一次概览
   * @returns {Promise<void>|undefined} 取完即结束
   */
  const pull = () => {
    if (store.inflight !== undefined) return store.inflight
    if (Date.now() - store.lastAt < MIN_GAP_MS) return undefined
    store.lastAt = Date.now()
    store.inflight = api
      .get(path)
      .then(value => {
        store.data.value = value
        store.error.value = ""
      })
      .catch(err => {
        store.error.value = err instanceof Error ? err.message : String(err)
      })
      .finally(() => {
        store.inflight = undefined
      })
    return store.inflight
  }

  api.onTick(() => {
    void pull()
  })
  void pull()

  return { data: store.data, error: store.error }
}

/**
 * 一条线性进度的 vnode，与内置的 `BarGauge.vue` 同形
 *
 * 手抄一遍而不是想办法复用那个组件：`api` 有意只给 `h`，不给 Vue 本身，也不给内置
 * 组件 —— 那些一旦交出去就成了对插件作者的承诺，再改不动。代价就是这十几行。
 * 类名用的是面板样式表里已有的 `bar-*` 一族，故无须自带任何 CSS。
 *
 * **着色档位取 `api.fmt.gaugeLevel`，不自行比阈值。** 抄一份 0.7 / 0.9 之后，内核那边
 * 调整档位，同一台机器上这些卡片与内置的槽便会在不同占用率变红 —— 而「两处颜色
 * 不一致」几乎不会被当成 bug 报出来，只会被当成看错了。
 * @param {object} api 注入的面板能力
 * @param {string} label 左端标签
 * @param {number|undefined} ratio 比例（0-1）；undefined 时槽为空、数值为破折号
 * @param {string} text 右端文案
 * @returns {object} vnode
 */
export function bar(api, label, ratio, text) {
  const level = api.fmt.gaugeLevel(ratio)
  const now = ratio === undefined ? undefined : Math.round(ratio * 100)

  return api.h("div", { class: "bar" }, [
    api.h("div", { class: "bar-head" }, [
      api.h("span", { class: "bar-label mono" }, label),
      api.h("span", { class: `bar-value ${level}` }, text)
    ]),
    api.h(
      "div",
      {
        class: "bar-slot",
        role: "progressbar",
        "aria-label": label,
        "aria-valuemin": "0",
        "aria-valuemax": "100",
        "aria-valuenow": now,
        "aria-valuetext": text
      },
      [api.h("div", { class: `bar-fill ${level}`, style: { width: `${(ratio ?? 0) * 100}%` } })]
    )
  ])
}

/**
 * 一枚双色环的 vnode
 *
 * 同一枚环上两段颜色：内层那段是本进程，外接一段是「整机减本进程」，两段合起来恰是
 * 整机占用。几何一律取 `dist/rings.js` 的 `dualRing`（有用例钉住），此处只管画。
 *
 * **环心写整机的百分数**，本进程那个数写在环下的小字里。环心只容得下一个数，
 * 而「这台机器忙不忙」是使用者扫一眼时要的答案；「其中机器人占多少」是第二个问题。
 *
 * **`aria-hidden` 加在 svg 上**，两段弧读屏器念不出；环心的百分数与环下的两行字
 * 合起来已是完整的一句话。
 * @param {object} api 注入的面板能力
 * @param {string} title 环下的标题
 * @param {number|undefined} total 整机占用（0-1）
 * @param {number|undefined} own 本进程占用（0-1）
 * @param {string} note 环下的一行小字
 * @returns {object} vnode
 */
export function ring(api, title, total, own, note) {
  const geo = dualRing(total, own)
  /*
   * 半径与 viewBox 取自模块常量，**不从 `geo` 上读**
   *
   * 初版写 `geo.viewBox / 2` 与 `geo.radius` —— 而 `dualRing` 只返回两段弧与两个比例，
   * 并没有这两个字段。于是 `mid` 是 NaN，三个 `<circle>` 的 cx / cy 全成了 NaN，
   * 浏览器拒绝渲染：dasharray 算得再对也画不出一条弧。
   *
   * 这个错**不报在插件里**，只在浏览器控制台留一句 `attribute cx: Expected length, "NaN"`，
   * 而卡片上的表现是「标题与小字都在，中间空着」—— 看起来像数据没到，而非画法写错。
   */
  const mid = RING_VIEWBOX / 2
  const level = api.fmt.gaugeLevel(total)

  /**
   * 画一段弧
   * @param {object} arc `dualRing` 给出的一段
   * @param {string} cls 该段的类名
   * @returns {object} vnode
   */
  const arc = (arc_, cls) =>
    api.h("circle", {
      class: cls,
      cx: mid,
      cy: mid,
      r: RING_RADIUS,
      "stroke-dasharray": arc_.dash,
      "stroke-dashoffset": arc_.offset,
      transform: `rotate(-90 ${mid} ${mid})`
    })

  return api.h("div", { class: "gauge" }, [
    api.h("div", { class: "ring-wrap" }, [
      api.h(
        "svg",
        {
          class: "ring",
          viewBox: `0 0 ${RING_VIEWBOX} ${RING_VIEWBOX}`,
          "aria-hidden": "true",
          focusable: "false"
        },
        [
          api.h("circle", { class: "ring-base", cx: mid, cy: mid, r: RING_RADIUS }),
          // 先画整机余量那段（较淡），本进程那段压在其上 —— 反过来画会让
          // 两段的接缝处出现一道被覆盖的细线
          arc(geo.rest, `ring-fill ${level}`),
          arc(geo.own, "ring-fill ring-own")
        ]
      ),
      api.h("b", { class: `ring-value ${level}` }, api.fmt.percent(total))
    ]),
    api.h("span", { class: "gauge-title" }, title),
    /*
     * 小字为空时整行不出现，而不是留一个空 span
     *
     * 空 span 仍按 `.gauge-hint` 的行高占位，故环与其下的内容之间会多出一段说不清来由的
     * 空白。带图例那一路（`ringWithLegend`）正是传空串进来的。
     */
    note === "" ? null : api.h("span", { class: "gauge-hint" }, note)
  ])
}

/**
 * 一枚双色环，环旁带三段图例
 *
 * 与 `ring` 的差别只在图例：那一枚把「其中本进程 x%」写在环下的一行小字里，这一枚把
 * 三段各自列一行、每行前一枚同色圆点。**三段是「本进程 / 其他占用 / 空闲」**，合起来
 * 恰是一整圈 —— 故这枚环上的每一种颜色都有名字，包括环底那圈没被覆盖的部分。
 *
 * 比例一律取 `dist/rings.js` 的 `ringLegend`（有用例钉住）：「其他占用」是整机减本进程，
 * 没有任何接口直接给这个数，而算错**不报错**，只表现为三行加起来不是 100%。
 * @param {object} api 注入的面板能力
 * @param {string} title 环下的标题
 * @param {number|undefined} total 整机占用（0-1）
 * @param {number|undefined} own 本进程占用（0-1）
 * @param {string} ownLabel 本进程那一段叫什么
 * @returns {object} vnode
 */
export function ringWithLegend(api, title, total, own, ownLabel) {
  const rows = ringLegend(total, own, ownLabel).map(item =>
    api.h("div", { class: "legend-row" }, [
      // 圆点是纯装饰，颜色由类名给出；名字与百分数已把这一行说全，故读屏器不必念它
      api.h("span", { class: `legend-dot legend-${item.kind}`, "aria-hidden": "true" }),
      api.h("span", { class: "legend-label" }, item.label),
      api.h("span", { class: "legend-num" }, api.fmt.percent(item.ratio))
    ])
  )

  /*
   * 环本身照旧交给 `ring`，只是把它环下那行小字留空
   *
   * 三段图例已经把每种颜色说全，再补一行「整机占用，其中本进程 x%」就是同一件事说两遍。
   * 不另写一份画环的代码：两份迟早在半径或叠色顺序上分岔，而那种差别看不出来。
   */
  return api.h("div", { class: "ring-legend" }, [
    ring(api, title, total, own, ""),
    api.h("div", { class: "legend" }, rows)
  ])
}

/**
 * 一枚卡片的外壳：标题、内容、底部小字
 * @param {object} api 注入的面板能力
 * @param {string} title 标题
 * @param {object|object[]|string} body 内容
 * @param {string} note 底部小字
 * @returns {object} vnode
 */
export function card(api, title, body, note) {
  return api.h("div", { class: "card fill" }, [
    api.h("h2", { style: "margin-top: 0" }, title),
    body,
    api.h("p", { class: "sub", style: "margin-bottom: 0" }, note)
  ])
}

/**
 * 一枚只装一枚环的卡片
 *
 * 与 `card` 分开：环那一格不带标题（标题在环下），故用的是 `gauge-card` 而非
 * `card fill` —— 那个类在面板样式表里负责把内容整体居中（见 styles.css 的注释）。
 * @param {object} api 注入的面板能力
 * @param {object} body 环
 * @returns {object} vnode
 */
export function gaugeCard(api, body) {
  return api.h("div", { class: "card gauge-card" }, [body])
}

/**
 * 一张两列的键值表，用于系统信息与 Redis 那类「一行一个事实」的组件
 *
 * **类名是 `pairs`，不是 `kv`。** 初版写 `<dl class="kv">` —— 而 `kv` 在面板样式表里
 * 是键值对**编辑器**的类名（`.kv` 是纵向 flex，`.kv-row` 是带 input 的三列栅格），
 * 并非一张两列清单。后果是 `dt` / `dd` 各占一整行、逐个纵向堆叠：系统信息那 12 行
 * 撑到 1026px 塞进 270px 的格子，溢出 660px。这个错**不报任何错**，只表现为
 * 「这一格怎么这么长」。
 *
 * 真正的两列清单是运行时表用的 `table.pairs`（`th` 取自身宽度且不折行，`td` 长内容
 * 处断行）。故此处照它的形态给 —— 一张 table，而不是 dl。
 *
 * **表外面包一层 div。** 面板样式表那条 `.board .card.fill > :not(h2, .sub:last-child)`
 * 会给卡片的直接子元素写 `display: flex`，表格被改写后 thead / tbody 各自块化成 flex 项、
 * 再各包一张匿名表，列宽从此各算各的（理由详见 `hardware-processes.js`）。包一层之后
 * 那条规则落在 div 上，表格保持表格布局，`width: 100%` 也才真的作用在表上。
 * @param {object} api 注入的面板能力
 * @param {Array<[string, string]>} rows 每行的名与值
 * @returns {object} vnode
 */
export function kv(api, rows) {
  return api.h("div", null, [
    api.h("table", { class: "pairs" }, [
      api.h(
        "tbody",
        null,
        rows.map(([name, value]) =>
          api.h("tr", null, [api.h("th", null, name), api.h("td", { class: "mono" }, value)])
        )
      )
    ])
  ])
}

/**
 * 一句居中的说明，用于「未配置」「探不到」这类空态
 *
 * **空态要给一句话，不能留一片白。** 一格空白说不清是「还没加载」「配错了」还是
 * 「这台机器没有这个东西」，而这三件事使用者要做的动作完全不同。
 * @param {object} api 注入的面板能力
 * @param {string} text 说明
 * @returns {object} vnode
 */
export function empty(api, text) {
  return api.h("p", { class: "sub", style: "margin: auto 0; text-align: center" }, text)
}

/**
 * 速率 → 文案
 *
 * `api.fmt.bytes` 给的是「76.5 MB」这样的量，速率要在其后加「/s」。取不到时给破折号
 * 而不是「0 B/s」—— 后者会被读成「此刻没有流量」，而实情是「还没有第二个采样点」。
 * @param {object} api 注入的面板能力
 * @param {number|undefined} value 字节每秒
 * @returns {string} 形如 `1.2 MB/s`
 */
export function rate(api, value) {
  return value === undefined ? "—" : `${api.fmt.bytes(value)}/s`
}
