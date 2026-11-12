import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronLeft, X } from 'lucide-react'
import { OverlayAt, rectAnchor } from '@lcl/engine'
import { registerMessages, useI18n } from '../../../i18n'
import { BG_COLORS, CARD_COLORS, TEXT_COLORS } from './colorPaletteValues'
import './colorPalette.css'

registerMessages({
  'palette.text': { zh: '文字', en: 'Text' },
  'palette.fill': { zh: '背景', en: 'Fill' },
  'palette.accent': { zh: '跟随强调色', en: 'Follow accent' },
  'palette.default': { zh: '默认', en: 'Default' },
  'palette.none': { zh: '无背景', en: 'None' },
  'palette.more': { zh: '更多颜色…', en: 'More colors…' },
  'palette.custom': { zh: '自定义颜色', en: 'Custom color' },
  'palette.rgb': { zh: 'RGB 颜色值', en: 'RGB color value' },
  'palette.apply': { zh: '应用', en: 'Apply' },
  'palette.close': { zh: '关闭', en: 'Close' },
  'palette.back': { zh: '返回', en: 'Back' },
  'palette.selection': { zh: '应用于选中文字', en: 'Selected text' },
  'palette.block': { zh: '应用于整个分块', en: 'Entire block' },
  'palette.blockMenu': { zh: '分块颜色…', en: 'Block color…' },
})

type Mode = 'text' | 'fill'
export interface ColorPaletteProps {
  initial: Mode
  text?: string
  fill?: string
  scope?: 'selection' | 'block'
  onText?: (value: string) => void
  onFill: (value: string) => void
  onClose: () => void
  anchor: HTMLElement | null
  fallback?: { x: number; y: number }
}

