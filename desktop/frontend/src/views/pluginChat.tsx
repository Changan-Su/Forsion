/**
 * `ctx.tangu.mountChat` 的宿主半身(2026-10-04):把原生对话挂进插件自己的视图 —— Image Studio 聊天栏那套
 * 姿势(固定会话的 ChatView + childSurface)对插件开放。探针(tanguProbe.mountChat)动态 import 本文件。
 *
 * 会话规则:一个(插件, 工作目录)一条。id 记在本机 localStorage,下次挂载先问引擎它还在不在:
 * 在 → 接回去(历史照常拉);被删 / 被归档 → 新开一条。工作目录进了键,所以项目挪了地方 = 新键 = 新会话,
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
})

const SLOTS = 'tangu.pluginChats'
const BACKEND_WAIT_MS = 15_000
const readSlots = (): Record<string, string> => {
  try { return JSON.parse(localStorage.getItem(SLOTS) || '{}') || {} } catch { return {} }
}
const errorText = (e: unknown): string => String((e as { message?: unknown } | null)?.message ?? e)

// 同一个槽同时只跑一次:视图「卸了立刻重挂」时两次挂载撞在一起,各建一条会话,先建的那条就成了列表里的空会话。
const inflight = new Map<string, Promise<TanguStartChatResult>>()

/** 接回这个(插件, 工作目录)的会话,没有就建。不抛:失败一律 `{ ok:false, error }`。 */
export function ensurePluginChat(o: TanguChatMountOptions): Promise<TanguStartChatResult> {
  const slot = `${o.owner}\n${o.cwd ?? ''}`
  const running = inflight.get(slot)
  if (running) return running
  const task = (async (): Promise<TanguStartChatResult> => {
    if (!(await waitBackend(BACKEND_WAIT_MS))) return { ok: false, error: 'engine is not connected' }
    const agent = o.agent?.trim() || undefined
    if (agent && !(await agentKnown(agent))) return { ok: false, error: `unknown agent: ${agent}` }
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
      ...(o.cwd
        ? { ...newSessionConfig(stickyDefaults(app.desktopConfig, true), {}), execMode: 'host' as const, cwd: o.cwd }
        : { ...stickyDefaults(app.desktopConfig, false), execMode: 'sandbox' as const }),
      ...(def?.thinkingLevel ? { thinkingLevel: def.thinkingLevel, ...(def.thinkingLevel !== 'max' ? { ultra: false } : {}) } : {}),
      ...(slug ? { agentSlug: slug } : {}),
    }, usePageStore.getState().vaultRoot || null))
    try {
      const created = await createSession(homeTarget(), {
        ...(o.title ? { title: o.title } : {}),
        ...(o.cwd ? { project_path: o.cwd, project_name: o.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || o.cwd } : { projectless: true }),
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
        ? <><span>{t('pluginChat.failed', { error: state.error || '' })}</span><button className="btn ghost sm" onClick={retry}>{t('common.retry')}</button></>
        : <span>{t('common.loading')}</span>}
    </div>
  )
}

export function mountPluginChat(el: HTMLElement, o: TanguChatMountOptions): { ready: Promise<TanguStartChatResult>; dispose(): void } {
  const type = pluginChatType(o)
  // 插件的 mount(el) 拿不到 Leaf,而 ChatView 要一个:标题 / 参数 / 关闭都归插件自己的视图管,这里一律空操作。
  // type 是引用通道认的目标名(tanguProbe.mountChat 的 quote 往这个名字投);有 childSurface 时 loc 不参与任何判断。
  const leaf: Leaf = { id: type, type, loc: 'right', params: {}, setTitle() {}, setParams() {}, close() {} }
  let alive = true
  let unmount = (): void => {}
  const render = (state: TanguStartChatResult | null): void => {
    if (alive) unmount = mountHostReact(el, <HostLocaleProvider><PluginChat leaf={leaf} state={state} retry={() => void attach()} /></HostLocaleProvider>)
  }
  const attach = (): Promise<TanguStartChatResult> => {
    render(null)
    return ensurePluginChat(o).then((result) => { render(result); return result })
  }
  return { ready: attach(), dispose() { if (alive) { alive = false; unmount() } } }
}
