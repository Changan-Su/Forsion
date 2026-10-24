/** 旁聊(/btw)面板:主窗挂在对话右边的子会话面板(ChildChatPanel),卫星窗挂原生 Floating Panel(FloatingRoot),
 *  Web / 手机经 BtwHost 挂在本页。输入区是共用 Chat Box(components/chatbox):「+」/ 粘贴 / 拖入加图片和文件,
 *  附件只给这一问(10-24 方案 A)。数据与形态说明见 btwStore.ts。 */
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, Copy, Eraser, Loader2, MessageCircleQuestion, MessageSquareQuote, Plus, Quote, Square, X } from 'lucide-react'
import { useI18n } from '../../i18n'
import { activeChatModelId, newChatModelId, useApp } from '../../stores/appStore'
import { Markdown } from '../../components/Markdown'
import { FloatingPanelFrame } from '../../components/FloatingPanelFrame'
import { AttachmentTile, isLeaving, tileKey, type TileFile } from '../../components/AttachmentTile'
import { ChatBox, type ChatBoxSelection } from '../../components/chatbox'
import {
  asidesOnMessage, btwWebVisible, consumeSeed, quoteInMainChat, readBtwFiles, useBtw,
  type BtwAttachment, type BtwAttachmentMeta, type BtwSeed, type BtwTurn,
} from './btwStore'
import './btw.css'

const EMPTY: BtwTurn[] = []
const NO_ATTACHMENTS: BtwAttachment[] = []

/** 落库的附件记录 → 磁贴:有缩略图的画成方块小图,没有的(文件 / 老记录)画成文件条。 */
const tileOf = (a: BtwAttachmentMeta): TileFile => {
  const m = a.thumb ? /^data:([^;,]+);base64,(.+)$/.exec(a.thumb) : null
  return m ? { name: a.name, mimeType: m[1], data: m[2], size: a.size } : { name: a.name, mimeType: a.mimeType, size: a.size }
}

