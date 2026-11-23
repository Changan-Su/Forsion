/**
 * 看图器的「全部图片」视图(生图多张与标注改图方案 1C;方案里叫「画布」,和对话顶上的「对话 | 画布」页签撞名,改叫「全部图片」)。
 * 这条对话流里的图排成网格:点图 = 回到单张看;左上圆钮多选,「标注」进标注态(收集模式,标完回来);
 * 选了图,底下一条「已选 N 张 · 每张都要… · 发送」把几张一起发回会话(每张单独改,见 imageMarkupModel.buildMarkupMessage)。
 * 状态(选了哪些、各自的标记、整体要求)在 ImageViewer 里,这里只画。
 */
import { useEffect, useRef } from 'react'
import { ArrowUp, Check, ChevronLeft, PenLine, X } from 'lucide-react'
import { registerMessages, translate as tr } from '../i18n'
import { MAX_ATTACHMENTS } from './imageMarkupModel'

registerMessages({
  'viewer.all': { zh: '全部图片', en: 'All images' },
  'viewer.allCount': { zh: '{count} 张', en: '{count} images' },
  'viewer.allBack': { zh: '回到单张', en: 'Back to single image' },
  'viewer.pick': { zh: '选中这张', en: 'Select this image' },
  'viewer.marks': { zh: '{count} 处', en: '{count} marks' },
  'viewer.picked': { zh: '已选 {count} 张', en: '{count} selected' },
  'viewer.allPh': { zh: '每张都要怎么改…', en: 'What should change in each…' },
  'viewer.sendAll': { zh: '发送', en: 'Send' },
  'viewer.sending': { zh: '正在发送…', en: 'Sending…' },
  'viewer.tooMany': { zh: '一次最多 {max} 件附件，带标注的一张占两件', en: 'Up to {max} attachments at a time; a marked image counts as two' },
  'viewer.allHint': { zh: '点图看大图 · 左上圆钮多选 · Esc 回到单张', en: 'Click to view · use the circle to select · Esc to go back' },
})

export interface GridItem { src: string; name: string; editable: boolean }
interface Props {
  items: GridItem[]
  current: number
  picked: number[]
  marksOf: (i: number) => number
  overall: string
  count: number
  busy: boolean
  compact: boolean
  onOverall: (v: string) => void
  onOpen: (i: number) => void
  onToggle: (i: number) => void
  onMark: (i: number) => void
  onSend: () => void
  onBack: () => void
  onClose: () => void
}

export function ImageGrid({ items, current, picked, marksOf, overall, count, busy, compact, onOverall, onOpen, onToggle, onMark, onSend, onBack, onClose }: Props) {
  const over = count > MAX_ATTACHMENTS
  // 每张选中的图都得有改法:自己有标记,或者写了整体要求
  const canSend = picked.length > 0 && !over && !busy && (!!overall.trim() || picked.every((i) => marksOf(i) > 0))
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => { rootRef.current?.focus({ preventScroll: true }) }, [])
  return (
    <div ref={rootRef} tabIndex={-1} className={`ivg${compact ? ' is-compact' : ''}${picked.length ? ' has-picked' : ''}${busy ? ' is-busy' : ''}`} role="dialog" aria-modal="true" aria-label={tr('viewer.all')}>
      <div className="iv-bar ivg-bar">
        <div className="iv-title">
          <button type="button" className="iv-btn" title={tr('viewer.allBack')} aria-label={tr('viewer.allBack')} onClick={onBack}><ChevronLeft size={16} /></button>
          <b>{tr('viewer.all')}</b><span>{tr('viewer.allCount', { count: items.length })}</span>
        </div>
        <div className="iv-tools"><button type="button" className="iv-btn" title={tr('viewer.close')} aria-label={tr('viewer.close')} onClick={onClose}><X size={16} /></button></div>
      </div>
      <div className="ivg-body">
        <div className="ivg-grid">
          {items.map((it, i) => {
            const on = picked.includes(i)
            const n = marksOf(i)
            return (
              <div key={i} className={`ivg-cell${on ? ' is-on' : ''}${i === current ? ' is-current' : ''}`}>
                <img src={it.src} alt={it.name} title={it.name} draggable={false} role="button" tabIndex={0}
                  onClick={() => onOpen(i)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onOpen(i) } }} />
                {it.editable && (
                  <button type="button" className="ivg-check" aria-pressed={on} title={tr('viewer.pick')} aria-label={`${tr('viewer.pick')} ${it.name}`} onClick={() => onToggle(i)}>
                    {on && <Check size={13} strokeWidth={3} />}
                  </button>
                )}
                {it.editable && (
                  <button type="button" className={`ivg-mark${n ? ' has-marks' : ''}`} onClick={() => onMark(i)}>
                    <PenLine size={12} /><span>{n ? tr('viewer.marks', { count: n }) : tr('viewer.markup')}</span>
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </div>
      {picked.length > 0 ? (
        <div className="imk-dock ivg-dock">
          <span className="ivg-picked">{tr('viewer.picked', { count: picked.length })}</span>
          <input className="imk-overall" value={overall} placeholder={tr('viewer.allPh')} onChange={(e) => onOverall(e.target.value)} />
          <button type="button" className="imk-send" disabled={!canSend} onClick={onSend}>{!busy && <ArrowUp size={15} />}{busy ? tr('viewer.sending') : tr('viewer.sendAll')}</button>
        </div>
      ) : !compact && <div className="iv-hint ivg-hint">{tr('viewer.allHint')}</div>}
      {over && <div className="iv-hint ivg-over" role="status">{tr('viewer.tooMany', { max: MAX_ATTACHMENTS })}</div>}
    </div>
  )
}
