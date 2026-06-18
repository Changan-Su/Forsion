/**
 * 设置 → 智能体（Normal Agent）：本地自定义对话人格的 CRUD。
 * 仅本地后端可用（后端 /agent/agents 在云端 404 → listAgents 已降级空列表）。
 */
import React, { useEffect, useMemo, useState } from 'react'
import { Loader2, Plus, Trash2, Pencil, Bot } from 'lucide-react'
import { listAgents, saveAgentDef, deleteAgentDef, listModels } from '../services/backendService'
import type { ModelInfo, NormalAgentDef, TanguDesktopConfig } from '../types'
import { useI18n } from '../i18n'

type Draft = {
  slug?: string
  name: string
  description: string
  model: string
  systemPrompt: string
  thinkingLevel: '' | 'off' | 'low' | 'medium' | 'high'
  maxIterations: string
  approvalMode: '' | 'readonly' | 'auto-edit' | 'full-auto'
}

const emptyDraft = (): Draft => ({
  name: '', description: '', model: '', systemPrompt: '',
  thinkingLevel: '', maxIterations: '', approvalMode: '',
})

export const AgentsTab: React.FC<{ cfg: TanguDesktopConfig }> = ({ cfg }) => {
  const { t } = useI18n()
  const [agents, setAgents] = useState<NormalAgentDef[] | null>(null)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [editing, setEditing] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const load = (): void => {
    void listAgents(cfg).then(setAgents).catch(() => setAgents([]))
  }
  useEffect(() => {
    load()
    void listModels(cfg).then((r) => setModels(r.models)).catch(() => setModels([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const startEdit = (a: NormalAgentDef): void => setEditing({
    slug: a.slug, name: a.name, description: a.description, model: a.model,
    systemPrompt: a.systemPrompt, thinkingLevel: a.thinkingLevel,
    maxIterations: a.maxIterations != null ? String(a.maxIterations) : '', approvalMode: a.approvalMode,
  })

  const save = async (): Promise<void> => {
    if (!editing) return
    setBusy(true)
    setMsg('')
    try {
      await saveAgentDef(cfg, {
        name: editing.name,
        description: editing.description,
        model: editing.model,
        systemPrompt: editing.systemPrompt,
        thinkingLevel: editing.thinkingLevel || undefined,
        maxIterations: editing.maxIterations ? Number(editing.maxIterations) : null,
        approvalMode: editing.approvalMode || undefined,
      } as Partial<NormalAgentDef>, editing.slug)
      setEditing(null)
      load()
    } catch (e: any) {
      setMsg(t('settings.agents.saveFail', { e: e?.message || e }))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (a: NormalAgentDef): Promise<void> => {
    if (!window.confirm(t('settings.agents.deleteConfirm', { name: a.name }))) return
    try { await deleteAgentDef(cfg, a.slug); load() } catch { /* ignore */ }
  }

  const modelOptions = useMemo(() => models.map((m) => ({ id: m.id, label: m.name || m.id })), [models])

  if (editing) {
    return (
      <div className="field">
        <div className="field">
          <label>{t('settings.agents.name')}</label>
          <input type="text" value={editing.name} placeholder={t('settings.agents.namePlaceholder')}
            onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
        </div>
        <div className="field">
          <label>{t('settings.agents.desc')}</label>
          <input type="text" value={editing.description}
            onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
        </div>
        <div className="field">
          <label>{t('settings.agents.model')}</label>
          <select value={editing.model} onChange={(e) => setEditing({ ...editing, model: e.target.value })}>
            <option value="">{t('settings.agents.modelDefault')}</option>
            {modelOptions.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label>{t('settings.agents.systemPrompt')}</label>
          <textarea rows={8} value={editing.systemPrompt} placeholder={t('settings.agents.systemPromptPlaceholder')}
            onChange={(e) => setEditing({ ...editing, systemPrompt: e.target.value })} />
        </div>
        <div className="field-row">
          <div className="field">
            <label>{t('settings.agents.thinking')}</label>
            <select value={editing.thinkingLevel} onChange={(e) => setEditing({ ...editing, thinkingLevel: e.target.value as Draft['thinkingLevel'] })}>
              <option value="">{t('settings.agents.inherit')}</option>
              <option value="off">off</option><option value="low">low</option>
              <option value="medium">medium</option><option value="high">high</option>
            </select>
          </div>
          <div className="field">
            <label>{t('settings.agents.maxIter')}</label>
            <input type="number" min={1} max={200} value={editing.maxIterations}
              onChange={(e) => setEditing({ ...editing, maxIterations: e.target.value })} />
          </div>
          <div className="field">
            <label>{t('settings.agents.approval')}</label>
            <select value={editing.approvalMode} onChange={(e) => setEditing({ ...editing, approvalMode: e.target.value as Draft['approvalMode'] })}>
              <option value="">{t('settings.agents.inherit')}</option>
              <option value="readonly">readonly</option>
              <option value="auto-edit">auto-edit</option>
              <option value="full-auto">full-auto</option>
            </select>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn primary sm" disabled={busy || !editing.name.trim() || !editing.systemPrompt.trim()} onClick={() => void save()}>
            {busy ? <Loader2 size={13} className="spin" /> : null} {t('common.save')}
          </button>
          <button className="btn ghost sm" onClick={() => setEditing(null)}>{t('common.cancel')}</button>
          {msg && <span style={{ fontSize: 12.5, color: 'var(--danger)' }}>{msg}</span>}
        </div>
      </div>
    )
  }

  return (
    <div className="field">
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Bot size={14} /> {t('settings.agents.title')}
      </label>
      <div className="hint" style={{ marginBottom: 8 }}>{t('settings.agents.hint')}</div>
      {agents === null && <div className="hint">{t('common.loading')}</div>}
      {agents?.length === 0 && <div className="hint">{t('settings.agents.empty')}</div>}
      {!!agents?.length && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
          {agents.map((a) => (
            <div key={a.slug} className="file-row" style={{ cursor: 'default' }}>
              <span className="file-name" style={{ flex: 1 }}>
                <b>{a.name}</b>
                {a.createdBy === 'agent' && <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: 11 }}>· {t('settings.agents.byAgent')}</span>}
                {a.description && <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: 12 }}>{a.description.length > 60 ? `${a.description.slice(0, 60)}…` : a.description}</span>}
              </span>
              <button className="icon-btn" title={t('common.edit')} onClick={() => startEdit(a)}><Pencil size={13} /></button>
              <button className="icon-btn" title={t('common.delete')} onClick={() => void remove(a)}><Trash2 size={13} /></button>
            </div>
          ))}
        </div>
      )}
      <button className="btn ghost sm" onClick={() => { setMsg(''); setEditing(emptyDraft()) }}>
        <Plus size={13} /> {t('settings.agents.new')}
      </button>
    </div>
  )
}
