/** 旁聊(/btw)面板:主窗挂在对话右边的子会话面板(ChildChatPanel),卫星窗挂原生 Floating Panel(FloatingRoot),
 *  Web / 手机经 BtwHost 挂在本页。输入区是共用 Chat Box(components/chatbox):「+」/ 粘贴 / 拖入加图片和文件,
 *  附件只给这一问(10-24 方案 A)。数据与形态说明见 btwStore.ts。
 *
 *  11-22 改版(docs/ToBeImproved/顺便问面板方案_2026-11-22,用户选 A + 传话):
 *  - 头压成一行:「顺便问」+ 段落胶囊(这条回答上存下来的几段收进它的下拉)+ ＋ 新的一段 + ✕。原来常驻的
 *    「当前对话 / 说明 / 段落列表」三层去掉;说明只在空的时候出现。
 *  - 顶上一张挂点卡:这一段挂在哪条回答上,点了主对话滚到那条。
 *  - 回答里的 ```relay 块画成「转给主对话」卡(btwRelay.ts):模型只拟稿,发不发由用户点。
 *  chrome='own' = 宿主没有自己的标题栏(主窗右边那块面板、手机全屏页),头里画标题和 ✕;
 *  'framed' = 宿主已有标题栏(原生浮窗、网页窄浮层、右侧栏视图),头里只放段落胶囊和 ＋。 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ClipboardEvent, type KeyboardEvent } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, ChevronDown, Copy, CornerUpLeft, Loader2, MessageCircleQuestion, MessageSquareQuote, Plus, Quote, Send, Square, Trash2, X } from 'lucide-react'
import { OverlayAt } from '@lcl/engine'
import { useI18n } from '../../i18n'
import { activeChatModelId, newChatModelId, useApp } from '../../stores/appStore'
import { Markdown } from '../../components/Markdown'
import { FloatingPanelFrame } from '../../components/FloatingPanelFrame'
import { RemoveDialog } from '../../components/RemoveDialog'
import { AttachmentTile, isLeaving, tileKey, type TileFile } from '../../components/AttachmentTile'
import { ChatBox, type ChatBoxSelection } from '../../components/chatbox'
import { windowKind } from '../../windowKind'
import {
  asidesOnMessage, btwWebVisible, consumeSeed, mergeBtwAttachments, quoteInMainChat, readBtwFiles, useBtw,
  type BtwAttachment, type BtwAttachmentMeta, type BtwSeed, type BtwTurn,
} from './btwStore'
import { canSendRelay, composeRelay, onRelaysChanged, openRelayTarget, relaySentFrom, relayTargets, sendRelay, splitRelay } from './btwRelay'
import './btw.css'

const EMPTY: BtwTurn[] = []
const NO_ATTACHMENTS: BtwAttachment[] = []

/** 落库的附件记录 → 磁贴:有缩略图的画成方块小图,没有的(文件 / 老记录)画成文件条。 */
const tileOf = (a: BtwAttachmentMeta): TileFile => {
  const m = a.thumb ? /^data:([^;,]+);base64,(.+)$/.exec(a.thumb) : null
  return m ? { name: a.name, mimeType: m[1], data: m[2], size: a.size } : { name: a.name, mimeType: a.mimeType, size: a.size }
}

/** 一行纯文字摘要(挂点卡、菜单副标题):去掉 markdown 记号与多余空白。 */
const plain = (s: string): string => s.replace(/```[\s\S]*?```/g, ' ').replace(/^\s*(?:[-+*]|\d+[.)])\s+/gm, '').replace(/[#*`>_~[\]|]/g, '').replace(/\s+/g, ' ').trim()

/** 点在 el 外面 / 按 Esc 就关(菜单)。 */
function useDismiss(open: boolean, refs: Array<{ current: HTMLElement | null }>, close: () => void): void {
  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent): void => { if (!refs.some((r) => r.current?.contains(e.target as Node))) close() }
    const key = (e: globalThis.KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); close() } }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key, true)
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key, true) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
}

const useRelaySent = (from: string, text: string | undefined, asideId?: string) =>
  useSyncExternalStore(onRelaysChanged, () => (text ? relaySentFrom(from, text, asideId) : undefined))

