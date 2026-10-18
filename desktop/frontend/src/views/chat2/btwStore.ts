/**
 * 旁聊(/btw):带着会话上下文问一句题外话。渲染层这半 = 按会话存线程 + 流式请求引擎
 * `POST /agent/sessions/:id/aside`(tangu-agent services/aside.ts:不落库、无工具、不排主 run 的队)。
 *
 * 形态(2026-09-22 定,对标 Claude Code / Claude Desktop 的 /btw;10-18「挂点统一」改了打开位置与落库):
 *  - 桌面 / Web 主窗 = 对话右边那块子会话面板(ChildChatPanel,一次只开一个:开着子会话再点顺便问就换成顺便问)。
 *    卫星窗(独立窗 / Mini)里没有那块面板 → 仍开原生 Floating Panel(id `btw:<会话>`,会话级显隐见主进程 syncSessionPanels)。
 *  - 手机 = 全屏二级页(BtwHost page)。
 *  - 右侧栏视图 `btw-panel` 仍可手动放进侧栏,跟着主窗当前会话走。
 *  - 落库(10-18 用户「顺便问留下来」):每答完一问引擎写进 chat_asides,挂在某条消息上(anchors 记本会话当前这段挂在哪、记录 id);
 *    「从这里分出」里的那一行重开 = 把存下来的往返载回 threads。仍不进主对话的上下文、不进左栏、无工具。
 *  - 不写回主对话。要带回去由用户点「带回这里」:主窗输入框挂成引用,不动草稿(MainAction 'chat-quote')。
 */
import { create } from 'zustand'
import { useWorkspace } from '@lcl/engine'
import { registerMessages, translate } from '../../i18n'
import { engineFetch, targetForSession } from '../../services/engine/targets'
import { classify, classifyError, noteVerdict } from '../../services/engine/health'
import { AGENT_APP_ID, currentClientId, noteExtra, unitFailureMessage } from '../../services/agentRunService'
import { useApp } from '../../stores/appStore'
import { useChildChat } from '../../stores/childChatStore'
import { deleteAside, listAsides, type SavedAside } from '../../services/backendService'
import { windowKind } from '../../windowKind'

registerMessages({
  'btw.title': { zh: '顺便问', en: 'By the way' },
  'btw.windowTitle': { zh: '顺便问 · {title}', en: 'By the way · {title}' },
  'btw.context': { zh: '当前对话', en: 'Conversation' },
  'btw.hint': { zh: '带着本会话上下文提问，不会加入对话，也不打断正在跑的任务', en: 'Uses this conversation as context. Not added to it, and never interrupts a running task.' },
  'btw.sideEmpty': { zh: '打开一个对话后，可以在这里顺便问', en: 'Open a conversation to ask side questions here' },
  'btw.empty': { zh: '问点与当前对话有关的事：概念、代码、刚才那步为什么这么做……', en: 'Ask about anything in this conversation: a concept, some code, why a step was taken…' },
  'btw.placeholder': { zh: '顺便问点什么…', en: 'Ask a side question…' },
  'btw.defaultQuestion': { zh: '解释一下这段', en: 'Explain this' },
  'btw.send': { zh: '发送', en: 'Send' },
  'btw.stop': { zh: '停止', en: 'Stop' },
  'btw.clear': { zh: '清空旁聊', en: 'Clear side chat' },
  'btw.copy': { zh: '复制', en: 'Copy' },
  'btw.copied': { zh: '已复制', en: 'Copied' },
  'btw.quoteToChat': { zh: '带回这里', en: 'Bring back' },
  'btw.quoted': { zh: '已带回输入框', en: 'Brought back to the chat box' },
  'btw.removeQuote': { zh: '移除引用', en: 'Remove quote' },
  'btw.thinking': { zh: '思考中…', en: 'Thinking…' },
  'btw.stopped': { zh: '已停止', en: 'Stopped' },
  'btw.noTools': { zh: '旁聊不能用工具，上面提到的操作都没有执行。', en: 'Side chats have no tools. Nothing mentioned above was run.' },
  'btw.errCut': { zh: '连接中断，回答不完整', en: 'The connection dropped before the answer finished' },
  'btw.errUnsupported': { zh: '当前引擎还不支持旁聊，请更新 Forsion', en: 'This engine does not support side questions yet. Update Forsion.' },
  'btw.close': { zh: '关闭', en: 'Close' },
  'btw.selectionAction': { zh: '顺便问', en: 'Ask aside' },
  'btw.cmd': { zh: '顺便问（旁聊）', en: 'Ask a side question' },
})

