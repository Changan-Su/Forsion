import { useState } from 'react'
import { ArrowDown, ArrowUp, LockKeyhole, Plus, Trash2 } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import { saveModelPickerPreferences, useModelPickerPreferences, groupPickerModels, type ModelPickerPreferences } from '../modelPickerPreferences'
import type { ModelInfo } from '../types'
import { ModelMetadata } from './ModelMetadata'

registerMessages({
  'picker.hint': { zh: '修改自动保存在当前设备。隐藏模型不会删除连接或改变已有会话。', en: 'Changes save automatically on this device. Hiding a model keeps its connection and existing conversations.' },
  'picker.localModels': { zh: '本地模型显示范围', en: 'Visible local models' },
  'picker.cloudHint': { zh: '云端模型始终显示；分组、排序、标签和倍率由管理员维护。', en: 'Cloud models always appear. Groups, order, tags and multipliers are managed by your administrator.' },
  'picker.groups': { zh: '本地分组', en: 'Local groups' },
  'picker.groupName': { zh: '分组名称', en: 'Group name' },
  'picker.addGroup': { zh: '添加分组', en: 'Add group' },
  'picker.byProvider': { zh: '按提供方', en: 'By provider' },
  'picker.showAll': { zh: '显示全部', en: 'Show all' },
  'picker.hideAll': { zh: '隐藏全部', en: 'Hide all' },
  'picker.visible': { zh: '显示 {shown} / {total}', en: 'Showing {shown} / {total}' },
  'picker.visibleModel': { zh: '显示 {name}', en: 'Show {name}' },
  'picker.groupFor': { zh: '{name} 的分组', en: 'Group for {name}' },
  'picker.moveUp': { zh: '上移分组', en: 'Move group up' },
  'picker.moveDown': { zh: '下移分组', en: 'Move group down' },
  'picker.deleteGroup': { zh: '删除分组（模型返回提供方分组）', en: 'Delete group (models return to their provider group)' },
  'picker.emptyLocal': { zh: '添加提供方并拉取模型后，可在这里筛选和分组。', en: 'Add a provider and fetch its models to filter and group them here.' },
  'picker.ctxWindowHint': { zh: '右侧数字是上下文窗口，按 token 填（272K = 272000）；灰色为自动识别值，填了即本机覆盖，留空恢复自动。对之后的新消息生效。', en: 'The number on the right is the context window in tokens (272K = 272000). Grey means auto-detected; typing a value overrides it on this device, clearing restores auto-detect. Applies to new messages.' },
  'picker.ctxWindowFor': { zh: '{name} 的上下文窗口（tokens）', en: 'Context window for {name} (tokens)' },
  'picker.ctxWindowInvalid': { zh: '按 token 填，最小 4000（272K 请填 272000）', en: 'Enter tokens, minimum 4000 (for 272K enter 272000)' },
})

