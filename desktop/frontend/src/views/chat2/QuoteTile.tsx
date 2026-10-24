/**
 * 引用磁贴(10-23,借鉴 Comma 方案 C + Claude 的引用卡):输入卡里待发的引用、已发气泡里的引用共用,
 * 和附件磁贴排在同一行、同一套尺寸(AttachmentTile 的文件条):引号色块 + 一行摘录 + 「引用」。
 * 输入卡里点它 = 看全文(预览窗);气泡里点它 = 跳回原文并闪两下,找不到原文再退回预览。
 * 划选「引用」先弹就地回复框(ReplyPopover,Claude 的「Reply to Claude」):写一句回应再加进来,卡上显示这句回应,全文窗里还能改。
 * 方案页:docs/ToBeImproved/借鉴Comma方案_2026-10-21/(仓根)
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ClipboardList, MessageSquarePlus, Quote, X } from 'lucide-react'
import { OverlayAt } from '@lcl/engine'
import { WikiText } from '../../components/ChatWikiLink'
import { registerMessages, useI18n } from '../../i18n'
import { pasteTitle } from './quotes'

registerMessages({
  'quote.tile.kind': { zh: '引用', en: 'Quote' },
  'quote.tile.jump': { zh: '点一下回到原文', en: 'Click to go to the source' },
  'quote.tile.preview': { zh: '点一下看全文', en: 'Click to read it all' },
  'quote.preview.title': { zh: '引用', en: 'Quote' },
  'quote.preview.close': { zh: '关闭', en: 'Close' },
  'quote.tile.reply': { zh: '回复', en: 'Reply' },
  'quote.preview.reply': { zh: '回复', en: 'Reply' },
  'quote.preview.notePlaceholder': { zh: '对这段说点什么（可不写）', en: 'Say something about this (optional)' },
  'quote.reply.placeholder': { zh: '回复这段…', en: 'Reply to this…' },
  'quote.reply.add': { zh: '加进输入框（回车）', en: 'Add to the message (Enter)' },
  'paste.tile.sub': { zh: '粘贴 · {lines} 行 · {chars} 字', en: 'Pasted · {lines} lines · {chars} chars' },
  'paste.preview.title': { zh: '粘贴的内容', en: 'Pasted text' },
  'paste.preview.restore': { zh: '放回输入框', en: 'Put back in the text field' },
})

const squash = (s: string): string => s.replace(/\s+/g, '')

/** 引文出自哪条消息:从 `from` 往前找,最近一条正文里含这段字的(比较时去掉所有空白 —— 划选跨段时 toString 带换行,textContent 不带)。
 *  ponytail: 按字面找,不落库出处 —— 引擎消息没有元数据通道,记出处要同时改本机引擎和云端 worker。
 *  上限:同一段字出现在好几条里取最近的;原文在没加载的更早分页里找不到(退回预览)。真要精确再给 startRun 加 replyTo。 */
export function findQuoteSource(from: Element, quote: string): string | undefined {
  const q = squash(quote)
  if (!q) return undefined
  const own = from.closest('[id^="tocmsg-"]')
  const nodes = Array.from((from.closest('.t2-stream-inner') ?? document).querySelectorAll('[id^="tocmsg-"]'))
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]
    if (node === own || !(node.compareDocumentPosition(from) & Node.DOCUMENT_POSITION_FOLLOWING)) continue
    if (squash(node.textContent ?? '').includes(q)) return node.id.slice('tocmsg-'.length)
  }
  return undefined
}

export function QuoteTile({ text, note, onOpen, onRemove, removeTitle, title }: {
  text: string
  /** 对这段的回应:有就显示回应,摘录挪到第二行 */
  note?: string
  onOpen: (el: HTMLElement) => void
  /** 不传 = 只读(已发气泡里) */
  onRemove?: () => void
  removeTitle?: string
  title?: string
}) {
  const { t } = useI18n()
  const excerpt = text.replace(/\s+/g, ' ').trim()
  const said = note?.replace(/\s+/g, ' ').trim()
  return (
    <span className="att-tile att-tile--file att-tile--quote">
      <button type="button" className="att-tile-open" title={title} onClick={(e) => onOpen(e.currentTarget)}>
        <span className="att-tile-badge" data-kind="quote" aria-hidden><Quote size={16} /></span>
        <span className="att-tile-meta">
          <span className="att-tile-name"><span className="att-tile-head">{said || excerpt}</span></span>
          <span className="att-tile-sub">{said ? `${t('quote.tile.reply')} · ${excerpt}` : t('quote.tile.kind')}</span>
        </span>
      </button>
      {/* 点了立刻删,不像附件磁贴那样淡出 130ms:引用按下标删、发送时也没有「正在淡出」的过滤,延迟删会删错 / 把删掉的发出去(Codex P2) */}
      {onRemove && (
        <button type="button" className="att-tile-x" title={removeTitle} aria-label={removeTitle} onClick={onRemove}>
          <X size={11} strokeWidth={2.5} />
        </button>
      )}
    </span>
  )
}

