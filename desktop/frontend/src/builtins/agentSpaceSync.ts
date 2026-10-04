/**
 * Agent 自建 Space 插件的热重载(2026-09-11)。**不监听文件**:引擎在 Muse 周期收尾时刷新 status.spaceStamp
 * (Space 目录内最大 mtime),桌面看到戳变了才只重载 `agent-<slug>` 这一个插件(pluginStore.reloadOne;全量
 * reloadExternal 会把所有插件拆装一遍并关掉它们的标签页)。加载失败(setup 抛错 / manifest 缺失、坏或被门禁挡下 /
 * 装上了却没注册 home 视图)经 /agent/special/muse/feedback 回写成 [feedback] 行,Muse 下个周期自己修。
 * 调用点:MuseView 轮询(4s)+ MuseHome 挂载(20s),按戳去重,谁先看到谁做;应用刚起第一次观察到戳会白重载一次(无害)。
 */
import { agentSpaceSourceUrl, usePluginStore } from '@amadeus/plugins/pluginStore'
import { postMuseFeedback } from '../services/backendService'
import type { TanguDesktopConfig } from '../types'
import { homeTarget } from '../services/engine/targets'

const loadedStamp = new Map<string, number>()
const reportedStamp = new Map<string, number>()
/** 回写 POST 失败(引擎一时不可用)的那条加载失败:同戳的后续轮询在「戳没变」处直接返回、不再重查,只能记下来在那儿重发(Codex 09-27) */
const unsentReport = new Map<string, { stamp: number; text: string }>()
/** 只记仍是当前这一版的:两版的回写同时在途、旧版的失败晚到时,不许把新版待重发的那条覆盖掉(Codex 09-27) */
const keepUnsent = (slug: string, r: { stamp: number; text: string }): void => {
  if (loadedStamp.get(slug) === r.stamp) unsentReport.set(slug, r)
}

/** 装上了、没抛错,却没注册主槽视图 —— 同样要回写,否则就是静默失败。09-27 实机:Muse 从 09-11 首建起每一版 main.js
 *  都整份包成 `function setup(ctx) { … }` 却从不调用,求值只声明了一个函数,零注册零报错;Space 一直是空白态,
 *  Muse 还把「没收到失败反馈」当成加载成功的证据。宽限一会再查:setup 可能是 async,await 之后才 registerView。
 *  ponytail: 固定宽限;真有 setup 超过它才注册会收到一条误报(同一戳不再纠正)—— 所以文案照实说「3 秒后」并要求同步注册,
 *  误报的代价只是让它改成同步写法。要精确就得在 pluginStore 留住 async setup 的 promise、等它落定再查。 */
const HOME_GRACE_MS = 3000
const NO_HOME = 'Space plugin loaded but had registered no "home" view 3 seconds after loading, so your Space shows the empty placeholder. ' +
  'main.js runs as the body of setup(ctx): call ctx.registerView({ id: "home", ... }) synchronously at the top level of the file. ' +
  'A file that only declares function setup(ctx) { ... } never runs it: nothing registers and no error is raised.'

export const agentPluginId = (slug: string): string => `agent-${slug}`