function TurnView({ turn, onQuoted }: { turn: BtwTurn; onQuoted?: () => void }) {
  const { t } = useI18n()
  const [done, setDone] = useState<'copy' | 'quote' | null>(null)
  useEffect(() => {
    if (!done) return
    const id = setTimeout(() => setDone(null), 1600)
    return () => clearTimeout(id)
  }, [done])
  const copy = (): void => { void navigator.clipboard.writeText(turn.answer).then(() => setDone('copy'), () => {}) }
  const quote = (): void => { quoteInMainChat(turn.answer); setDone('quote'); onQuoted?.() }
  return (
    <article className="btw-turn" data-status={turn.status}>
      {turn.quote && <blockquote className="btw-turn-quote">{turn.quote}</blockquote>}
      {!!turn.attachments?.length && (
        <div className="btw-turn-files" data-testid="btw-turn-files">
          {turn.attachments.map((a, i) => <AttachmentTile key={`${i}-${a.name}`} file={tileOf(a)} />)}
        </div>
      )}
      <div className="btw-turn-q">{turn.question}</div>
      {turn.answer
        ? <div className="t2-content btw-turn-a"><Markdown content={turn.answer} /></div>
        : turn.status === 'streaming' && <div className="btw-note"><Loader2 className="spin" size={13} /> {t(turn.describing ? 'btw.describing' : 'btw.thinking')}</div>}
      {turn.status === 'error' && <div className="btw-error" role="alert">{turn.error}</div>}
      {turn.status === 'stopped' && <div className="btw-note">{t('btw.stopped')}</div>}
      {turn.toolCallText && <div className="btw-note">{t('btw.noTools')}</div>}
      {turn.attachNote && <div className="btw-note" data-attach-note={turn.attachNote}>{t(turn.attachNote === 'ignored' ? 'btw.att.ignored' : 'btw.att.transcribed')}</div>}
      {turn.status === 'done' && turn.answer && (
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

/** 面板头上的列表:挂在这条回答上、已经存下来的那几段(来源同「从这里分出」ForkBlock:saved 按 message_id 筛)。
 *  第一行永远是「新的一段」;一段都没有就不画。点一段 = 载回那段接着问;上一问还在流时不能换。 */
function AsideList({ sessionId, busy }: { sessionId: string; busy: boolean }) {
  const { t } = useI18n()
  const saved = useBtw((s) => s.saved[sessionId])
  const anchor = useBtw((s) => s.anchors[sessionId])
  const items = useMemo(() => asidesOnMessage(saved, anchor?.messageId), [saved, anchor?.messageId])
  if (!items.length) return null
  const current = anchor?.asideId
  const open = (id: string, messageId: string | null): void => {
    useBtw.getState().applySeed({ sessionId, asideId: id, messageId: messageId || undefined, nonce: `list:${id}:${Date.now().toString(36)}` })
  }
  return (
    <div className="btw-list" data-testid="btw-aside-list">
      <div className="btw-list-head">{t('btw.list.head', { n: String(items.length) })}</div>
      <div className="btw-list-rows">
        <button type="button" className="btw-list-row" data-new="" aria-current={!current || undefined} disabled={busy} onClick={() => useBtw.getState().startNew(sessionId)}>
          <span className="btw-list-lead"><Plus size={14} /></span>
          <span className="btw-list-title">{t('btw.list.new')}</span>
        </button>
        {items.map((a) => {
          const first = a.turns[0]
          const last = a.turns[a.turns.length - 1]
          return (
            <button key={a.id} type="button" className="btw-list-row" data-aside={a.id} aria-current={current === a.id || undefined} disabled={busy} onClick={() => open(a.id, a.message_id)}>
              <span className="btw-list-lead"><MessageCircleQuestion size={14} /></span>
              <span className="btw-list-title">{first?.question || t('btw.title')}</span>
              {a.turns.length > 1 && <span className="btw-list-n">{a.turns.length}</span>}
              {last?.answer && <span className="btw-list-sub">{last.answer.replace(/[#*`>_~[\]]/g, '').replace(/\s+/g, ' ').trim()}</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** onClose:Esc 且没有在流的回答时关掉宿主;onQuoted:回答被引用回主对话之后(Web / 手机据此收起,好让用户看见输入框)。 */
export function BtwPanel({ seed, onClose, onQuoted }: { seed: BtwSeed; onClose?: () => void; onQuoted?: () => void }) {
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

  // 头上的列表要存下来的那几段:新开的浮窗 / 手机页里 store 还是空的,取一次(同 ForkBlock)
  useEffect(() => { useBtw.getState().loadSaved(sessionId) }, [sessionId])

  const last = turns[turns.length - 1]
  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns.length, last?.answer, last?.status])

  /** 读完再挂:读盘是异步的,挂的时候取 store 里最新那份(期间可能又加 / 删了别的),不拿闭包里的旧数组。 */
  const addFiles = async (files: File[]): Promise<void> => {
    if (!files.length) return
    const have = useBtw.getState().compose[sessionId]?.attachments ?? []
    const { added, skipped } = await readBtwFiles(files, have)
    setHint(skipped.length ? t('btw.att.skipped', { items: skipped.join(t('btw.listSep')) }) : null)
    if (!added.length) return
    const now = useBtw.getState().compose[sessionId]?.attachments ?? []
    setCompose({ attachments: [...now, ...added] })
    requestAnimationFrame(() => taRef.current?.focus())
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
  const canSend = !!draft.trim() || !!quote || live.length > 0
  const send = (): void => {
    const sending = attachments.filter((a) => !isLeaving(a)) // 正在淡出的(用户刚点了移除)不发
    const question = draft.trim() || (quote ? t('btw.defaultQuestion') : sending.length ? t('btw.defaultAttachQuestion') : '')
    if (!question || busy) return
    ask(question, quote, sending)
    setCompose({ draft: '', quote: undefined, attachments: [] })
    setHint(null)
  }
  const stop = (): void => useBtw.getState().stop(sessionId)
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // 在流的时候回车不发(一次一问),也不能落到 Chat Box 的提交上 —— 那时提交钮是「停止」
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && busy) e.preventDefault()
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
    <div ref={rootRef} className="btw-panel" data-btw-session={sessionId} data-dragover={dragOver || undefined}>
      <div className="btw-bar">
        <div className="btw-bar-copy">
          <div className="btw-context"><span>{t('btw.context')}</span><strong title={seed.title || t('btw.title')}>{seed.title || t('btw.title')}</strong></div>
          <span className="btw-hint">{t('btw.hint')}</span>
        </div>
        {turns.length > 0 && (
          <button type="button" className="icon-btn" title={t('btw.clear')} aria-label={t('btw.clear')} onClick={() => useBtw.getState().clear(sessionId)}>
            <Eraser size={14} />
          </button>
        )}
      </div>
      <AsideList sessionId={sessionId} busy={busy} />
      <div className="btw-body" ref={bodyRef}>
        {turns.length
          ? turns.map((turn) => <TurnView key={turn.id} turn={turn} onQuoted={onQuoted} />)
          : <div className="btw-empty">{t('btw.empty')}</div>}
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
 *  page = 手机全屏二级页(同设置 / 成就);否则 Web 居中窄浮层。 */
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
            <header className="btw-page-head">
              <span>{title}</span>
              <button type="button" className="icon-btn" aria-label={t('btw.close')} onClick={close}><X size={16} /></button>
            </header>
            <BtwPanel seed={seed} onClose={close} onQuoted={close} />
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
