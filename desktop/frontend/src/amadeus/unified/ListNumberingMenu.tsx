import { useState } from 'react'
import { ListOrdered, RotateCcw, ArrowRight } from 'lucide-react'
import type { EditorView } from '@milkdown/kit/prose/view'
import { registerMessages, useI18n } from '../../i18n'
import { numberedListAt, setListStart, validListStart } from './listNumbering'

registerMessages({
  'listnumber.continue': { zh: '继续前一列表', en: 'Continue previous list' },
  'listnumber.unavailable': { zh: '同层级中没有可继续的前一列表。', en: 'No previous list at this level is available.' },
  'listnumber.restart': { zh: '重新从 1 开始', en: 'Restart at 1' },
  'listnumber.set': { zh: '设置起始编号…', en: 'Set starting number…' },
  'listnumber.start': { zh: '起始编号', en: 'Starting number' },
  'listnumber.apply': { zh: '应用', en: 'Apply' },
  'listnumber.cancel': { zh: '取消', en: 'Cancel' },
  'listnumber.invalid': { zh: '请输入 1 至 999999999 的整数。', en: 'Enter a whole number from 1 to 999999999.' },
})

export function ListNumberingMenu({ view, onDone, restore }: { view: EditorView; onDone: () => void; restore: () => boolean }) {
  const { t } = useI18n()
  const [editing, setEditing] = useState(false)
  const list = numberedListAt(view.state)
  const [value, setValue] = useState(() => String(list?.node.attrs.order ?? 1))
  if (!list) return null
  const valid = /^\d+$/.test(value) && validListStart(Number(value))
  const apply = (start: number): void => {
    if (!restore()) { onDone(); return }
    const target = numberedListAt(view.state)
    if (target) setListStart(view, target, start)
    onDone()
    view.focus()
  }
  return <>
    <div className="ubm-sep" role="separator" />
    <button role="menuitem" tabIndex={-1} data-act="listContinue" aria-disabled={list.previousStart == null || undefined}
      title={list.previousStart == null ? t('listnumber.unavailable') : undefined}
      onClick={() => { if (list.previousStart != null) apply(list.previousStart) }}><ArrowRight size={13} />{t('listnumber.continue')}</button>
    <button role="menuitem" tabIndex={-1} data-act="listRestart" onClick={() => apply(1)}><RotateCcw size={13} />{t('listnumber.restart')}</button>
    <button role="menuitem" tabIndex={-1} data-act="listSetStart" aria-expanded={editing} onClick={() => setEditing(!editing)}><ListOrdered size={13} />{t('listnumber.set')}</button>
    {editing && <form className="list-number-form" data-list-numbering-form onSubmit={(e) => { e.preventDefault(); if (valid) apply(Number(value)) }}>
      <label>{t('listnumber.start')}<input autoFocus inputMode="numeric" value={value} aria-label={t('listnumber.start')} aria-invalid={!valid}
        onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setEditing(false) } }} /></label>
      {!valid && <span role="status">{t('listnumber.invalid')}</span>}
      <div><button type="button" onClick={() => setEditing(false)}>{t('listnumber.cancel')}</button><button type="submit" disabled={!valid}>{t('listnumber.apply')}</button></div>
    </form>}
  </>
}
