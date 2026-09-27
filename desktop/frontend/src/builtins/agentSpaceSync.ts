/**
 * Agent 自建 Space 插件的热重载(2026-09-11)。**不监听文件**:引擎在 Muse 周期收尾时刷新 status.spaceStamp
 * (Space 目录内最大 mtime),桌面看到戳变了才只重载 `agent-<slug>` 这一个插件(pluginStore.reloadOne;全量
 * reloadExternal 会把所有插件拆装一遍并关掉它们的标签页)。加载失败(setup 抛错 / manifest 缺失、坏或被门禁挡下 /
 * 装上了却没注册 home 视图)经 /agent/special/muse/feedback 回写成 [feedback] 行,Muse 下个周期自己修。
 * 调用点:MuseView 轮询(4s)+ MuseHome 挂载(20s),按戳去重,谁先看到谁做;应用刚起第一次观察到戳会白重载一次(无害)。
 */
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import { postMuseFeedback } from '../services/backendService'
import type { TanguDesktopConfig } from '../types'

const loadedStamp = new Map<string, number>()
const reportedStamp = new Map<string, number>()

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
  if (typeof stamp !== 'number') return // 旧引擎没有戳 → 不同步(启动时装的那份就是全部)
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
    void postMuseFeedback(cfg, text).catch(() => {})
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

/** 测试用:清掉戳记忆。 */
export function __resetAgentSpaceSync(): void { loadedStamp.clear(); reportedStamp.clear() }
