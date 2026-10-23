/**
 * 引用磁贴(10-23,借鉴 Comma 方案 C + Claude 的引用卡):输入卡里待发的引用、已发气泡里的引用共用,
 * 和附件磁贴排在同一行、同一套尺寸(AttachmentTile 的文件条):引号色块 + 一行摘录 + 「引用」。
 * 输入卡里点它 = 看全文(预览窗);气泡里点它 = 跳回原文并闪两下,找不到原文再退回预览。
 * 方案页:docs/ToBeImproved/借鉴Comma方案_2026-10-21/(仓根)
 */
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Quote, X } from 'lucide-react'
import { WikiText } from '../../components/ChatWikiLink'
import { registerMessages, useI18n } from '../../i18n'

registerMessages({
  'quote.tile.kind': { zh: '引用', en: 'Quote' },
  'quote.tile.jump': { zh: '点一下回到原文', en: 'Click to go to the source' },
  'quote.tile.preview': { zh: '点一下看全文', en: 'Click to read it all' },
  'quote.preview.title': { zh: '引用', en: 'Quote' },
  'quote.preview.close': { zh: '关闭', en: 'Close' },
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

export function QuoteTile({ text, onOpen, onRemove, removeTitle, title }: {
  text: string
  onOpen: (el: HTMLElement) => void
  /** 不传 = 只读(已发气泡里) */
  onRemove?: () => void
  removeTitle?: string
  title?: string
}) {
  const { t } = useI18n()
  return (
    <span className="att-tile att-tile--file att-tile--quote">
      <button type="button" className="att-tile-open" title={title} onClick={(e) => onOpen(e.currentTarget)}>
        <span className="att-tile-badge" data-kind="quote" aria-hidden><Quote size={16} /></span>
        <span className="att-tile-meta">
          <span className="att-tile-name"><span className="att-tile-head">{text.replace(/\s+/g, ' ').trim()}</span></span>
          <span className="att-tile-sub">{t('quote.tile.kind')}</span>
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
export function QuotePreview({ text, onClose }: { text: string; onClose: () => void }) {
  const { t } = useI18n()
  const box = useRef<HTMLDivElement>(null)
  // 关了把焦点还给点开它的那颗磁贴。在渲染时记:effect 跑的时候 autoFocus 已经把焦点挪到关闭钮上了
  const opener = useRef(document.activeElement as HTMLElement | null)
  useEffect(() => () => { const el = opener.current; if (el?.isConnected) el.focus() }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // 捕获阶段吞掉 Esc:不然同一下会接着关掉身后的旁聊面板 / 侧栏(useEscape 不拦冒泡)
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); onClose(); return }
      if (e.key !== 'Tab' || !box.current) return
      // Tab 只在窗里转:身后被遮住的控件别够得着
      const items = Array.from(box.current.querySelectorAll<HTMLElement>('button, a[href], [tabindex]:not([tabindex="-1"])'))
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
        <div ref={box} className="dialog quote-preview" role="dialog" aria-modal="true" aria-label={t('quote.preview.title')} onMouseDown={(e) => e.stopPropagation()}>
          <div className="quote-preview-head">
            <div className="dialog-title">{t('quote.preview.title')}</div>
            <button type="button" className="quote-preview-x" title={t('quote.preview.close')} aria-label={t('quote.preview.close')} autoFocus onClick={onClose}><X size={16} /></button>
          </div>
          <div className="quote-preview-body"><WikiText text={text} /></div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