export async function syncAgentSpace(cfg: TanguDesktopConfig, slug: string, stamp: number | null | undefined): Promise<void> {
  if (slug === 'muse') hookRuntimeErrors(cfg)
  if (typeof stamp !== 'number') return // 旧引擎没有戳 → 不同步(启动时装的那份就是全部)
  const unsent = unsentReport.get(slug)
  if (unsent) {
    unsentReport.delete(slug)
    if (unsent.stamp === stamp) void postMuseFeedback(homeTarget(), unsent.text).catch(() => keepUnsent(slug, unsent))
  }
  if (loadedStamp.get(slug) === stamp) return
  loadedStamp.set(slug, stamp) // 先记后做:并发调用只有一个真跑
  const id = agentPluginId(slug)
  try {
    await usePluginStore.getState().reloadOne(id)
  } catch (e) {
    loadedStamp.delete(slug) // 下次轮询再试
    console.warn(`[agent-space] reload ${id} failed`, e)
    return
  }
  const st = usePluginStore.getState()
  const p = st.plugins.find((x) => x.id === id)
  if (slug !== 'muse' || !p) return // 回写口只有 Muse 的;没有来源 = 还没建,空白态本来就对
  const report = (text: string): void => {
    if (reportedStamp.get(slug) === stamp) return
    reportedStamp.set(slug, stamp) // 同一份内容只报一次
    void postMuseFeedback(homeTarget(), text).catch(() => keepUnsent(slug, { stamp, text }))
  }
  // blocked 不止 invalid:apiVersion / minAppVersion 门禁挡下同样一声不吭地不渲染
  const err = st.lastSetupError[id] || (p.blocked ? p.blockedReason || `manifest.json blocked (${p.blocked}): check apiVersion / minAppVersion` : '')
  if (err) { report(`Space plugin failed to load: ${err.slice(0, 500)}`); return }
  await new Promise((r) => setTimeout(r, HOME_GRACE_MS))
  const now = usePluginStore.getState()
  if (loadedStamp.get(slug) !== stamp) return // 宽限期里又换了一版:归那一版的调用去查
  if (!now.activeIds.includes(id)) return // 用户关了它:不是 agent 能修的事
  if (!now.views.some((o) => o.pluginId === id && o.item.id === 'home')) report(NO_HOME)
}

/** home 注册了、挂载时却抛错:宿主只在主区写一行「插件视图加载失败」—— 同样回写,否则又是一个只有用户看得见的失败。
 *  去重按「这一份视图定义 × 错误文本」:def 对象只在插件重新 setup(= 装了新代码)时才换,用户切出切回 Space、冷启动后
 *  首次拿到戳都还是同一个 def,不重报;同一份代码交替报两种错,各报一次;POST 失败撤销标记,下次挂载再报(Codex 09-27)。 */
let mountReported = new WeakMap<object, Set<string>>()
export function reportAgentSpaceMountError(cfg: TanguDesktopConfig, slug: string, def: { id: string }, e: unknown): void {
  if (slug !== 'muse') return
  const text = String((e as { message?: unknown } | null)?.message ?? e).slice(0, 300)
  let seen = mountReported.get(def)
  if (!seen) mountReported.set(def, (seen = new Set()))
  if (seen.has(text)) return
  seen.add(text)
  const sent = seen
  void postMuseFeedback(homeTarget(), `Space view "${def.id}" registered but its mount() threw, so the user sees "Plugin view failed to load": ${text}`)
    .catch(() => { sent.delete(text) })
}

/** 挂载之后没接住的错误(异步回调 / 事件处理 / 定时器 / 订阅回调里抛的):宿主的 try/catch 与 mount 的 Promise 都罩不住,
 *  从前只进控制台。09-27 live:Muse 的 Space 选择器拿到 null,异步 draw 里 TypeError,数据卡全空,它一无所知。
 *  pluginStore 给 agent Space 当前这一版的代码打了 sourceURL → 栈里有它的帧 → 回写成 [feedback],带 main.js 行号。
 *  文案是中性的「在你的 Space 里没接住」:错可能是它自己的代码抛的,也可能是它调的宿主接口 reject 了、它没接(异步栈里
 *  照样有它 await 的那一帧)—— 两种的修法都落在那一行。只认当前这一版(旧版漏清的定时器不算);同一条只报一次、最多 3 条,
 *  POST 失败撤销标记。
 *  ponytail: 去重只在本渲染进程 —— 两个窗口同时开着 Muse Space 撞上同一个错会各报一条,要紧再挪到引擎侧按文本去重;
 *  栈里一帧都没有它的归不了:宿主自己的定时器 reject,以及以非 Error 值 reject 的(`Promise.reject('boom')` 没有栈 ——
 *  setup 返回这样的 Promise 且 home 已注册时,这份失败无处回写;kickoff 要求顶层同步注册,不值当为它给 setup 的 Promise 打标)。 */
