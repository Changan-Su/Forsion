/**
 * `ctx.tangu.mountChat` 的宿主半身(2026-10-04):把原生对话挂进插件自己的视图 —— Image Studio 聊天栏那套
 * 姿势(固定会话的 ChatView + childSurface)对插件开放。探针(tanguProbe.mountChat)动态 import 本文件。
 *
 * 会话规则:一个(插件, 工作目录)一条。id 记在本机 localStorage,下次挂载先问引擎它还在不在:
 * 在 → 接回去(历史照常拉);被删 / 被归档 → 新开一条。工作目录(绝对路径)进了键,所以项目挪了地方 = 新键 = 新会话,
 * 不会接到一条还指着旧目录的会话上。
 */
import { mountHostReact } from '@lcl/components'
import type { Leaf } from '@lcl/engine'
import { pluginChatType, type TanguChatMountOptions, type TanguStartChatResult } from '@amadeus/plugins/tanguSeam'
import { usePageStore } from '../amadeus/store/pageStore'
import { HostLocaleProvider, registerMessages, useI18n } from '../i18n'
import { createSession, getSessionDetail } from '../services/backendService'
import { homeTarget } from '../services/engine/targets'
import { stickyDefaults, useApp, withAmadeusWorkspace } from '../stores/appStore'
import { newSessionConfig, settleUltra } from '../stores/projectSettings'
import { agentKnown, waitBackend } from '../tanguProbe'
import type { AgentConfig } from '../types'
import { ChatView } from './ChatView'

registerMessages({
  'pluginChat.failed': { zh: '对话没接上：{error}', en: 'Could not open the chat: {error}' },
  'pluginChat.noEngine': { zh: '引擎还没连上', en: 'the engine is not connected' },
  'pluginChat.noFolder': { zh: '这台设备上打不开这个文件夹', en: 'this folder is not available on this device' },
  'pluginChat.noAgent': { zh: '没有这个 Agent：{agent}', en: 'no such agent: {agent}' },
})

// 给插件的 error 是固定的英文原因(与 startChat 一个口径);挂载里显示给人看的那一份照界面语言说。
const NO_ENGINE = 'engine is not connected'
const NO_FOLDER = 'folder is not available on this host: '
const NO_AGENT = 'unknown agent: '

const SLOTS = 'tangu.pluginChats'
const BACKEND_WAIT_MS = 15_000
const readSlots = (): Record<string, string> => {
  try { return JSON.parse(localStorage.getItem(SLOTS) || '{}') || {} } catch { return {} }
}
const errorText = (e: unknown): string => String((e as { message?: unknown } | null)?.message ?? e)

// 同一个槽同时只跑一次:视图「卸了立刻重挂」时两次挂载撞在一起,各建一条会话,先建的那条就成了列表里的空会话。
// 键是落盘用的那个槽(插件 + 绝对工作目录),不是插件给的相对文件夹:换了笔记库之后同名文件夹是另一个槽,
// 不能接到上一个库还在建的那条上;同一个目录的两种写法(`a/b` 与 `a\b`)则是同一个槽。
const inflight = new Map<string, Promise<TanguStartChatResult>>()