/** 引用全文(Claude 点引用卡出的那个窗)。外壳复用 Amadeus 的 .dialog-*(同 RemoveDialog 的挂法)。 */
export function QuotePreview({ text, note, onNote, onClose, paste, onRestore }: {
  text: string
  note?: string
  /** 给了 = 回应可改(输入框里的卡);不给 = 只读(已发的) */
  onNote?: (note: string) => void
  onClose: () => void
  /** 长粘贴磁贴的全文:等宽、原样显示(不当 wiki 文本渲染) */
  paste?: boolean
  /** 给了 = 窗底一颗「放回输入框」 */
  onRestore?: () => void
}) {
  const { t } = useI18n()
  const title = paste ? 'paste.preview.title' : onNote || note ? 'quote.preview.reply' : 'quote.preview.title'
  const box = useRef<HTMLDivElement>(null)
  // 关了把焦点还给点开它的那颗磁贴。在渲染时记:effect 跑的时候 autoFocus 已经把焦点挪到关闭钮上了
  const opener = useRef(document.activeElement as HTMLElement | null)
  useEffect(() => () => { const el = opener.current; if (el?.isConnected) el.focus() }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // 捕获阶段吞掉 Esc:不然同一下会接着关掉身后的旁聊面板 / 侧栏(useEscape 不拦冒泡)
      if (e.key === 'Escape') { if (e.isComposing) return; e.stopPropagation(); e.preventDefault(); onClose(); return }
      if (e.key !== 'Tab' || !box.current) return
      // Tab 只在窗里转:身后被遮住的控件别够得着
      const items = Array.from(box.current.querySelectorAll<HTMLElement>('button, a[href], textarea, [tabindex]:not([tabindex="-1"])'))
      const first = items[0], last = items[items.length - 1]
      const at = document.activeElement
      if (!first) return
      if (e.shiftKey ? at === first || !box.current.contains(at) : at === last || !box.current.contains(at)) { e.preventDefault(); (e.shiftKey ? last : first).focus() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return createPortal(
    <div className="am-app tangu-lovable" style={{ display: 'contents' }}>
      <div className="dialog-overlay" onMouseDown={onClose}>
        <div ref={box} className="dialog quote-preview" role="dialog" aria-modal="true" aria-label={t(title)} onMouseDown={(e) => e.stopPropagation()}>
          <div className="quote-preview-head">
            <div className="dialog-title">{t(title)}</div>
            <button type="button" className="quote-preview-x" title={t('quote.preview.close')} aria-label={t('quote.preview.close')} autoFocus onClick={onClose}><X size={16} /></button>
          </div>
          {paste
            ? <div className="quote-preview-body quote-preview-body--mono">{text}</div>
            : <div className="quote-preview-body"><WikiText text={text} /></div>}
          {onRestore && <div className="dialog-actions"><button type="button" className="dialog-btn" onClick={onRestore}>{t('paste.preview.restore')}</button></div>}
          {onNote
            ? <textarea className="quote-preview-note" rows={3} value={note ?? ''} placeholder={t('quote.preview.notePlaceholder')} onChange={(e) => onNote(e.target.value)} />
            : note && <div className="quote-preview-said"><WikiText text={note} /></div>}
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** 长粘贴磁贴(借 Comma):≥ PASTE_TILE_MIN 字的纯文本粘贴不进输入框,成一张磁贴 —— 和引用磁贴同一副身材,
 *  标题取第一行有字的,副行写行数 · 字数;点一下看全文(窗里能放回输入框)。 */
export function PasteTile({ text, title, onOpen, onRemove, removeTitle }: {
  text: string
  title: string
  onOpen: () => void
  onRemove: () => void
  removeTitle: string
}) {
  const { t } = useI18n()
  const lines = text.replace(/\n+$/, '').split('\n').length
  return (
    <span className="att-tile att-tile--file att-tile--quote att-tile--paste">
      <button type="button" className="att-tile-open" title={title} onClick={onOpen}>
        <span className="att-tile-badge" data-kind="paste" aria-hidden><ClipboardList size={16} /></span>
        <span className="att-tile-meta">
          <span className="att-tile-name"><span className="att-tile-head">{pasteTitle(text)}</span></span>
          <span className="att-tile-sub">{t('paste.tile.sub', { lines: lines.toLocaleString(), chars: text.length.toLocaleString() })}</span>
        </span>
      </button>
      <button type="button" className="att-tile-x" title={removeTitle} aria-label={removeTitle} onClick={onRemove}>
        <X size={11} strokeWidth={2.5} />
      </button>
    </span>
  )
}

/** 划选「引用」弹出的就地回复框(Claude 的「Reply to Claude」):上面是引文,下面一行写回应;回车 / 右边那颗键 = 连引用带回应加进输入框,
 *  空着回车 = 只加引用。Esc / 点到框外 = 不加。开在选区上方(放不下翻到下方),坐标是视口 px(同划线条的结果卡)。 */
export function ReplyPopover({ text, rect, onAdd, onClose }: {
  text: string
  rect: { left: number; top: number; bottom: number }
  onAdd: (note: string) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const [note, setNote] = useState('')
  const box = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape' && !e.isComposing) { e.stopPropagation(); e.preventDefault(); onClose() } } // 输入法组字时的 Esc 是取消组字
    const onDown = (e: PointerEvent): void => { if (!box.current?.contains(e.target as Node)) onClose() }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onDown, true)
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('pointerdown', onDown, true) }
  }, [onClose])
  return createPortal(
    <OverlayAt x={rect.left} y={rect.bottom + 6} anchorTop={rect.top - 6} prefer="above" innerRef={(el) => { box.current = el }} className="ui-popover quote-reply" role="dialog" aria-label={t('quote.reply.placeholder')}>
      <div className="quote-reply-text">{text}</div>
      <div className="quote-reply-row">
        <input
          className="quote-reply-input"
          autoFocus
          value={note}
          placeholder={t('quote.reply.placeholder')}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); onAdd(note) } }}
        />
        <button type="button" className="quote-reply-add" title={t('quote.reply.add')} aria-label={t('quote.reply.add')} onClick={() => onAdd(note)}><MessageSquarePlus size={16} /></button>
      </div>
    </OverlayAt>,
    document.body,
  )
}
