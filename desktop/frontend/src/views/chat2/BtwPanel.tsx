/** 旁聊(/btw)面板:桌面挂在原生 Floating Panel(FloatingRoot),Web / 手机经 BtwHost 挂在本页。数据与形态说明见 btwStore.ts。 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowUp, Check, Copy, Eraser, Loader2, MessageSquareQuote, Quote, Square, X } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useApp } from '../../stores/appStore'
import { Markdown } from '../../components/Markdown'
import { FloatingPanelFrame } from '../../components/FloatingPanelFrame'
import { btwWebVisible, consumeSeed, quoteInMainChat, useBtw, type BtwSeed, type BtwTurn } from './btwStore'
import './btw.css'

const EMPTY: BtwTurn[] = []

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
      <div className="btw-turn-q">{turn.question}</div>
      {turn.answer
        ? <div className="t2-content btw-turn-a"><Markdown content={turn.answer} /></div>
        : turn.status === 'streaming' && <div className="btw-note"><Loader2 className="spin" size={13} /> {t('btw.thinking')}</div>}
      {turn.status === 'error' && <div className="btw-error" role="alert">{turn.error}</div>}
      {turn.status === 'stopped' && <div className="btw-note">{t('btw.stopped')}</div>}
      {turn.toolCallText && <div className="btw-note">{t('btw.noTools')}</div>}
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

/** onClose:Esc 且没有在流的回答时关掉宿主;onQuoted:回答被引用回主对话之后(Web / 手机据此收起,好让用户看见输入框)。 */
export function BtwPanel({ seed, onClose, onQuoted }: { seed: BtwSeed; onClose?: () => void; onQuoted?: () => void }) {
  const { t } = useI18n()
  const sessionId = seed.sessionId
  const turns = useBtw((s) => s.threads[sessionId] || EMPTY)
  const busy = turns.some((turn) => turn.status === 'streaming')
  const [draft, setDraft] = useState('')
  const [quote, setQuote] = useState<string | undefined>()
  const taRef = useRef<HTMLTextAreaElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const ask = (question: string, excerpt?: string): void => { void useBtw.getState().ask(sessionId, question, excerpt, seed.modelId) }

  // 一次性指令:带问题直接问;只带引用就挂上,等用户打字(空着回车 = 「解释一下这段」)。
  useEffect(() => {
    if (consumeSeed(seed)) {
      if (seed.question) ask(seed.question, seed.quote)
      else if (seed.quote) setQuote(seed.quote)
    }
    requestAnimationFrame(() => taRef.current?.focus())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed.nonce])

  const last = turns[turns.length - 1]
  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns.length, last?.answer, last?.status])

  const grow = (): void => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`
  }
  const send = (): void => {
    const question = draft.trim() || (quote ? t('btw.defaultQuestion') : '')
    if (!question || busy) return
    ask(question, quote)
    setDraft('')
    setQuote(undefined)
    requestAnimationFrame(grow)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() }
    else if (e.key === 'Escape') {
      e.preventDefault()
      if (busy) useBtw.getState().stop(sessionId)
      else onClose?.()
    }
  }

  return (
    <div className="btw-panel" data-btw-session={sessionId}>
      <div className="btw-bar">
        <span className="btw-hint">{t('btw.hint')}</span>
        {turns.length > 0 && (
          <button type="button" className="icon-btn" title={t('btw.clear')} aria-label={t('btw.clear')} onClick={() => useBtw.getState().clear(sessionId)}>
            <Eraser size={14} />
          </button>
        )}
      </div>
      <div className="btw-body" ref={bodyRef}>
        {turns.length
          ? turns.map((turn) => <TurnView key={turn.id} turn={turn} onQuoted={onQuoted} />)
          : <div className="btw-empty">{t('btw.empty')}</div>}
      </div>
      <div className="btw-compose">
        {quote && (
          <div className="btw-quote-chip">
            <Quote size={12} />
            <span>{quote}</span>
            <button type="button" aria-label={t('btw.removeQuote')} onClick={() => setQuote(undefined)}><X size={12} /></button>
          </div>
        )}
        <div className="btw-input">
          <textarea
            ref={taRef}
            rows={1}
            value={draft}
            placeholder={t('btw.placeholder')}
            onChange={(e) => { setDraft(e.target.value); grow() }}
            onKeyDown={onKeyDown}
          />
          {busy
            ? <button type="button" className="btw-send stop" aria-label={t('btw.stop')} title={t('btw.stop')} onClick={() => useBtw.getState().stop(sessionId)}><Square size={11} /></button>
            : <button type="button" className="btw-send" aria-label={t('btw.send')} title={t('btw.send')} disabled={!draft.trim() && !quote} onClick={send}><ArrowUp size={14} /></button>}
        </div>
      </div>
    </div>
  )
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