/** 「转给主对话」卡:模型拟好的一句,三个去处;发出去之后变成一行「已发 · 跳过去看」。 */
function RelayCard({ sessionId, text }: { sessionId: string; text: string }) {
  const { t } = useI18n()
  const title = useApp((s) => (s.sessions.find((x) => x.id === sessionId) || s.archivedSessions.find((x) => x.id === sessionId))?.title || '')
  const running = useApp((s) => !!s.runningBySession[sessionId])
  const anchor = useBtw((s) => s.anchors[sessionId])
  const sent = useRelaySent(sessionId, text, anchor?.asideId)
  const sentTitle = useApp((s) => (sent && sent.to !== sessionId ? s.sessions.find((x) => x.id === sent.to)?.title || '' : ''))
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [composed, setComposed] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const otherRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  useDismiss(!!menu, [menuRef, otherRef], () => setMenu(null))
  useEffect(() => {
    if (!composed) return
    const id = setTimeout(() => setComposed(false), 1600)
    return () => clearTimeout(id)
  }, [composed])
  const sendable = canSendRelay()
  const send = async (to: string): Promise<void> => {
    setMenu(null)
    setBusy(true); setFailed(false)
    const how = await sendRelay({ from: sessionId, to, text, asideId: anchor?.asideId, messageId: anchor?.messageId })
    setBusy(false)
    if (!how) setFailed(true)
  }
  const openMenu = (): void => {
    const el = otherRef.current
    if (!el) return
    if (menu) { setMenu(null); return }
    const r = el.getBoundingClientRect()
    setMenu({ x: r.left, y: r.bottom + 4 })
  }
  return (
    <div className="btw-relay" data-testid="btw-relay" data-sent={sent ? sent.how : undefined}>
      <div className="btw-relay-k"><Send size={12} />{t('btw.relay.to', { title: title || t('btw.relay.untitled') })}</div>
      {/* 原文照发什么就显示什么:纯文本,不渲染 Markdown(渲染会藏字、图片会外连) */}
      <div className="btw-relay-text" data-testid="btw-relay-text">{text}</div>
      {sent ? (
        <div className="btw-relay-row">
          <span className="btw-relay-done"><Check size={13} />{sent.to !== sessionId ? t('btw.relay.sentTo', { title: sentTitle || t('btw.relay.untitled') }) : t(sent.how === 'steer' ? 'btw.relay.steered' : 'btw.relay.sent')}</span>
          <span className="btw-grow" />
          {sendable && <button type="button" className="btw-act" onClick={() => openRelayTarget(sent.to)}>{t('btw.relay.open')}</button>}
        </div>
      ) : (
        <div className="btw-relay-row">
          {sendable && (
            <button type="button" className="btw-relay-send" data-testid="btw-relay-send" disabled={busy} onClick={() => void send(sessionId)}>
              {busy ? <Loader2 className="spin" size={12} /> : <Send size={12} />}{t(running ? 'btw.relay.steer' : 'btw.relay.send')}
            </button>
          )}
          <button type="button" className="btw-act" data-testid="btw-relay-compose" onClick={() => { composeRelay(text, sessionId); setComposed(true) }}>
            {composed ? <Check size={12} /> : null}{t(composed ? 'btw.relay.composed' : 'btw.relay.compose')}
          </button>
          {sendable && (
            <button ref={otherRef} type="button" className="btw-act" data-testid="btw-relay-other" aria-expanded={!!menu} disabled={busy} onClick={openMenu}>
              {t('btw.relay.other')}<ChevronDown size={12} />
            </button>
          )}
        </div>
      )}
      {failed && !sent && <div className="btw-error" role="alert">{t('btw.relay.failed')}</div>}
      {menu && (
        <OverlayAt className="ctx-menu btw-menu" x={menu.x} y={menu.y} innerRef={(el) => { menuRef.current = el }} data-testid="btw-relay-menu">
          <div className="ctx-head">{t('btw.relay.pick')}</div>
          {relayTargets(sessionId).map((x) => (
            <button key={x.id} type="button" onClick={() => void send(x.id)}>
              <span className="ctx-text"><span>{x.title || t('btw.relay.untitled')}</span>{x.running && <span className="ctx-detail">{t('btw.relay.running')}</span>}</span>
            </button>
          ))}
        </OverlayAt>
      )}
    </div>
  )
}

