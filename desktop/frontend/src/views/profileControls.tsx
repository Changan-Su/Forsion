import { useId, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'
import { useI18n } from '../i18n'
import { Markdown } from '../components/Markdown'
import type { ModelInfo } from '../types'
import { isCoarsePointer } from '../touch'

/** Inline disclosure keeps the searchable picker inside narrow docked panels, including at UI zoom. */
export function ProfileModelField({ models, value, onChange, label, disabled }: {
  models: ModelInfo[]; value: string; onChange: (id: string) => void; label: string; disabled?: boolean
}) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()
  const filtered = models.filter((m) => `${m.name} ${m.id}`.toLowerCase().includes(query.trim().toLowerCase()))
  const choose = (model: string) => { onChange(model); setOpen(false); setQuery(''); trigger.current?.focus() }
  return <div className="profile-model-field agent-field">
    <span id={`${id}-label`}>{label}</span>
    <button ref={trigger} className="profile-model-trigger" disabled={disabled} aria-labelledby={`${id}-label ${id}-value`} aria-expanded={open} aria-controls={`${id}-options`} onClick={() => setOpen(!open)}>
      <span id={`${id}-value`}>{models.find((m) => m.id === value)?.name || value || t('agentProfile.default')}</span><ChevronDown size={15} />
    </button>
    {open && <div className="profile-model-options" id={`${id}-options`} onKeyDown={(e) => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); trigger.current?.focus(); return }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
      if (e.target instanceof HTMLInputElement && (e.key === 'Home' || e.key === 'End')) return
      e.preventDefault(); e.stopPropagation()
      const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('.profile-model-results button'))
      const current = buttons.indexOf(e.target as HTMLButtonElement)
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (current + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
      buttons[next]?.focus()
    }}>
      <label className="profile-search"><Search size={14} /><input autoFocus={!isCoarsePointer()} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('agentProfile.searchModels')} aria-label={t('agentProfile.searchModels')} /></label>
      <div className="profile-model-results">
        <button aria-pressed={!value} onClick={() => choose('')}><span>{t('agentProfile.default')}</span>{!value && <Check size={14} />}</button>
        {filtered.map((m) => <button key={`${m.source}-${m.id}`} aria-pressed={value === m.id} onClick={() => choose(m.id)}><span><strong>{m.name}</strong><small>{m.id}</small></span>{value === m.id && <Check size={14} />}</button>)}
        {!filtered.length && <p className="agent-profile-muted">{t('agentProfile.noResults')}</p>}
        {query.trim() && !filtered.length && <button onClick={() => choose(query.trim())}>{t('agentProfile.useModelId', { id: query.trim() })}</button>}
      </div>
    </div>}
  </div>
}

export function ProfileTextEditor({ label, value, onChange, rows = 8, maxLength, hint, placeholder }: {
  label: string; value: string; onChange: (value: string) => void; rows?: number; maxLength?: number; hint?: string; placeholder?: string
}) {
  const { t } = useI18n()
  const [preview, setPreview] = useState(false)
  const id = useId()
  return <div className="profile-text-editor">
    <div className="profile-editor-heading"><label htmlFor={id}>{label}</label><button type="button" className="profile-text-action" aria-pressed={preview} onClick={() => setPreview(!preview)}>{t(preview ? 'agentProfile.edit' : 'agentProfile.preview')}</button></div>
    {preview ? <div className="md-body profile-text-preview" role="region" aria-label={label}>{value ? <Markdown content={value} /> : <p className="agent-profile-muted">{t('agentProfile.emptyText')}</p>}</div> : <textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} rows={rows} maxLength={maxLength} placeholder={placeholder} />}
    <small className="profile-editor-hint">{hint}<span>{t('agentProfile.characters', { count: value.length })}</span></small>
  </div>
}

export function ProfileGroup({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return <section className="profile-config-group"><h2>{title}</h2>{hint && <p className="agent-profile-muted">{hint}</p>}<div className="agent-config-fields">{children}</div></section>
}