/** Independent popover: its dimensions never stretch the selection toolbar. */
export function ColorPalettePopover(p: ColorPaletteProps) {
  const { t } = useI18n()
  const [mode, setMode] = useState<Mode>(p.initial)
  const [custom, setCustom] = useState(false)
  const [hex, setHex] = useState('#808080')
  const root = useRef<HTMLDivElement | null>(null)
  const anchor = useMemo(() => p.anchor ? rectAnchor(p.anchor, () => p.anchor!.getBoundingClientRect()) : null, [p.anchor])
  useEffect(() => () => anchor?.dispose(), [anchor])
  useEffect(() => {
    if (p.anchor === document.activeElement) root.current?.querySelector<HTMLElement>('[role="tab"]')?.focus()
  }, [p.anchor])
  const current = (mode === 'text' ? p.text : p.fill) || ''
  const accent = mode === 'text' ? 'var(--signal)' : p.scope === 'block' ? 'accent' : 'var(--amx-accent-fill)'
  const colors = mode === 'text' ? TEXT_COLORS : p.scope === 'block' ? CARD_COLORS : BG_COLORS
  const customSelected = !!current && current !== accent && !colors.some((c) => c.v === current)
  const apply = (value: string): void => { if (mode === 'text') p.onText?.(value); else p.onFill(value) }
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault(); e.stopImmediatePropagation()
      if (custom) { setCustom(false); queueMicrotask(() => root.current?.querySelector<HTMLElement>('[data-more]')?.focus()) }
      else p.onClose()
    }
    const outside = (e: PointerEvent): void => {
      if (e.target instanceof Node && !root.current?.contains(e.target) && !p.anchor?.contains(e.target)) p.onClose()
    }
    window.addEventListener('keydown', key, true)
    window.addEventListener('pointerdown', outside, true)
    return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('pointerdown', outside, true) }
  }, [custom, p.onClose, p.anchor])
  // Keep the editor's selection when using the mouse; keyboard activation is native click.
  const pick = (value: string) => ({ onMouseDown: (e: React.MouseEvent) => { e.preventDefault(); apply(value) }, onClick: (e: React.MouseEvent) => { if (!e.detail) apply(value) } })
  const r = p.anchor?.getBoundingClientRect()
  return createPortal(<OverlayAt className="ui-popover amx-color-popover" role="dialog" aria-label={t('palette.custom')}
    x={r?.left ?? p.fallback?.x ?? 8} y={(r?.bottom ?? p.fallback?.y ?? 8) + 6} anchorTop={(r?.top ?? 8) - 6} anchor={anchor}
    innerRef={(el) => { root.current = el }} onMouseDown={(e) => { if (!(e.target instanceof HTMLInputElement)) e.preventDefault() }}
    onKeyDown={(e) => {
      if (e.target instanceof HTMLInputElement) return
      if (e.key === 'Tab' && !custom && p.onText) {
        e.preventDefault(); setMode(mode === 'text' ? 'fill' : 'text')
        queueMicrotask(() => root.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus())
      } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
        e.preventDefault(); e.stopPropagation()
        const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>('[data-color-option]') ?? [])]
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const delta = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1
        buttons[e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (i + delta + buttons.length) % buttons.length]?.focus()
      }
    }}>
    <div className="amx-palette-head">
      {custom ? <button onClick={() => setCustom(false)} aria-label={t('palette.back')}><ChevronLeft size={14} /></button> :
        <div role="tablist" aria-label={t('itb.colorMenu')}>
          {(['text', 'fill'] as const).filter((m) => m !== 'text' || p.onText).map((m) => <button key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)}>{t(`palette.${m}`)}</button>)}
        </div>}
      {custom && <span>{t('palette.custom')}</span>}
      <button className="amx-palette-close" onClick={p.onClose} aria-label={t('palette.close')}><X size={14} /></button>
    </div>
    {custom ? <form className="amx-palette-custom" onSubmit={(e) => { e.preventDefault(); if (/^#[0-9a-f]{6}$/i.test(hex)) apply(hex) }}>
      <input type="color" aria-label={t('palette.custom')} value={/^#[0-9a-f]{6}$/i.test(hex) ? hex : '#808080'} onChange={(e) => setHex(e.target.value)} />
      <input aria-label={t('palette.rgb')} value={hex} onChange={(e) => setHex(e.target.value)} autoFocus />
      <button type="submit" disabled={!/^#[0-9a-f]{6}$/i.test(hex)}>{t('palette.apply')}</button>
    </form> : <>
      <button className="amx-palette-option" data-color-option data-color-value="default" {...pick('')}><span>{t(mode === 'text' ? 'palette.default' : 'palette.none')}</span>{!current && <Check size={14} />}</button>
      <button className="amx-palette-option" data-color-option data-color-value="accent" {...pick(accent)}><i className="amx-palette-accent" /><span>{t('palette.accent')}</span>{current === accent && <Check size={14} />}</button>
      <div className="amx-palette-grid">
        {colors.filter((c) => c.v).map((c) => <button key={c.v} data-color-option data-color-value={c.v}
          data-fg={mode === 'text' ? c.v : undefined} data-bg={mode === 'fill' ? c.v : undefined}
          title={t(c.nameKey)} aria-label={t(c.nameKey)} aria-pressed={current === c.v} {...pick(c.v)}>
          {mode === 'text' ? <span data-hlc={c.nameKey.slice('itb.color.'.length)} style={{ color: c.v }}>A</span> : <i style={{ background: /^[1-6]$/.test(c.v) ? `var(--amx-cv-${c.v})` : c.v }} />}{current === c.v && <Check size={12} />}
        </button>)}
      </div>
      <button className="amx-palette-option" data-more data-color-option onClick={() => { if (/^#[0-9a-f]{6}$/i.test(current)) setHex(current); setCustom(true) }}><span>{t('palette.more')}</span>{customSelected && <Check size={14} />}</button>
    </>}
    <div className="amx-palette-scope">{t(p.scope === 'block' ? 'palette.block' : 'palette.selection')}</div>
  </OverlayAt>, document.body)
}