function TurnView({ turn, sessionId, onQuoted }: { turn: BtwTurn; sessionId: string; onQuoted?: () => void }) {
  const { t } = useI18n()
  const [done, setDone] = useState<'copy' | 'quote' | null>(null)
  useEffect(() => {
    if (!done) return
    const id = setTimeout(() => setDone(null), 1600)
    return () => clearTimeout(id)
  }, [done])
  // 只拆答完 / 还在流的;停掉 / 出错的原样显示(不给卡,也别把半截稿吞掉)
  const split = useMemo(() => (turn.status === 'done' || turn.status === 'streaming' ? splitRelay(turn.answer, turn.status === 'streaming') : { body: turn.answer, relay: undefined, partial: false }), [turn.answer, turn.status])
  const copy = (): void => { void navigator.clipboard.writeText(split.body).then(() => setDone('copy'), () => {}) }
  const quote = (): void => { quoteInMainChat(split.body); setDone('quote'); onQuoted?.() }
  return (
    <article className="btw-turn" data-status={turn.status}>
      {turn.quote && <blockquote className="btw-turn-quote">{turn.quote}</blockquote>}
      {!!turn.attachments?.length && (
        <div className="btw-turn-files" data-testid="btw-turn-files">
          {turn.attachments.map((a, i) => <AttachmentTile key={`${i}-${a.name}`} file={tileOf(a)} />)}
        </div>
      )}
      <div className="btw-turn-q">{turn.question}</div>
      {split.body
        ? <div className="t2-content btw-turn-a"><Markdown content={split.body} codeHead /></div>
        : turn.status === 'streaming' && !split.partial && <div className="btw-note"><Loader2 className="spin" size={13} /> {t(turn.describing ? 'btw.describing' : 'btw.thinking')}</div>}
      {split.partial && <div className="btw-note"><Loader2 className="spin" size={13} /> {t('btw.relay.drafting')}</div>}
      {split.relay && turn.status === 'done' && <RelayCard sessionId={sessionId} text={split.relay} />}
      {turn.status === 'error' && <div className="btw-error" role="alert">{turn.error}</div>}
      {turn.status === 'stopped' && <div className="btw-note">{t('btw.stopped')}</div>}
      {turn.toolCallText && <div className="btw-note">{t('btw.noTools')}</div>}
      {turn.attachNote && <div className="btw-note" data-attach-note={turn.attachNote}>{t(turn.attachNote === 'ignored' ? 'btw.att.ignored' : 'btw.att.transcribed')}</div>}
      {turn.status === 'done' && split.body && (
        <div className="btw-turn-actions">
          <button type="button" className="btw-act" onClick={copy}>
            {done === 'copy' ? <Check size={12} /> : <Copy size={12} />} {t(done === 'copy' ? 'btw.copied' : 'btw.copy')}
          </button>
          <button type="button" className="btw-act" data-testid="btw-quote-to-chat" onClick={quote}>
            {done === 'quote' ? <Check size={12} /> : <MessageSquareQuote size={12} />} {t(done === 'quote' ? 'btw.quoted' : 'btw.quoteToChat')}
          </button>
        </div>
      )}
    </article>
  )
}

/** 头上的段落胶囊:这条回答上存下来的几段(来源同「从这里分出」ForkBlock),点开是下拉;当前这段没存过就写「新的一段」。
 *  上一问还在流时不能换段。下拉底部「删掉这一段」(确认后删记录,同原来的橡皮擦)。 */
