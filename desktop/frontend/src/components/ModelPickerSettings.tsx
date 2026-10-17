import { useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Layers, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import { saveModelPickerPreferences, useModelPickerPreferences, type ModelPickerPreferences } from '../modelPickerPreferences'
import type { ModelInfo } from '../types'
import { ModelMetadata } from './ModelMetadata'
import { SettingsPanel, SettingsRow, SettingsSwitch } from './SettingsPrimitives'
import { MODEL_KINDS, originOf, type CatalogItem, type ModelKind } from './modelKinds'
import { OriginTag } from './DefaultModelsPage'

registerMessages({
  'picker.hint': { zh: '修改自动保存在当前设备。隐藏模型不会删除连接或改变已有会话。', en: 'Changes save automatically on this device. Hiding a model keeps its connection and existing conversations.' },
  'lib.kind.llm': { zh: '对话', en: 'Chat' },
  'lib.kind.image_gen': { zh: '图像生成', en: 'Image generation' },
  'lib.kind.asr': { zh: '语音识别', en: 'Speech recognition' },
  'lib.kind.tts': { zh: '朗读', en: 'Read aloud' },
  'lib.kind.realtime': { zh: '语音通话', en: 'Voice call' },
  'lib.kind.mt': { zh: '翻译', en: 'Translation' },
  'lib.kinds': { zh: '模型类型', en: 'Model types' },
  'lib.hint.llm': { zh: '数字是计费倍率；自带 key 的模型可以改上下文窗口。', en: 'Numbers are billing multipliers. Models on your own key can have their context window changed.' },
  'lib.hint.slotOnly': { zh: '这一类只在「默认模型」里可选，不出现在聊天的模型菜单。', en: 'These are only offered under Default models, not in the chat model menu.' },
  'lib.empty': { zh: '这一类还没有模型。可以在「提供方」里添加自己的连接。', en: 'No models of this kind yet. You can add your own connection under Providers.' },
  'lib.all': { zh: '全部', en: 'All' },
  'lib.vision': { zh: '看图', en: 'Vision' },
  'lib.noVision': { zh: '不看图', en: 'Text only' },
  'lib.thinking': { zh: '思考', en: 'Thinking' },
  'lib.refresh': { zh: '刷新', en: 'Refresh' },
  'picker.groups': { zh: '本地分组', en: 'Local groups' },
  'picker.groupName': { zh: '分组名称', en: 'Group name' },
  'picker.addGroup': { zh: '添加分组', en: 'Add group' },
  'picker.byProvider': { zh: '按提供方', en: 'By provider' },
  'picker.showAll': { zh: '显示全部', en: 'Show all' },
  'picker.hideAll': { zh: '隐藏全部', en: 'Hide all' },
  'picker.visibleModel': { zh: '显示 {name}', en: 'Show {name}' },
  'picker.groupFor': { zh: '{name} 的分组', en: 'Group for {name}' },
  'picker.moveUp': { zh: '上移分组', en: 'Move group up' },
  'picker.moveDown': { zh: '下移分组', en: 'Move group down' },
  'picker.deleteGroup': { zh: '删除分组（模型返回提供方分组）', en: 'Delete group (models return to their provider group)' },
  'picker.ctxWindowHint': { zh: '右侧数字是上下文窗口，按 token 填（272K = 272000）；灰色为自动值：模型本身更大时默认也只用到 272K，填更大的数（或在聊天框模型菜单里选「最大」）即本机开启长上下文，留空恢复默认。对之后的新消息生效。', en: 'The number on the right is the context window in tokens (272K = 272000). Grey is the automatic value: models with larger windows still use 272K by default. Enter a larger number (or pick Maximum in the chat model menu) to turn on long context on this device; clear it to restore the default. Applies to new messages.' },
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
  const capped = !overridden && (model.maxContextWindow ?? 0) > (model.contextWindow ?? 0)
  const title = t(`ctx.windowSource.${model.contextWindowSource || 'default'}`) +
    (capped ? ` · ${t('ctx.windowCapped', { max: model.maxContextWindow!.toLocaleString(), n: (model.contextWindow ?? 0).toLocaleString() })}` : '')
  return <span className="model-catalog-ctx" title={title}>
    <input type="number" min={4000} step={1000} inputMode="numeric"
      key={`${model.id}:${overridden ? model.contextWindow : ''}`} // 保存后列表刷新 → 用新值重挂,defaultValue 才会跟上
      defaultValue={overridden ? model.contextWindow : ''} placeholder={String(model.contextWindow || '')}
      aria-label={t('picker.ctxWindowFor', { name: model.name })} data-source={model.contextWindowSource || 'default'}
      onBlur={(e) => void commit(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />
    {error && <small className="model-catalog-error" role="alert">{error}</small>}
  </span>
}

/**
 * 设置 → 模型 → 模型库(10-17 方案 C,原「分组与显示」):六个类型标签与后台同名同序,每类一张清单。
 * 对话 / 生图 / 识别的模型来自 models,能在选择菜单里隐藏(本机偏好;云端模型也能藏,只是不能改分组 —— 分组归管理员);
 * 朗读 / 通话 / 翻译只在「默认模型」的对应槽里出现,这里只读列出。自带 key 的对话模型可改上下文窗口(本机覆盖)。
 */
export function ModelPickerSettings({ catalog, kind, onKind, subscriptionIds, onContextWindow, onRefresh, loading, autoCompact }: {
  catalog: Record<ModelKind, CatalogItem[]>
  kind: ModelKind
  onKind: (k: ModelKind) => void
  subscriptionIds: string[]
  onContextWindow?: (modelId: string, tokens: number | null) => Promise<void>
  onRefresh?: () => void
  loading?: boolean
  /** 自动压缩阈值:跟上下文窗口同一套心智,放在对话那一类的最上面。 */
  autoCompact?: ReactNode
}) {
  const { t } = useI18n()
  const prefs = useModelPickerPreferences()
  const [name, setName] = useState('')
  const [query, setQuery] = useState('')
  const [source, setSource] = useState<'all' | 'forsion' | 'direct'>('all')
  const [groupsOpen, setGroupsOpen] = useState(false)
  const [error, setError] = useState('')
  const save = (next: ModelPickerPreferences) => {
    try { saveModelPickerPreferences(next); setError('') } catch (e) { setError(String(e)) }
  }
  const items = catalog[kind]
  const q = query.trim().toLowerCase()
  const shown = items.filter((c) => (source === 'all' || c.source === source) && `${c.name} ${c.id} ${c.provider}`.toLowerCase().includes(q))
  const hideable = shown.filter((c) => c.model)
  const slotOnly = kind === 'tts' || kind === 'realtime' || kind === 'mt'
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
  // 先云端后自带,自带的按连接名分组(与选择菜单同一个层级)
  const sections: Array<{ key: string; title: string; rows: CatalogItem[] }> = []
  for (const c of shown) {
    const key = c.source === 'forsion' ? 'forsion' : `direct:${c.provider}`
    let sec = sections.find((x) => x.key === key)
    if (!sec) sections.push(sec = { key, title: c.source === 'forsion' ? t('model.group.forsion') : c.provider, rows: [] })
    sec.rows.push(c)
  }
  sections.sort((a, b) => (a.key === 'forsion' ? -1 : b.key === 'forsion' ? 1 : a.title.localeCompare(b.title)))

  const caps = (m: ModelInfo) => <span className="model-lib-caps">
    <span className="model-tag" data-color={m.supportsVision === false ? 'gray' : 'green'}>{t(m.supportsVision === false ? 'lib.noVision' : 'lib.vision')}</span>
    {m.thinkingLevels?.some((l) => l !== 'off') && <span className="model-tag" data-color="purple">{t('lib.thinking')}</span>}
  </span>
  const row = (c: CatalogItem) => {
    const m = c.model
    const visible = !prefs.hidden.includes(c.id)
    return <SettingsRow key={`${c.source}:${c.id}`} className={`model-lib-row${m && !visible ? ' is-hidden' : ''}`} label={<span title={c.id}>{c.name}</span>}
      description={c.source === 'forsion' ? m?.groupName || undefined : c.id !== c.name ? c.id : undefined}
      control={<div className="model-lib-controls">
        {kind === 'llm' && m && caps(m)}
        {!m && <OriginTag origin={originOf(c, subscriptionIds)} />}
        {m && <ModelMetadata model={m} />}
        {kind === 'llm' && m && onContextWindow && <CtxWindowInput model={m} onSave={onContextWindow} />}
        {m && c.source === 'direct' && <select aria-label={t('picker.groupFor', { name: c.name })} value={prefs.assignments[c.id] ?? '__provider__'} onChange={(e) => changeGroup(c.id, e.target.value)}>
          <option value="__provider__">{t('picker.byProvider')}</option><option value="">{t('picker.ungrouped')}</option>
          {prefs.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>}
        {m && <SettingsSwitch checked={visible} label={t('picker.visibleModel', { name: c.name })} onChange={(on) => save({ ...prefs, hidden: on ? prefs.hidden.filter((id) => id !== c.id) : [...prefs.hidden, c.id] })} />}
      </div>} />
  }

  return <div className="model-lib">
    <div className="model-lib-bar">
      <div className="seg" role="group" aria-label={t('lib.kinds')}>
        {MODEL_KINDS.map((k) => <button key={k} aria-pressed={k === kind} className={k === kind ? 'active' : ''} onClick={() => { onKind(k); setQuery('') }}>
          {t(`lib.kind.${k}`)} <span className="model-lib-count">{catalog[k].length}</span>
        </button>)}
      </div>
      <span className="grow" />
      {kind === 'llm' && <button className="btn ghost sm" aria-expanded={groupsOpen} onClick={() => setGroupsOpen((o) => !o)}><Layers size={12} />{t('picker.groups')}</button>}
      {onRefresh && <button className="btn ghost sm" disabled={loading} onClick={onRefresh}><RefreshCw size={12} className={loading ? 'spin' : ''} />{t('lib.refresh')}</button>}
    </div>
    {kind === 'llm' && groupsOpen && <SettingsPanel icon={<Layers size={14} />} title={t('picker.groups')}>
      <div className="model-lib-groups">
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
    </SettingsPanel>}
    {kind === 'llm' && autoCompact}
    <SettingsPanel title={t(`lib.kind.${kind}`)} description={kind === 'llm' ? t('lib.hint.llm') : slotOnly ? t('lib.hint.slotOnly') : t('picker.hint')}>
      {items.length > 0 && <div className="model-lib-toolbar">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('model.searchPlaceholder')} aria-label={t('model.searchPlaceholder')} />
        <div className="seg seg-sm">{(['all', 'forsion', 'direct'] as const).map((s) => <button key={s} aria-pressed={source === s} className={source === s ? 'active' : ''} onClick={() => setSource(s)}>{t(s === 'all' ? 'lib.all' : s === 'forsion' ? 'origin.cloud' : 'origin.key')}</button>)}</div>
        {hideable.length > 0 && <>
          <button className="btn ghost sm" onClick={() => save({ ...prefs, hidden: prefs.hidden.filter((id) => !hideable.some((c) => c.id === id)) })}>{t('picker.showAll')}</button>
          <button className="btn ghost sm" onClick={() => save({ ...prefs, hidden: [...new Set([...prefs.hidden, ...hideable.map((c) => c.id)])] })}>{t('picker.hideAll')}</button>
        </>}
      </div>}
      {sections.map((sec) => <div key={sec.key}>
        <div className="model-lib-section">{sec.title}<span>· {sec.rows.length}</span></div>
        {sec.rows.map(row)}
      </div>)}
      {!items.length && <div className="hint model-lib-empty">{t('lib.empty')}</div>}
      {error && <div className="hint model-catalog-error" role="alert">{error}</div>}
    </SettingsPanel>
  </div>
}