const RUNTIME_MAX = 3
let runtimeCfg: TanguDesktopConfig | null = null
let runtimePending: Array<{ url: string; text: string }> = [] // 还没拿到 cfg 时认出的(每版至多 3 条),拿到就补发 —— 只补仍在运行的那一版的
let runtimeKey = ''
let runtimeSeen = new Set<string>()
let runtimeHooked = false

/** 栈里有 agent Space 当前这一版代码的帧 → 回写文案(行号取栈里它的第一帧);不是它的 → null。
 *  行号减 2:new Function 包了 `function anonymous(ctx\n) {\n` 两行头。 */
export function agentSpaceRuntimeError(err: unknown, sourceUrl: string): string | null {
  const stack = String((err as { stack?: unknown } | null)?.stack ?? '')
  const at = stack.indexOf(sourceUrl)
  if (at < 0) return null
  const pos = /^:(\d+):\d+/.exec(stack.slice(at + sourceUrl.length))
  const line = pos ? Number(pos[1]) - 2 : 0
  const e = err as { name?: unknown; message?: unknown }
  return `An error went unhandled in your Space after it loaded${line > 0 ? ` (main.js line ${line})` : ''}: ` +
    `${String(e.name || 'Error')}: ${String(e.message ?? '').slice(0, 300)}. ` +
    'The view keeps whatever it drew before, so it can look fine while its data never arrives: fix that line, or catch the error there and draw an empty state.'
}

/** 窗口级 error / unhandledrejection 的入口(导出给测试)。 */
export function noteAgentSpaceRuntimeError(err: unknown): void {
  const url = agentSpaceSourceUrl(agentPluginId('muse')) // 没在跑 → null:旧版 / 没跑起来的版本留下的错一概不报
  const text = url && agentSpaceRuntimeError(err, url)
  if (!url || !text) return
  if (url !== runtimeKey) { runtimeKey = url; runtimeSeen = new Set() } // 换了一版:重新计,旧版的记录不留
  const seen = runtimeSeen
  if (seen.has(text) || seen.size >= RUNTIME_MAX) return
  seen.add(text)
  const cfg = runtimeCfg
  if (!cfg) { runtimePending.push({ url, text }); return }
  void postMuseFeedback(homeTarget(), text).catch(() => { seen.delete(text) })
}

function listenRuntimeErrors(): void {
  if (runtimeHooked || typeof window === 'undefined') return
  runtimeHooked = true
  window.addEventListener('error', (e) => noteAgentSpaceRuntimeError(e.error))
  window.addEventListener('unhandledrejection', (e) => noteAgentSpaceRuntimeError(e.reason))
}

function hookRuntimeErrors(cfg: TanguDesktopConfig): void {
  runtimeCfg = cfg
  const queued = runtimePending
  runtimePending = []
  const live = agentSpaceSourceUrl(agentPluginId('muse'))
  const seen = runtimeSeen
  for (const q of queued) {
    // 排队期间换了版 / 拆掉了:旧版的错不补(Codex 09-27)
    if (q.url === live) void postMuseFeedback(homeTarget(), q.text).catch(() => { seen.delete(q.text) })
  }
  listenRuntimeErrors()
}

// 模块加载就挂上(渲染进程):插件视图的挂载 effect 先于 MuseHome 自己的 effect 跑,首次 status 往返之前 Space 就可能抛了 ——
// 等拿到 cfg 再挂会漏掉这一段(Codex 09-27)。这期间认出的先排队,首次同步 Muse 时补发。
listenRuntimeErrors()

/** 测试用:清掉戳记忆。 */
export function __resetAgentSpaceSync(): void { loadedStamp.clear(); reportedStamp.clear(); mountReported = new WeakMap(); runtimeKey = ''; runtimeSeen = new Set(); runtimeCfg = null; runtimePending = []; unsentReport.clear() }
