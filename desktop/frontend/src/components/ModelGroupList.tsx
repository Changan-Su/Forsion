/**
 * 模型选择列表:按 Provider 分组、可折叠(设置页默认全折叠,仅当前选中模型所在组展开)。
 * 同一个分组逻辑(groupModelsByProvider)供设置页与主界面模型选择器共用。
 */
import React, { useMemo, useState } from 'react'
import { ChevronRight, Check, Search } from 'lucide-react'
import type { ModelInfo } from '../types'
import { useI18n } from '../i18n'

import { groupPickerModels, useModelPickerPreferences, type PickerGroup } from '../modelPickerPreferences'
import { ModelMetadata } from './ModelMetadata'
export type ModelGroup = PickerGroup
export const groupModelsByProvider = groupPickerModels

export const ModelGroupList: React.FC<{
  models: ModelInfo[]
  selectedId?: string
  onSelect: (id: string) => void
}> = ({ models, selectedId, onSelect }) => {
  const { t } = useI18n()
  const prefs = useModelPickerPreferences()
  const [query, setQuery] = useState('')
  const groups = useMemo(() => groupModelsByProvider(models, prefs), [models, prefs])
  // 默认全折叠;当前选中模型所在组默认展开。
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const sel = models.find((m) => m.id === selectedId)
    return new Set(groups.filter((g) => g.models.some((m) => m.id === sel?.id)).map((g) => g.key))
  })

  const q = query.trim().toLowerCase()
  const filtered = useMemo(() => {
    if (!q) return groups
    return groups
      .map((g) => ({ ...g, models: g.models.filter((m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)) }))
      .filter((g) => g.models.length > 0)
  }, [groups, q])

  const toggle = (provider: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(provider) ? next.delete(provider) : next.add(provider)
      return next
    })

  const allProviders = filtered.map((g) => g.key)
  const allExpanded = allProviders.length > 0 && allProviders.every((p) => expanded.has(p))
  const sourceTag = (s: ModelGroup['source']): string =>
    s === 'direct' ? t('model.group.direct') : s === 'forsion' ? t('model.group.forsion') : ''

  if (!models.length) return <div className="hint">{t('model.empty')}</div>

  return (
    <div className="model-group-list">
      <div className="model-group-toolbar">
        <span className="model-search">
          <Search size={12} />
          <input value={query} placeholder={t('model.searchPlaceholder')} onChange={(e) => setQuery(e.target.value)} />
        </span>
        <button
          className="btn ghost sm"
          onClick={() => setExpanded(allExpanded ? new Set() : new Set(allProviders))}
        >
          {allExpanded ? t('model.collapseAll') : t('model.expandAll')}
        </button>
      </div>
      {filtered.map((g, index) => {
        const open = q ? true : expanded.has(g.key)
        return (
          <div key={g.key} className="model-group">
            {filtered[index - 1]?.source !== g.source && <div className="model-source-heading">{sourceTag(g.source)}</div>}
            <button className="model-group-head" onClick={() => toggle(g.key)}>
              <ChevronRight size={13} className="model-group-chevron" style={{ transform: open ? 'rotate(90deg)' : 'none' }} />
              <span className="model-group-name">{g.provider || t('picker.ungrouped')}</span>
              <span className="model-group-count">{g.models.length}</span>
            </button>
            {open && (
              <div className="model-group-body">
                {g.models.map((m) => (
                  <button
                    key={`${m.source}-${m.id}`}
                    className={`file-row${m.id === selectedId ? ' active' : ''}`}
                    onClick={() => onSelect(m.id)}
                  >
                    <span className="file-name" style={{ color: m.id === selectedId ? 'var(--accent-ink)' : undefined }}>
                      {m.name}
                    </span>
                    <ModelMetadata model={m} />
                    {m.id === selectedId && <Check size={12} style={{ color: 'var(--accent-ink)' }} />}
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