/** 每行一个窗口输入框:有值 = 本机覆盖;占位符 = 引擎当前解析出的值;悬浮显示来源(自报 / 族表 / 兜底)。 */
function CtxWindowInput({ model, onSave }: { model: ModelInfo; onSave: (modelId: string, tokens: number | null) => Promise<void> }) {
  const { t } = useI18n()
  const [error, setError] = useState('')
  const overridden = model.contextWindowSource === 'override'
  const commit = async (raw: string) => {
    const text = raw.trim()
    const tokens = text === '' ? null : Number(text)
    if (tokens !== null && (!Number.isFinite(tokens) || tokens < 4000)) { setError(t('picker.ctxWindowInvalid')); return }
    if (tokens === null ? !overridden : (overridden && tokens === model.contextWindow)) return // 没变化不打后端
    try { await onSave(model.id, tokens); setError('') } catch (e: any) { setError(e?.message || String(e)) }
  }
  return <span className="model-catalog-ctx" title={t(`ctx.windowSource.${model.contextWindowSource || 'default'}`)}>
    <input type="number" min={4000} step={1000} inputMode="numeric"
      key={`${model.id}:${overridden ? model.contextWindow : ''}`} // 保存后列表刷新 → 用新值重挂,defaultValue 才会跟上
      defaultValue={overridden ? model.contextWindow : ''} placeholder={String(model.contextWindow || '')}
      aria-label={t('picker.ctxWindowFor', { name: model.name })} data-source={model.contextWindowSource || 'default'}
      onBlur={(e) => void commit(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />
    {error && <small className="model-catalog-error" role="alert">{error}</small>}
  </span>
}

export function ModelPickerSettings({ models, onContextWindow }: { models: ModelInfo[]; onContextWindow?: (modelId: string, tokens: number | null) => Promise<void> }) {
  const { t } = useI18n()
  const prefs = useModelPickerPreferences()
  const [name, setName] = useState('')
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const save = (next: ModelPickerPreferences) => {
    try { saveModelPickerPreferences(next); setError('') } catch (e) { setError(String(e)) }
  }
  const local = models.filter((m) => m.source === 'direct')
  const cloud = groupPickerModels(models.filter((m) => m.source === 'forsion'))
  const q = query.trim().toLowerCase()
  const filtered = local.filter((m) => `${m.name} ${m.id} ${m.provider}`.toLowerCase().includes(q))
  const changeGroup = (id: string, group: string) => {
    const assignments = { ...prefs.assignments }
    if (group === '__provider__') delete assignments[id]
    else assignments[id] = group
    save({ ...prefs, assignments })
  }
  const move = (index: number, delta: number) => {
    const groups = [...prefs.groups]
    ;[groups[index], groups[index + delta]] = [groups[index + delta], groups[index]]
    save({ ...prefs, groups })
  }
  return <section className="field model-catalog-settings">
    <div className="hint">{t('picker.hint')}</div>
    {onContextWindow && <div className="hint">{t('picker.ctxWindowHint')}</div>}
    <details className="model-catalog-cloud">
      <summary><LockKeyhole size={13} /> {t('model.group.forsion')} · {cloud.reduce((n, g) => n + g.models.length, 0)}</summary>
      <p className="hint">{t('picker.cloudHint')}</p>
      <div className="model-catalog-model-list">{cloud.map((g) => <div key={g.key}>
        {g.provider && <div className="model-source-heading">{g.provider}</div>}
        {g.models.map((m) => <div key={m.id} className="model-catalog-model"><span className="model-catalog-name">{m.name}</span><ModelMetadata model={m} />{onContextWindow && (m.modelType || 'llm') === 'llm' && <CtxWindowInput model={m} onSave={onContextWindow} />}</div>)}
      </div>)}</div>
    </details>
    <div>
      <label>{t('picker.groups')}</label>
      {prefs.groups.map((g, index) => <div key={g.id} className="model-catalog-group-editor">
        <input aria-label={t('picker.groupName')} maxLength={100} defaultValue={g.name} onBlur={(e) => {
          const next = e.currentTarget.value.trim()
          if (next) save({ ...prefs, groups: prefs.groups.map((x) => x.id === g.id ? { ...x, name: next } : x) })
          else e.currentTarget.value = g.name
        }} />
        <button className="icon-btn" title={t('picker.moveUp')} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={13} /></button>
        <button className="icon-btn" title={t('picker.moveDown')} disabled={index === prefs.groups.length - 1} onClick={() => move(index, 1)}><ArrowDown size={13} /></button>
        <button className="icon-btn" title={t('picker.deleteGroup')} onClick={() => save({ ...prefs, groups: prefs.groups.filter((x) => x.id !== g.id) })}><Trash2 size={13} /></button>
      </div>)}
      <form className="model-catalog-toolbar" onSubmit={(e) => { e.preventDefault(); if (name.trim()) { save({ ...prefs, groups: [...prefs.groups, { id: crypto.randomUUID(), name: name.trim() }] }); setName('') } }}>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder={t('picker.groupName')} aria-label={t('picker.groupName')} />
        <button className="btn ghost sm" disabled={!name.trim()}><Plus size={13} />{t('picker.addGroup')}</button>
      </form>
    </div>
    <label>{t('picker.localModels')}</label>
    <div className="model-catalog-toolbar">
      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('model.searchPlaceholder')} aria-label={t('model.searchPlaceholder')} />
      <button className="btn ghost sm" onClick={() => save({ ...prefs, hidden: prefs.hidden.filter((id) => !filtered.some((m) => m.id === id)) })}>{t('picker.showAll')}</button>
      <button className="btn ghost sm" onClick={() => save({ ...prefs, hidden: [...new Set([...prefs.hidden, ...filtered.map((m) => m.id)])] })}>{t('picker.hideAll')}</button>
      <span className="hint">{t('picker.visible', { shown: local.filter((m) => !prefs.hidden.includes(m.id)).length, total: local.length })}</span>
    </div>
    <div className="model-catalog-model-list">{filtered.map((m) => <div key={m.id} className="model-catalog-model">
      <input type="checkbox" checked={!prefs.hidden.includes(m.id)} aria-label={t('picker.visibleModel', { name: m.name })} onChange={(e) => save({ ...prefs, hidden: e.target.checked ? prefs.hidden.filter((id) => id !== m.id) : [...prefs.hidden, m.id] })} />
      <span className="model-catalog-name" title={m.id}>{m.name}<small>{m.provider}</small></span>
      <select aria-label={t('picker.groupFor', { name: m.name })} value={prefs.assignments[m.id] ?? '__provider__'} onChange={(e) => changeGroup(m.id, e.target.value)}>
        <option value="__provider__">{t('picker.byProvider')}</option><option value="">{t('picker.ungrouped')}</option>
        {prefs.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
      </select>
      {onContextWindow && (m.modelType || 'llm') === 'llm' && <CtxWindowInput model={m} onSave={onContextWindow} />}
    </div>)}{!local.length && <div className="hint">{t('picker.emptyLocal')}</div>}</div>
    {error && <div className="hint model-catalog-error" role="alert">{error}</div>}
  </section>
}