/** 接回这个(插件, 工作目录)的会话,没有就建。不抛:失败一律 `{ ok:false, error }`。 */
export async function ensurePluginChat(o: TanguChatMountOptions): Promise<TanguStartChatResult> {
  if (!(await waitBackend(BACKEND_WAIT_MS))) return { ok: false, error: NO_ENGINE }
  // 工作目录等后端就绪了才解析(刚启动时桌面配置 / 笔记库还没回来)。给了文件夹却落不到本机路径 = 接不上,
  // 不悄悄退成沙箱对话:那样 Agent 碰不到项目文件,而且会占住「无目录」那个槽。
  const cwd = o.resolveCwd?.() || undefined
  if (o.folder && !cwd) return { ok: false, error: `${NO_FOLDER}${o.folder}` }
  const slot = `${o.owner}\n${cwd ?? ''}`
  const running = inflight.get(slot) // 从解析到登记之间没有 await:并发的两次挂载,后到的一定看得见先到的
  if (running) return running
  const task = (async (): Promise<TanguStartChatResult> => {
    const agent = o.agent?.trim() || undefined
    if (agent && !(await agentKnown(agent))) return { ok: false, error: `${NO_AGENT}${agent}` }
    const known = readSlots()[slot]
    if (known) {
      try {
        const session = await getSessionDetail(homeTarget(), known)
        if (!session.archived) {
          useApp.getState().adoptSession(session) // 不带 fresh:历史与活跃 run 的订阅由 ChatView 照常拉
          return { ok: true, sessionId: session.id }
        }
      } catch (e) {
        // 只有「没有这条会话」才新开;连不上 / 超时就报错让用户重试,别因为一次抖动把对话换掉。
        if ((e as { status?: number } | null)?.status !== 404) return { ok: false, error: errorText(e) }
      }
    }
    const app = useApp.getState()
    const def = agent ? app.agentDefs.find((a) => a.slug === agent) : undefined
    const slug = agent ?? app.defaultAgentSlug
    // 与「在某个本机项目里新建对话」(appStore.createInWorkspace)同一份配方,只是不动主区:
    // 上次用的审批 / 思考档 → 本机执行 + 工作目录 → Agent 自带的思考档压过它(同 selectNewChatAgent)。
    const init: AgentConfig = settleUltra(withAmadeusWorkspace({
      ...(cwd
        ? { ...newSessionConfig(stickyDefaults(app.desktopConfig, true), {}), execMode: 'host' as const, cwd }
        : { ...stickyDefaults(app.desktopConfig, false), execMode: 'sandbox' as const }),
      ...(def?.thinkingLevel ? { thinkingLevel: def.thinkingLevel, ...(def.thinkingLevel !== 'max' ? { ultra: false } : {}) } : {}),
      ...(slug ? { agentSlug: slug } : {}),
    }, usePageStore.getState().vaultRoot || null))
    try {
      const created = await createSession(homeTarget(), {
        ...(o.title ? { title: o.title } : {}),
        ...(cwd ? { project_path: cwd, project_name: cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd } : { projectless: true }),
        ...(def?.model ? { model_id: def.model } : {}),
        agent_config: init,
      })
      useApp.getState().adoptSession({ ...created, agent_config: created.agent_config || init }, { fresh: true })
      // ponytail: 一张不分账号的表;换账号后旧 id 查无此会话 → 新开并覆盖。要按账号各记一份时把账号并进键。
      try { localStorage.setItem(SLOTS, JSON.stringify({ ...readSlots(), [slot]: created.id })) } catch { /* 记不住 = 下次新开一条 */ }
      return { ok: true, sessionId: created.id }
    } catch (e) {
      return { ok: false, error: errorText(e) }
    }
  })()
  inflight.set(slot, task)
  void task.finally(() => { inflight.delete(slot) })
  return task
}

const failureText = (error: string, t: (key: string, vars?: Record<string, string>) => string): string =>
  error === NO_ENGINE ? t('pluginChat.noEngine')
    : error.startsWith(NO_FOLDER) ? t('pluginChat.noFolder')
      : error.startsWith(NO_AGENT) ? t('pluginChat.noAgent', { agent: error.slice(NO_AGENT.length) })
        : error

function PluginChat({ leaf, state, retry }: { leaf: Leaf; state: TanguStartChatResult | null; retry(): void }) {
  const { t } = useI18n()
  if (state?.ok && state.sessionId) return (
    <div data-plugin-chat={leaf.type} style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <ChatView key={state.sessionId} leaf={leaf} params={{ followActive: false, sessionId: state.sessionId, childSurface: true }} />
    </div>
  )
  return (
    <div className="empty-state" data-plugin-chat={leaf.type} role={state ? 'alert' : 'status'} style={{ height: '100%', padding: 16, textAlign: 'center' }}>
      {state
        ? <><span>{t('pluginChat.failed', { error: failureText(state.error || '', t) })}</span><button className="btn ghost sm" onClick={retry}>{t('common.retry')}</button></>
        : <span>{t('common.loading')}</span>}
    </div>
  )
}

/** `ready` 是第一次接的结果;`latest()` 是最近一次的(用户在挂载里点了「重试」之后,以重试的为准)。 */
export function mountPluginChat(el: HTMLElement, o: TanguChatMountOptions, onDispose?: () => void): { ready: Promise<TanguStartChatResult>; latest(): Promise<TanguStartChatResult>; dispose(): void } {
  const type = pluginChatType(o)
  // 插件的 mount(el) 拿不到 Leaf,而 ChatView 要一个:标题 / 参数 / 关闭都归插件自己的视图管,这里一律空操作。
  // type 是引用通道认的目标名(tanguProbe.mountChat 的 quote 往这个名字投);有 childSurface 时 loc 不参与任何判断。
  const leaf: Leaf = { id: type, type, loc: 'right', params: {}, setTitle() {}, setParams() {}, close() {} }
  // 对话接上之后宿主还会自己再画(加载中 → 接上 / 重试):一律走这次挂载的句柄。句柄卸了、或者插件没 dispose 就把 el 交给了
  // 别的挂载之后,晚到的那次重画是空操作,顶不掉后来那份。dispose() 之后 el 立刻还给插件(清空它、在同一个 el 上再挂都行)。
  const mounted = mountHostReact(el, null, onDispose)
  const render = (state: TanguStartChatResult | null): void =>
    mounted.render(<HostLocaleProvider><PluginChat leaf={leaf} state={state} retry={() => void attach()} /></HostLocaleProvider>)
  let current: Promise<TanguStartChatResult>
  const attach = (): Promise<TanguStartChatResult> => {
    render(null)
    current = ensurePluginChat(o).then((result) => { render(result); return result })
    return current
  }
  return { ready: attach(), latest: () => current, dispose: mounted.dispose }
}
