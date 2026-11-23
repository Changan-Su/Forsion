/** 点了「朗读」却还没选朗读模型时,选区下面那张小卡(2026-11-21 用户定:按钮照样在,点了提示去设置;**不回落系统声音**)。
 *  外壳和结果卡同一套(.ui-popover.am-ai-panel),锚在同一段字上;点卡外 / Esc 收。 */
import { useEffect, useRef, type ReactElement } from 'react'
import { Volume2 } from 'lucide-react'
import type { TextAnchor } from '@lcl/engine'
import { OverlayAt } from '@amadeus/lib/clampMenu'
import { registerMessages, useI18n } from '../../i18n'
import '@amadeus/unified/inlineAiPanel.css'

registerMessages({
  'selbar.tts.head': { zh: '朗读', en: 'Read aloud' },
  'selbar.tts.title': { zh: '还没选朗读模型', en: 'No read-aloud model yet' },
  'selbar.tts.body': { zh: '朗读用「设置 → 模型 → 语音」里选的朗读模型和音色。选好之后再点一次。', en: 'Read aloud uses the model and voice picked in Settings → Models → Voice. Pick one, then try again.' },
  'selbar.tts.open': { zh: '去设置', en: 'Open settings' },
  'selbar.tts.close': { zh: '关闭', en: 'Close' },
})

export function TtsSetupCard({ x, y, anchorTop, anchor, onOpenSettings, onClose }: {
  x: number
  y: number
  anchorTop: number
  anchor?: TextAnchor | null
  onOpenSettings(): void
  onClose(): void
}): ReactElement {
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const onDown = (e: MouseEvent): void => { if (!ref.current?.contains(e.target as Node)) closeRef.current() }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.isComposing) return
      const a = document.activeElement
      if (a && !ref.current?.contains(a) && a.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return
      e.preventDefault(); e.stopPropagation(); closeRef.current()
    }
    document.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('mousedown', onDown, true); window.removeEventListener('keydown', onKey, true) }
  }, [])
  return (
    <OverlayAt innerRef={(el) => { ref.current = el }} className="ui-popover am-ai-panel am-tts-setup" x={x} y={y} anchorTop={anchorTop} anchor={anchor} gap={6} prefer="below"
      role="dialog" aria-label={t('selbar.tts.title')} data-testid="tts-setup-card">
      <div className="am-ai-head"><Volume2 size={14} aria-hidden /><span className="am-ai-title">{t('selbar.tts.head')}</span></div>
      <div className="am-tts-setup-title">{t('selbar.tts.title')}</div>
      <div className="am-ai-note">{t('selbar.tts.body')}</div>
      <div className="am-ai-actions">
        <button type="button" className="btn sm primary" data-act="open-settings" onClick={() => { onClose(); onOpenSettings() }}>{t('selbar.tts.open')}</button>
        <button type="button" className="btn sm" data-act="discard" onClick={onClose}>{t('selbar.tts.close')}</button>
      </div>
    </OverlayAt>
  )
}