function SegPill({ sessionId, busy }: { sessionId: string; busy: boolean }) {
  const { t } = useI18n()
  const saved = useBtw((s) => s.saved[sessionId])
  const anchor = useBtw((s) => s.anchors[sessionId])
  const items = useMemo(() => asidesOnMessage(saved, anchor?.messageId), [saved, anchor?.messageId])
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [confirm, setConfirm] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  useDismiss(!!menu, [menuRef, btnRef], () => setMenu(null))
  const idx = anchor?.asideId ? items.findIndex((a) => a.id === anchor.asideId) : -1
  const label = idx >= 0 ? t('btw.seg.n', { i: String(idx + 1), n: String(items.length) }) : t('btw.list.new')
  if (!items.length) return <span className="btw-seg" data-testid="btw-seg">{label}</span>
  const toggle = (): void => {
    if (menu) { setMenu(null); return }
    const el = btnRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setMenu({ x: r.left, y: r.bottom + 4 })
  }
  const open = (id: string, messageId: string | null): void => {
    setMenu(null)
    useBtw.getState().applySeed({ sessionId, asideId: id, messageId: messageId || undefined, nonce: `list:${id}:${Date.now().toString(36)}` })
  }
  return (
    <>
      <button ref={btnRef} type="button" className="btw-seg" data-testid="btw-seg" aria-expanded={!!menu} disabled={busy} onClick={toggle}>
        <span>{label}</span><ChevronDown size={12} />
      </button>
      {menu && (
        <OverlayAt className="ctx-menu btw-menu" x={menu.x} y={menu.y} innerRef={(el) => { menuRef.current = el }} data-testid="btw-aside-list">
          <div className="ctx-head">{t('btw.seg.menu')}</div>
          {items.map((a) => {
            const first = a.turns[0]
            const last = a.turns[a.turns.length - 1]
            const cur = a.id === anchor?.asideId
            return (
              <button key={a.id} type="button" data-aside={a.id} aria-current={cur || undefined} className={cur ? 'btw-menu-cur' : undefined} onClick={() => open(a.id, a.message_id)}>
                <MessageCircleQuestion size={14} />
                <span className="ctx-text">
                  <span>{first?.question || t('btw.title')}</span>
                  {last?.answer && <span className="ctx-detail">{plain(splitRelay(last.answer).body)}</span>}
                </span>
                {a.turns.length > 1 && <span className="ctx-check">{a.turns.length}</span>}
              </button>
            )
          })}
          {idx >= 0 && (
            <>
              <div className="ctx-separator" />
              <button type="button" className="danger" data-testid="btw-seg-delete" onClick={() => { setMenu(null); setConfirm(true) }}>
                <Trash2 size={14} />{t('btw.seg.delete')}
              </button>
            </>
          )}
        </OverlayAt>
      )}
      {confirm && (
        <RemoveDialog title={t('btw.seg.deleteTitle')} message={t('btw.seg.deleteMsg')} confirmLabel={t('btw.seg.delete')}
          onConfirm={() => { setConfirm(false); useBtw.getState().clear(sessionId) }} onClose={() => setConfirm(false)} />
      )}
    </>
  )
}

/** 一行头。own:画标题 + ✕(宿主没有标题栏);framed:只放段落胶囊和 ＋。 */
function BtwHead({ sessionId, busy, own, onClose }: { sessionId: string; busy: boolean; own: boolean; onClose?: () => void }) {
  const { t } = useI18n()
  const hasTurns = useBtw((s) => (s.threads[sessionId] || EMPTY).length > 0)
  return (
    <div className={own ? 'agent-desk-head btw-head' : 'btw-head'} data-own={own || undefined}>
      {own && <MessageCircleQuestion size={15} />}
      {own && <strong className="agent-desk-title">{t('btw.title')}</strong>}
      <SegPill sessionId={sessionId} busy={busy} />
      <span className="btw-grow" />
      {hasTurns && (
        <button type="button" className="icon-btn" data-testid="btw-new" title={t('btw.list.new')} aria-label={t('btw.list.new')} disabled={busy} onClick={() => useBtw.getState().startNew(sessionId)}>
          <Plus size={15} />
        </button>
      )}
      {own && onClose && (
        <button type="button" className="icon-btn" aria-label={t('btw.close')} title={t('btw.close')} onClick={onClose}><X size={16} /></button>
      )}
    </div>
  )
}

/** 挂点卡:这一段挂在哪条回答上。没挂点(输入框 /btw 还没答)= 引擎会挂到最近一条回答,这里也显示那一条。
 *  消息还没载到本窗口(浮窗)就不画;载到了却找不到 = 被删了。 */
function AnchorCard({ sessionId }: { sessionId: string }) {
  const { t } = useI18n()
  const messageId = useBtw((s) => s.anchors[sessionId]?.messageId)
  const messages = useApp((s) => s.messagesBySession[sessionId])
  const target = useMemo(() => {
    if (!messages?.length) return null
    if (messageId) return messages.find((m) => m.id === messageId) || 'gone' as const
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'assistant' && messages[i].content.trim()) return messages[i]
    return null
  }, [messages, messageId])
  if (!target) return null
  if (target === 'gone') return <div className="btw-anchor" data-gone=""><span className="btw-anchor-k"><CornerUpLeft size={12} />{t('btw.anchor.gone')}</span></div>
  const jumpable = windowKind() === 'main'
  const text = plain(target.content).slice(0, 240)
  return (
    <button type="button" className="btw-anchor" data-testid="btw-anchor" disabled={!jumpable} title={jumpable ? t('btw.anchor.jump') : undefined}
      onClick={() => {
        // 这段的会话不是当前看着的(从别处的小标打开的):先切过去,跳转只在当前会话的聊天里生效
        const app = useApp.getState()
        if (app.activeId !== sessionId) app.setActiveId(sessionId)
        app.setJumpTarget(sessionId, target.id)
      }}>
      <span className="btw-anchor-k"><CornerUpLeft size={12} />{t('btw.anchor.about')}</span>
      <span className="btw-anchor-t">{text}</span>
    </button>
  )
}