export interface BtwTurn {
  id: string
  question: string
  quote?: string
  answer: string
  status: 'streaming' | 'done' | 'error' | 'stopped'
  error?: string
  /** 模型把工具调用写成了文本(旁聊没有工具)→ 面板补一句「什么都没执行」。 */
  toolCallText?: boolean
}

/** 打开旁聊时递给面板的一次性指令:带 question 就直接问,只带 quote 就挂成引用等用户打字。
 *  nonce 唯一,面板据此只消费一次 —— Web 上切走会话再切回会重挂面板,不能把同一个问题再问一遍。
 *  sessionId = 上下文会话;scope = 开的时候主窗当前会话(团队成员子聊天里两者不同),会话级显隐按 scope 判。 */
export interface BtwSeed {
  sessionId: string; scope?: string | null; title?: string; quote?: string; question?: string; modelId?: string; nonce: string
  /** 挂点:从哪条消息问的(消息操作条的「顺便问」带上;输入框 /btw 不带 → 引擎挂到最近一条回答)。和当前这段的挂点不同 → 另起一段。 */
  messageId?: string
  /** 重开存下来的那一段(「从这里分出」里点的)。 */
  asideId?: string
}

/** 与引擎 ASIDE_MAX_TURNS 同值:更早的往返不再带给模型。 */
const MAX_TURNS = 20
const controllers = new Map<string, AbortController>()
const savedLoads = new Set<string>()
const consumedSeeds = new Set<string>()
let seedSeq = 0

/** 这条指令第一次见 → true(并记下);同一 nonce 再来 → false。 */
export function consumeSeed(seed: BtwSeed): boolean {
  if (consumedSeeds.has(seed.nonce)) return false
  consumedSeeds.add(seed.nonce)
  return true
}

/** Web / 手机的旁聊此刻该不该露面:只在它归属的会话仍是当前会话时。BtwHost 渲染与安卓返回键共用这一条。 */
export function btwWebVisible(seed: BtwSeed | null, activeId: string | null): seed is BtwSeed {
  return !!seed && (!seed.scope || seed.scope === activeId)
}

/** 浮窗收到的 params(跨 IPC 的普通对象)→ 指令;缺会话或 nonce 就不是旁聊。 */
export function btwSeedOf(params: Record<string, unknown> | undefined): BtwSeed | null {
  const s = (k: string): string | undefined => (typeof params?.[k] === 'string' && (params[k] as string) ? params[k] as string : undefined)
  const sessionId = s('sessionId')
  const nonce = s('nonce')
  return sessionId && nonce ? { sessionId, nonce, scope: s('scope'), title: s('title'), quote: s('quote'), question: s('question'), modelId: s('modelId'), messageId: s('messageId'), asideId: s('asideId') } : null
}

interface BtwState {
  threads: Record<string, BtwTurn[]>
  /** Web / 手机当前开着的旁聊(桌面走原生浮窗,不用它)。只在它的会话仍是当前会话时显示。 */
  webOpen: BtwSeed | null
  /** 各会话旁聊输入区里还没发出去的东西(草稿 + 挂着的引用)。放 store 不放组件:侧栏 / Web 的面板随会话切换重挂,放组件里切走就丢。 */
  compose: Record<string, { draft: string; quote?: string }>
  /** 各会话当前这段旁聊挂在哪条消息上、存成了哪条记录(第一问答完引擎回 asideId)。 */
  anchors: Record<string, { messageId?: string; asideId?: string }>
  /** 各会话存下来的顺便问(「从这里分出」按 message_id 取)。 */
  saved: Record<string, SavedAside[]>
  setCompose(sessionId: string, patch: { draft?: string; quote?: string | undefined }): void
  loadSaved(sessionId: string, force?: boolean): void
  /** 按指令切到对应的一段:asideId → 载回那条记录;换了挂点 → 另起一段;否则接着当前这段。 */
  applySeed(seed: BtwSeed): void
  ask(sessionId: string, question: string, quote?: string, modelId?: string): Promise<void>
  stop(sessionId: string): void
  clear(sessionId: string): void
  closeWeb(): void
}

