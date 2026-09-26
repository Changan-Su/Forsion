import React, { useId, useRef } from 'react'
import { useI18n } from '../../i18n'
import { templateVariables } from './experience'

/** Variable insertion is exposed only on fields expanded by the engine. */
export const TemplateField: React.FC<{
  label: string; value: string; onChange: (value: string) => void
  multiline?: boolean; maxLength?: number; placeholder?: string
  columns?: { id: string; name: string }[]; hasRow?: boolean
}> = ({ label, value, onChange, multiline, maxLength = 4000, placeholder, columns, hasRow }) => {
  const { t } = useI18n()
  const id = useId()
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  const selection = useRef({ start: value.length, end: value.length })
  const insert = (token: string): void => {
    if (!token) return
    const { start, end } = selection.current
    if (value.length - (end - start) + token.length > maxLength) return
    onChange(value.slice(0, start) + token + value.slice(end))
    requestAnimationFrame(() => {
      ref.current?.focus()
      ref.current?.setSelectionRange(start + token.length, start + token.length)
    })
  }
  const props = { id, ref, value, maxLength, placeholder, onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(e.target.value),
    onSelect: (e: React.SyntheticEvent<HTMLInputElement | HTMLTextAreaElement>) => { selection.current = { start: e.currentTarget.selectionStart ?? value.length, end: e.currentTarget.selectionEnd ?? value.length } } }
  return <div className="field auto-template-field">
    <div className="auto-field-heading"><label htmlFor={id}>{label}</label>
      <select aria-label={t('automation.ux.insertVariable', { field: label })} value="" onChange={(e) => insert(e.target.value)}>
        <option value="">{t('automation.ux.variables')}</option>
        <option value="{{today}}">{t('automation.ux.today')}</option>
        <option value="{{now}}">{t('automation.ux.now')}</option>
        {hasRow && <optgroup label={t('automation.ux.triggerRow')}>
          <option value="{{row.id}}">{t('automation.ux.rowId')}</option>
          {templateVariables(columns).map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
        </optgroup>}
      </select>
    </div>
    {multiline ? <textarea {...props} /> : <input type="text" {...props} />}
  </div>
}
