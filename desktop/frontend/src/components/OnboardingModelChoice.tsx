import React, { useState } from 'react'
import { Check, ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { groupPickerModels, useModelPickerPreferences } from '../modelPickerPreferences'
import { useI18n } from '../i18n'
import type { ModelsResponse } from '../types'

/** Same source/group/order/visibility rules as the conversation picker. Only chat models belong here. */
export function OnboardingModelChoice({ models, value, onChange }: {
  models: ModelsResponse; value: string; onChange: (id: string) => void
}): React.ReactNode {
  const { t } = useI18n()
  const prefs = useModelPickerPreferences()
  const [query, setQuery] = useState('')
  const [groupKey, setGroupKey] = useState('')
  const [page, setPage] = useState(0)
  const groups = groupPickerModels(models.models.filter((m) => !m.modelType || m.modelType === 'llm'), prefs)
  const needle = query.trim().toLocaleLowerCase()
  const filtered = groups.flatMap((group) => groupKey && group.key !== groupKey ? [] : group.models
    .filter((m) => `${m.name} ${m.id} ${m.provider} ${group.provider}`.toLocaleLowerCase().includes(needle))
    .map((model) => ({ model, group })))
  const pages = Math.max(1, Math.ceil(filtered.length / 6))
  const currentPage = Math.min(page, pages - 1)
  const selected = models.models.find((m) => m.id === value)
  const defaultModel = models.models.find((m) => m.id === models.defaultModelId)
  return <div className="ob-model-choice">
    <div className="ob-model-toolbar">
      <label className="ob-model-search">
        <Search size={16} aria-hidden="true" />
        <input aria-label={t('onboarding.guide.searchModels')} placeholder={t('onboarding.guide.searchModels')} value={query}
          onChange={(e) => { setQuery(e.target.value); setPage(0) }} />
      </label>
      <span className="ob-muted">{filtered.length}</span>
    </div>
    <div className="ob-model-browser">
      <nav className="ob-model-groups" aria-label={t('onboarding.model.choiceLabel')}>
        <button className={!groupKey ? 'active' : ''} aria-pressed={!groupKey} onClick={() => { setGroupKey(''); setPage(0) }}>
          {t('onboarding.guide.allModels')}<span>{groups.reduce((n, g) => n + g.models.length, 0)}</span>
        </button>
        {groups.map((group, index) => <React.Fragment key={group.key}>
          {groups[index - 1]?.source !== group.source && <div className="ob-source-label">{t(group.source === 'forsion' ? 'model.group.forsion' : 'model.group.direct')}</div>}
          <button className={groupKey === group.key ? 'active' : ''} aria-pressed={groupKey === group.key} title={group.provider || t('onboarding.guide.ungrouped')}
            onClick={() => { setGroupKey(group.key); setPage(0) }}>
            <span>{group.provider || t('onboarding.guide.ungrouped')}</span><span>{group.models.length}</span>
          </button>
        </React.Fragment>)}
      </nav>
      <div className="ob-model-results">
        <button className={`ob-model-default${!value ? ' selected' : ''}`} aria-pressed={!value} onClick={() => onChange('')}>
          <span><strong>{t('onboarding.guide.followDefault')}</strong><small>{defaultModel?.name || t('onboarding.guide.noDefault')}</small></span>
          {!value && <Check size={17} />}
        </button>
        <div className="ob-model-grid">
          {filtered.slice(currentPage * 6, (currentPage + 1) * 6).map(({ model, group }) => <button
            key={`${model.source}:${model.id}`} className={`ob-model-option${value === model.id ? ' selected' : ''}`}
            aria-pressed={value === model.id} title={`${model.name} · ${model.provider}`} onClick={() => onChange(model.id)}>
            <span><strong>{model.name}</strong><small>{group.provider || model.provider}</small></span>
            {value === model.id && <Check size={16} />}
          </button>)}
          {!filtered.length && <p className="ob-muted">{t('onboarding.guide.noResults')}</p>}
        </div>
        <div className="ob-model-pagination">
          <span>{t('onboarding.guide.pages', { page: currentPage + 1, pages })}</span>
          <button className="icon-btn" aria-label={t('onboarding.guide.prevPage')} disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={16} /></button>
          <button className="icon-btn" aria-label={t('onboarding.guide.nextPage')} disabled={currentPage === pages - 1} onClick={() => setPage(currentPage + 1)}><ChevronRight size={16} /></button>
        </div>
      </div>
    </div>
    <div className="ob-model-selection" role="status"><span>{t('onboarding.guide.selected')}</span><strong>{value ? selected?.name || value : t('onboarding.guide.followDefault')}</strong>
      {!value && <span className="ob-muted">{t('onboarding.guide.followHint')}</span>}
    </div>
  </div>
}