/** onClose:Esc 且没有在流的回答时关掉宿主;onQuoted:回答被引用回主对话之后(Web / 手机据此收起,好让用户看见输入框)。 */
export function BtwPanel({ seed, onClose, onQuoted, chrome = 'framed' }: { seed: BtwSeed; onClose?: () => void; onQuoted?: () => void; chrome?: 'own' | 'framed' }) {
  const { t } = useI18n()
  const sessionId = seed.sessionId
  const turns = useBtw((s) => s.threads[sessionId] || EMPTY)
  const busy = turns.some((turn) => turn.status === 'streaming')
  const compose = useBtw((s) => s.compose[sessionId])
  const draft = compose?.draft ?? '', quote = compose?.quote
  const attachments = compose?.attachments ?? NO_ATTACHMENTS
  const setCompose = (patch: Parameters<ReturnType<typeof useBtw.getState>['setCompose']>[1]): void => useBtw.getState().setCompose(sessionId, patch)
  const setDraft = (text: string): void => setCompose({ draft: text })
  const setQuote = (text: string | undefined): void => setCompose({ quote: text })

  // 模型胶囊:缺省跟当前会话的模型(seed 带来的,或会话自己的),改了只管本会话的顺便问;思考档缺省关(旁聊原来的行为)
  const session = useApp((s) => s.sessions.find((x) => x.id === sessionId) || s.archivedSessions.find((x) => x.id === sessionId) || null)
  const sessionModel = useApp((s) => activeChatModelId({ ...s, activeSession: session }))
  const fallbackModel = useApp(newChatModelId)
  const selection: ChatBoxSelection = {
    modelId: compose?.modelId || seed.modelId || sessionModel || fallbackModel || '',
    thinkingLevel: compose?.thinkingLevel || 'off',
  }
  // 当前模型不能直接看图(或设置成「总是转写」)→ 图片磁贴上注明会先转成文字
  const noVision = useApp((s) => s.cfg.visionMode === 'always' || s.modelsResp?.models?.find((m) => m.id === selection.modelId)?.supportsVision === false)

  const rootRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const ask = (question: string, excerpt?: string, atts: BtwAttachment[] = []): void => {
    void useBtw.getState().ask(sessionId, question, excerpt, selection.modelId || seed.modelId, { attachments: atts, thinkingLevel: selection.thinkingLevel })
  }

  // 一次性指令:带问题直接问;只带引用就挂上,等用户打字(空着回车 = 「解释一下这段」)。
  // 上一问还在流(一次一问)→ 不能直接问,也不能丢(主窗输入框已经清空了):填进本面板输入框,答完再发。
  useEffect(() => {
    if (consumeSeed(seed)) {
      useBtw.getState().applySeed(seed)
      const streaming = (useBtw.getState().threads[sessionId] || []).some((turn) => turn.status === 'streaming')
      if (seed.question && !streaming) ask(seed.question, seed.quote)
      else {
        if (seed.question) setDraft(seed.question)
        if (seed.quote) setQuote(seed.quote)
      }
    }
    requestAnimationFrame(() => taRef.current?.focus())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed.nonce])

  // 头上的段落胶囊要存下来的那几段:新开的浮窗 / 手机页里 store 还是空的,取一次(同 ForkBlock)
  useEffect(() => { useBtw.getState().loadSaved(sessionId) }, [sessionId])

  const last = turns[turns.length - 1]
  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns.length, last?.answer, last?.status])

  /** 读完再挂:读盘是异步的,挂的时候取 store 里最新那份(期间可能又加 / 删了别的)并按它再查一遍上限,不拿闭包里的旧数组。
   *  读着的时候不许发(Codex 10-24 #2:否则这批会漏在这一问外面、读完又挂进下一问)。 */
  const [reading, setReading] = useState(0)
  const addFiles = async (files: File[]): Promise<void> => {
    if (!files.length) return
    setReading((n) => n + 1)
    try {
      const have = useBtw.getState().compose[sessionId]?.attachments ?? []
      const { added, skipped } = await readBtwFiles(files, have)
      const { merged, skipped: over } = mergeBtwAttachments(useBtw.getState().compose[sessionId]?.attachments ?? [], added)
      const all = [...skipped, ...over]
      setHint(all.length ? t('btw.att.skipped', { items: all.join(t('btw.listSep')) }) : null)
      if (merged.length !== (useBtw.getState().compose[sessionId]?.attachments ?? []).length) setCompose({ attachments: merged })
      requestAnimationFrame(() => taRef.current?.focus())
    } finally {
      setReading((n) => n - 1)
    }
  }
  const addRef = useRef(addFiles)
  addRef.current = addFiles

  // 拖文件进来:落区是整块面板。主窗里这块面板长在聊天区(.t2-chat-view)里面,聊天区自己也是主输入框的落区 ——
  // 这里认领并拦住冒泡,文件只进顺便问,不顺带进主输入框;聊天区那层「可落」淡染也撤掉。
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const hasFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes('Files')
    const over = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault() // 认领这次拖放:fileDropGuard 看 defaultPrevented 才不去兜底吞掉
      e.stopPropagation()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      el.closest('.t2-chat-view')?.removeAttribute('data-filedrop')
      setDragOver(true)
    }
    const leave = (e: DragEvent): void => { if (!el.contains(e.relatedTarget as Node)) setDragOver(false) }
    const drop = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      e.stopPropagation()
      setDragOver(false)
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (files.length) void addRef.current(files)
    }
    const clear = (): void => setDragOver(false)
    const win = el.ownerDocument?.defaultView
    el.addEventListener('dragover', over)
    el.addEventListener('dragleave', leave)
    el.addEventListener('drop', drop)
    win?.addEventListener('dragend', clear)
    win?.addEventListener('drop', clear, true)
    win?.addEventListener('blur', clear)
    return () => {
      el.removeEventListener('dragover', over)
      el.removeEventListener('dragleave', leave)
      el.removeEventListener('drop', drop)
      win?.removeEventListener('dragend', clear)
      win?.removeEventListener('drop', clear, true)
      win?.removeEventListener('blur', clear)
    }
  }, [])

  /** 「+」:Android 走宿主的系统文件选择器(WebView 里 input.click() 可能被丢);桌面 / 网页用隐藏的文件 input。 */
  const pick = async (): Promise<void> => {
    if (window.tangu?.pickFiles) { void addFiles(await window.tangu.pickFiles()); return }
    fileRef.current?.click()
  }

  const live = attachments.filter((a) => !isLeaving(a))
  const canSend = (!!draft.trim() || !!quote || live.length > 0) && !reading
  const send = (): void => {
    const sending = attachments.filter((a) => !isLeaving(a)) // 正在淡出的(用户刚点了移除)不发
    const question = draft.trim() || (quote ? t('btw.defaultQuestion') : sending.length ? t('btw.defaultAttachQuestion') : '')
    if (!question || busy || reading) return
    ask(question, quote, sending)
    setCompose({ draft: '', quote: undefined, attachments: [] })
    setHint(null)
  }
  const stop = (): void => useBtw.getState().stop(sessionId)
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // 在流的时候回车不发(一次一问),也不能落到 Chat Box 的提交上 —— 那时提交钮是「停止」
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && (busy || reading)) e.preventDefault()
    else if (e.key === 'Escape') {
      e.preventDefault()
      if (busy) stop()
      else onClose?.()
    }
  }
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(e.clipboardData?.files ?? [])
    if (!files.length) return // 纯文字照常粘贴
    e.preventDefault()
    void addFiles(files)
  }
  const removeAttachment = (a: BtwAttachment): void =>
    setCompose({ attachments: (useBtw.getState().compose[sessionId]?.attachments ?? []).filter((x) => x !== a) })

  const tiles = (quote || attachments.length > 0 || hint) ? (
    <div className="btw-compose-top">
      {quote && (
        <div className="btw-quote-chip">
          <Quote size={12} />
          <span>{quote}</span>
          <button type="button" aria-label={t('btw.removeQuote')} onClick={() => setQuote(undefined)}><X size={12} /></button>
        </div>
      )}
      {attachments.length > 0 && (
        <div className="btw-tiles" data-testid="btw-tiles">
          {attachments.map((a) => (
            <AttachmentTile key={tileKey(a)} file={a} removeTitle={t('btw.remove')} onRemove={() => removeAttachment(a)}
              note={noVision && a.mimeType.startsWith('image/') ? t('btw.att.noVision') : undefined} />
          ))}
        </div>
      )}
      {hint && <div className="btw-att-hint" role="status">{hint}</div>}
    </div>
  ) : null

  return (
    <div ref={rootRef} className="btw-panel" data-btw-session={sessionId} data-chrome={chrome} data-dragover={dragOver || undefined}>
      <BtwHead sessionId={sessionId} busy={busy} own={chrome === 'own'} onClose={onClose} />
      <div className="btw-body" ref={bodyRef}>
        <AnchorCard sessionId={sessionId} />
        {turns.length
          ? turns.map((turn) => <TurnView key={turn.id} turn={turn} sessionId={sessionId} onQuoted={onQuoted} />)
          : <div className="btw-empty">{t('btw.empty')}<br />{t('btw.hint')}</div>}
      </div>
      <div className="btw-compose">
        <ChatBox
          className="btw-box"
          value={draft}
          onValueChange={setDraft}
          onSubmit={busy ? stop : send}
          submitLabel={t(busy ? 'btw.stop' : 'btw.send')}
          submitOn="enter"
          submitDisabled={!busy && !canSend}
          submitContent={busy ? <Square size={11} /> : undefined}
          submitClassName={busy ? 'btw-stop' : undefined}
          inputRef={taRef}
          inputProps={{ placeholder: t('btw.placeholder'), onKeyDown, onPaste }}
          beforeInput={tiles}
          leadingControls={(
            <button type="button" className="btw-plus" title={t('btw.attach')} aria-label={t('btw.attach')} data-testid="btw-attach" onClick={() => void pick()}>
              <Plus size={16} />
            </button>
          )}
          selection={selection}
          onSelectionChange={(next) => setCompose({ modelId: next.modelId, thinkingLevel: next.thinkingLevel })}
        />
        <input ref={fileRef} type="file" multiple hidden data-testid="btw-file-input"
          onChange={(e) => { const files = Array.from(e.target.files ?? []); e.target.value = ''; void addFiles(files) }} />
      </div>
    </div>
  )
}