export const useBtw = create<BtwState>((set, get) => ({
  threads: {},
  webOpen: null,
  compose: {},
  anchors: {},
  saved: {},
  setCompose: (sessionId, patch) => set((s) => ({ compose: { ...s.compose, [sessionId]: { ...(s.compose[sessionId] ?? { draft: '' }), ...patch } } })),

  loadSaved: (sessionId, force) => {
    if (!force && (savedLoads.has(sessionId) || get().saved[sessionId])) return
    savedLoads.add(sessionId)
    void listAsides(targetForSession(sessionId), sessionId)
      .then((rows) => set((s) => ({ saved: { ...s.saved, [sessionId]: rows } })))
      .catch(() => {}) // 老引擎没有这条路由 / 离线:就是没有存下来的
      .finally(() => savedLoads.delete(sessionId))
  },

  applySeed: (seed) => {
    const sid = seed.sessionId
    const cur = get().anchors[sid] || {}
    if (seed.asideId) {
      if (cur.asideId === seed.asideId) return
      const rec = get().saved[sid]?.find((a) => a.id === seed.asideId)
      if (!rec || controllers.has(sid)) return
      const turns: BtwTurn[] = rec.turns.map((x, i) => ({ id: `${rec.id}-${i}`, question: x.question, quote: x.quote, answer: x.answer, status: 'done' }))
      set((s) => ({ threads: { ...s.threads, [sid]: turns }, anchors: { ...s.anchors, [sid]: { asideId: rec.id, messageId: rec.message_id || undefined } } }))
      return
    }
    if (seed.messageId && seed.messageId !== cur.messageId && !controllers.has(sid)) {
      set((s) => ({ threads: { ...s.threads, [sid]: [] }, anchors: { ...s.anchors, [sid]: { messageId: seed.messageId } } }))
    }
  },

  ask: async (sessionId, question, quote, modelId) => {
    if (!question.trim() || controllers.has(sessionId)) return // 一次一问:上一问还在流
    const prior = get().threads[sessionId] || []
    const id = `btw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    const patch = (fn: (t: BtwTurn) => Partial<BtwTurn>): void => set((s) => ({
      threads: { ...s.threads, [sessionId]: (s.threads[sessionId] || []).map((t) => (t.id === id ? { ...t, ...fn(t) } : t)) },
    }))
    set((s) => ({ threads: { ...s.threads, [sessionId]: [...prior, { id, question, quote, answer: '', status: 'streaming' }] } }))
    const ac = new AbortController()
    controllers.set(sessionId, ac)
    const thread = prior.filter((t) => t.status === 'done' && t.answer).slice(-MAX_TURNS)
      .map((t) => ({ question: t.question, quote: t.quote, answer: t.answer }))
    const anchor = get().anchors[sessionId] || {}
    try {
      await streamAside(sessionId, { question, quote, thread, model_id: modelId || undefined, message_id: anchor.messageId, aside_id: anchor.asideId }, (ev) => {
        if (ev.type === 'delta') patch((t) => ({ answer: t.answer + String(ev.text ?? '') }))
        else if (ev.type === 'done') {
          patch((t) => ({ answer: String(ev.content || t.answer), status: 'done', toolCallText: !!ev.toolCallText }))
          if (ev.asideId) {
            set((s) => ({ anchors: { ...s.anchors, [sessionId]: { messageId: ev.asideMessageId || s.anchors[sessionId]?.messageId, asideId: ev.asideId } } }))
            get().loadSaved(sessionId, true)
          }
        }
        else if (ev.type === 'error') patch(() => ({ status: 'error', error: readableError(String(ev.error || '')) }))
      }, ac.signal)
      patch((t) => (t.status === 'streaming' ? { status: 'error', error: translate('btw.errCut') } : {}))
    } catch (e: any) {
      patch((t) => (t.status !== 'streaming' ? {} : ac.signal.aborted ? { status: 'stopped' } : { status: 'error', error: readableError(String(e?.message || e)) }))
    } finally {
      if (controllers.get(sessionId) === ac) controllers.delete(sessionId)
    }
  },

  stop: (sessionId) => controllers.get(sessionId)?.abort(),

  /** 清空 = 删掉存下来的这一段(「从这里分出」里那一行也没了),下一问另起一段。 */
  clear: (sessionId) => {
    controllers.get(sessionId)?.abort()
    controllers.delete(sessionId)
    const { asideId, messageId } = get().anchors[sessionId] || {}
    set((s) => ({ threads: { ...s.threads, [sessionId]: [] }, anchors: { ...s.anchors, [sessionId]: { messageId } } }))
    if (asideId) {
      set((s) => ({ saved: { ...s.saved, [sessionId]: (s.saved[sessionId] || []).filter((a) => a.id !== asideId) } }))
      void deleteAside(targetForSession(sessionId), sessionId, asideId).catch(() => {}) // 远端连着时引擎不许删:本端先不显示,重开会话后还在
    }
  },

  closeWeb: () => set({ webOpen: null }),
}))

/** 引擎的机器码 → 人话:额度用尽与主聊天同一句(chat.err.quota)。 */
const readableError = (raw: string): string => (/token_quota_exceeded/i.test(raw) ? translate('chat.err.quota') : raw)

type AsideEvent = { type: 'delta'; text?: string } | { type: 'done'; content?: string; toolCallText?: boolean; asideId?: string; asideMessageId?: string } | { type: 'error'; error?: string }

async function streamAside(sessionId: string, body: Record<string, unknown>, onEvent: (ev: AsideEvent) => void, signal: AbortSignal): Promise<void> {
  // P1-K6:旁聊按会话所在的目标发(那台是「我的电脑」时走 hub 隧道);经解析层,不再自拼 URL / 鉴权头。
  // 一次性流,不做续订:unit 离线 / 引擎没起 / 设备被移除直接给人话(engine.target.*)。
  const t = targetForSession(sessionId)
  let r: Response
  try {
    r = await engineFetch(t, `/agent/sessions/${encodeURIComponent(sessionId)}/aside`, {
      method: 'POST',
      signal,
      body: JSON.stringify({ ...body, app_id: AGENT_APP_ID, client: currentClientId() }),
    })
  } catch (e) {
    if (t.via === 'unit' && !signal.aborted) {
      const v = classifyError(e)
      throw new Error(unitFailureMessage(t, v, (e as { code?: unknown })?.code) || String((e as Error)?.message || e))
    }
    throw e
  }
  if (!r.ok || !r.body) {
    const raw = await r.text().catch(() => '')
    let detail = ''
    let code: string | undefined
    let j: unknown = null
    try { j = JSON.parse(raw); detail = String((j as { detail?: unknown })?.detail || ''); const c = (j as { code?: unknown })?.code; code = typeof c === 'string' ? c : undefined } catch { /* 非 JSON = 老引擎没有这条路由(Express 的 Cannot POST 页) */ }
    if (t.via === 'unit') {
      const v = classify(r.status, { code })
      noteVerdict(t.key, v, noteExtra(j))
      const msg = unitFailureMessage(t, v, code, j) // P1-KF:拒绝按 reason / state 分句
      if (msg && v !== 'fatal') throw new Error(msg)
    }
    throw new Error(detail || (r.status === 404 ? translate('btw.errUnsupported') : `HTTP ${r.status}`))
  }
  // 经网关代理时整段缓冲后一次到达也照样能解析,只是退化成非流式。
  const reader = r.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      try { onEvent(JSON.parse(line.slice(5))) } catch { /* 坏行跳过 */ }
    }
  }
}

/**
 * 打开某会话的旁聊。主窗(桌面 / Web)开在对话右边的子会话面板;卫星窗开原生浮窗;手机挂到本页的 BtwHost(全屏二级页)。
 * 会话归属(浮窗的 sessionId,主进程据此显隐)取**主窗当前会话**而不是 opts.sessionId:在团队成员子聊天里问,
 * 上下文是子会话,但用户「在」的仍是父会话 —— 拿子会话当归属,浮窗一出生就会被判「不在当前会话」藏起来。
 * 卫星窗(独立窗 / Mini)里的 activeId 不可信,那里开的旁聊不绑会话,当普通浮窗。
 */
export function openBtw(opts: { sessionId: string; title?: string | null; quote?: string; question?: string; modelId?: string; messageId?: string; asideId?: string }): void {
  const scope = windowKind() === 'main' ? useApp.getState().activeId : null
  const seed: BtwSeed = { ...opts, title: opts.title || undefined, scope, nonce: `${Date.now().toString(36)}-${++seedSeq}` }
  if (scope && !window.tangu?.mobile) {
    useChildChat.getState().open(scope, { id: `aside:${opts.sessionId}`, title: translate('btw.title'), aside: seed })
    return
  }
  const tangu = window.tangu
  if (tangu?.openFloatingPanel) {
    void tangu.openFloatingPanel({
      id: `btw:${opts.sessionId}`,
      title: translate('btw.windowTitle', { title: opts.title || translate('btw.title') }),
      builtin: 'btw',
      params: { ...seed },
      ...(scope ? { sessionId: scope } : {}),
    })
    return
  }
  useBtw.setState({ webOpen: seed })
}

/** 把旁聊的回答带回主对话:挂成主窗聊天输入框的引用,不覆盖草稿。浮窗里调 = 请主窗代办(各窗一份 store)。
 *  主窗:侧栏聊天在前台就交给它,否则交给主区聊天(没开就开一个跟随当前会话的,同 draftInMainChat)。 */
export function quoteInMainChat(text: string): void {
  const body = text.trim().slice(0, 20000)
  if (!body) return
  if (windowKind() !== 'main' && window.tangu?.requestMainAction) { window.tangu.requestMainAction('chat-quote', body); return }
  const ws = useWorkspace.getState()
  const panelFront = ws.rightVisible && ws.rightTabs.some((tab) => tab.type === 'chat-panel' && tab.active)
  useApp.getState().setPendingChatQuote(panelFront ? 'chat-panel' : 'chat', body)
  if (!panelFront) ws.openView('chat', { followActive: true, reuseKey: 'primary' }, 'main')
}