/** 右侧栏里的旁聊(视图 `btw-panel`,手动放进侧栏的):跟着主窗当前会话走 —— 线程按会话存,切会话就切到那个会话的旁聊。 */
export function BtwSideView() {
  const { t } = useI18n()
  const activeId = useApp((s) => s.activeId)
  const session = useApp((s) => s.sessions.find((x) => x.id === s.activeId) || s.archivedSessions.find((x) => x.id === s.activeId) || null)
  const modelId = useApp((s) => activeChatModelId({ ...s, activeSession: session }))
  if (!activeId) return <div className="btw-panel"><div className="btw-body"><div className="btw-empty">{t('btw.sideEmpty')}</div></div></div>
  const shown: BtwSeed = { sessionId: activeId, scope: activeId, title: session?.title || undefined, modelId: modelId || undefined, nonce: `side:${activeId}` }
  return <BtwPanel key={shown.sessionId} seed={shown} />
}

/** Web / 手机:没有原生浮窗,旁聊挂在本页。只在它归属的会话仍是当前会话时显示 —— 切走即隐、切回再现(线程在 store 里)。
 *  page = 手机全屏二级页(同设置 / 成就),头由面板自己画(一行:标题 + 段落胶囊 + ＋ + ✕);否则 Web 居中窄浮层。 */
export function BtwHost({ page = false }: { page?: boolean }) {
  const { t } = useI18n()
  const seed = useBtw((s) => s.webOpen)
  const activeId = useApp((s) => s.activeId)
  const close = useBtw((s) => s.closeWeb)
  const title = t('btw.windowTitle', { title: seed?.title || t('btw.title') })
  return (
    <AnimatePresence>
      {btwWebVisible(seed, activeId) && (page
        ? (
          <motion.div key="btw" className="btw-page" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }} transition={{ duration: 0.2 }}>
            <BtwPanel seed={seed} chrome="own" onClose={close} onQuoted={close} />
          </motion.div>
        )
        : (
          <FloatingPanelFrame key="btw" narrow title={title} onClose={close}>
            <BtwPanel seed={seed} onClose={close} onQuoted={close} />
          </FloatingPanelFrame>
        ))}
    </AnimatePresence>
  )
}
