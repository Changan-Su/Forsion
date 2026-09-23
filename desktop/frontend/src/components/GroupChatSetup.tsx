/**
 * 团队模式(群聊)成员设置:选 ≥2 个参与者(已有 Normal Agent 勾选 + 临时 Agent 内联创建)。
 * 临时 Agent 字段同 Normal Agent,但**不持久化**到 ~/.tangu/agents,仅随本会话 agentConfig 传给后端。
 * 确认 → 写入会话 agentConfig(groupChat/groupAgents/groupTempAgents)。09-16 起没有讨论强度 / 轮数:成员各自以 DONE 表态收场。
 */
import React, { useMemo, useState } from 'react'
import { Users, Check, X, Plus, Pencil, Trash2, UserPlus } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import { THINKING_LEVELS } from '../types'

registerMessages({
  'group.setup.selfPacedHint': { zh: '发消息后成员同时开工,可相互 @ 交接;每位成员自己决定何时收尾,全员完成即结束,没有轮数上限。', en: 'After you send, members work in parallel and can @-mention each other; each decides when they are done, and the team stops once everyone is — no round limit.' },
})
import type { ModelInfo, NormalAgentDef, ThinkingLevel } from '../types'

export interface GroupSetupResult {
  groupAgents: string[]
  groupTempAgents: NormalAgentDef[]
}

type TempDraft = {
  slug?: string
  name: string
  description: string
  model: string
  systemPrompt: string
  thinkingLevel: '' | ThinkingLevel
  maxIterations: string
  approvalMode: '' | 'readonly' | 'auto-edit' | 'full-auto' | 'custom'
}

const emptyDraft = (): TempDraft => ({ name: '', description: '', model: '', systemPrompt: '', thinkingLevel: '', maxIterations: '', approvalMode: '' })

const genSlug = (): string => `temp-${Date.now().toString(36)}-${Math.floor(Math.random() * 46656).toString(36)}`

export const GroupChatSetup: React.FC<{
  agents: NormalAgentDef[]
  models?: ModelInfo[] | null
  initialAgents: string[]
  initialTempAgents?: NormalAgentDef[]
  active: boolean
  hideDisable?: boolean
  onConfirm: (r: GroupSetupResult) => void
  onDisable: () => void
  onClose: () => void
}> = ({ agents, models, initialAgents, initialTempAgents, active, hideDisable, onConfirm, onDisable, onClose }) => {
  const { t } = useI18n()
  const savedSlugs = useMemo(() => new Set(agents.map((a) => a.slug)), [agents])
  const [selectedSaved, setSelectedSaved] = useState<string[]>(() => initialAgents.filter((s) => savedSlugs.has(s)))
  const [tempAgents, setTempAgents] = useState<NormalAgentDef[]>(initialTempAgents || [])
  const [editingTemp, setEditingTemp] = useState<TempDraft | null>(null)

  const modelOptions = useMemo(() => (models || []).map((m) => ({ id: m.id, label: m.name || m.id })), [models])
  const total = selectedSaved.length + tempAgents.length
  const canStart = total >= 2

  const toggleSaved = (slug: string) =>
    setSelectedSaved((prev) => (prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug]))

  const saveTemp = () => {
    if (!editingTemp || !editingTemp.name.trim() || !editingTemp.systemPrompt.trim()) return
    const slug = editingTemp.slug || genSlug()
    const def: NormalAgentDef = {
      slug, name: editingTemp.name.trim(), description: editingTemp.description.trim(),
      model: editingTemp.model, tools: [], thinkingLevel: editingTemp.thinkingLevel,
      maxIterations: editingTemp.maxIterations ? Number(editingTemp.maxIterations) : null,
      approvalMode: editingTemp.approvalMode, createdBy: 'user', createdAt: '', systemPrompt: editingTemp.systemPrompt.trim(),
    }
    setTempAgents((prev) => {
      const i = prev.findIndex((tg) => tg.slug === slug)
      if (i >= 0) { const n = prev.slice(); n[i] = def; return n }
      return [...prev, def]
    })
    setEditingTemp(null)
  }

  const confirm = () => {
    if (!canStart) return
    onConfirm({
      groupAgents: [...selectedSaved, ...tempAgents.map((a) => a.slug)],
      groupTempAgents: tempAgents,
    })
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'var(--overlay-scrim)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div data-team-setup onClick={(e) => e.stopPropagation()} style={{
        width: 480, maxWidth: '92vw', maxHeight: '86vh', overflow: 'auto', borderRadius: 'var(--radius-md, 12px)',
        background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)',
        boxShadow: 'var(--card-shadow)', padding: 18,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <Users size={18} />
          <strong style={{ fontSize: 'var(--ui-font-heading, 14px)', flex: 1 }}>{t('group.setup.title')}</strong>
          <button className="icon-btn" onClick={onClose} title={t('group.setup.close')}><X size={16} /></button>
        </div>

        {editingTemp ? (
          /* ── 临时 Agent 表单(字段同 Normal Agent,不持久化)── */
          <div className="field">
            <div className="hint" style={{ marginBottom: 8 }}>{t('group.setup.tempFormHint')}</div>
            <div className="field">
              <label>{t('settings.agents.name')}</label>
              <input type="text" value={editingTemp.name} placeholder={t('settings.agents.namePlaceholder')}
                onChange={(e) => setEditingTemp({ ...editingTemp, name: e.target.value })} />
            </div>
            <div className="field">
              <label>{t('settings.agents.desc')}</label>
              <input type="text" value={editingTemp.description}
                onChange={(e) => setEditingTemp({ ...editingTemp, description: e.target.value })} />
            </div>
            <div className="field">
              <label>{t('settings.agents.model')}</label>
              <select value={editingTemp.model} onChange={(e) => setEditingTemp({ ...editingTemp, model: e.target.value })}>
                <option value="">{t('settings.agents.modelDefault')}</option>
                {modelOptions.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label>{t('settings.agents.systemPrompt')}</label>
              <textarea rows={6} value={editingTemp.systemPrompt} placeholder={t('settings.agents.systemPromptPlaceholder')}
                onChange={(e) => setEditingTemp({ ...editingTemp, systemPrompt: e.target.value })} />
            </div>
            <div className="field-row">
              <div className="field">
                <label>{t('settings.agents.thinking')}</label>
                <select value={editingTemp.thinkingLevel} onChange={(e) => setEditingTemp({ ...editingTemp, thinkingLevel: e.target.value as TempDraft['thinkingLevel'] })}>
                  <option value="">{t('settings.agents.inherit')}</option>
                  {THINKING_LEVELS.map((lv) => <option key={lv} value={lv}>{lv}</option>)}
                </select>
              </div>
              <div className="field">
                <label>{t('settings.agents.maxIter')}</label>
                {/* min=10 与引擎 AGENT_MAX_ITERATIONS_MIN 同步(群聊发言人的上限同样经 agentCapOf 套下限) */}
                <input type="number" min={10} max={200} value={editingTemp.maxIterations}
                  onChange={(e) => setEditingTemp({ ...editingTemp, maxIterations: e.target.value })} />
              </div>
              <div className="field">
                <label>{t('settings.agents.approval')}</label>
                <select value={editingTemp.approvalMode} onChange={(e) => setEditingTemp({ ...editingTemp, approvalMode: e.target.value as TempDraft['approvalMode'] })}>
                  <option value="">{t('settings.agents.inherit')}</option>
                  <option value="readonly">readonly</option>
                  <option value="auto-edit">auto-edit</option>
                  <option value="full-auto">full-auto</option>
                  <option value="custom">custom</option>
                </select>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn primary sm" disabled={!editingTemp.name.trim() || !editingTemp.systemPrompt.trim()} onClick={saveTemp}>
                <Check size={13} /> {t('group.setup.tempSave')}
              </button>
              <button className="btn ghost sm" onClick={() => setEditingTemp(null)}>{t('group.setup.close')}</button>
            </div>
          </div>
        ) : (
          <>
            {/* 已有 Agent 多选 */}
            {agents.length > 0 && (
              <>
                <div style={{ fontSize: 'var(--ui-font-meta, 12px)', fontWeight: 600, margin: '8px 0 6px', color: 'var(--text-dim)' }}>{t('group.setup.savedAgents')}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
                  {agents.map((a) => {
                    const on = selectedSaved.includes(a.slug)
                    return (
                      <button key={a.slug} onClick={() => toggleSaved(a.slug)} style={{
                        display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left', padding: '8px 10px', borderRadius: 'var(--radius-sm, 6px)',
                        border: `1px solid ${on ? 'var(--accent-ink)' : 'var(--border)'}`,
                        background: on ? 'var(--accent-soft)' : 'transparent', color: 'inherit', cursor: 'pointer',
                      }}>
                        <span style={{ width: 16, height: 16, borderRadius: 4, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: `1px solid ${on ? 'var(--accent-ink)' : 'var(--border)'}`, background: on ? 'var(--accent-ink)' : 'transparent' }}>
                          {on && <Check size={12} color="var(--on-accent-ink, var(--on-accent))" />}
                        </span>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 'var(--ui-font-body, 13px)', fontWeight: 600 }}>{a.name}</div>
                          {a.description && <div style={{ fontSize: 'var(--ui-font-caption, 11px)', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.description}</div>}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </>
            )}

            {/* 临时 Agent(本会话用,不保存) */}
            <div style={{ fontSize: 'var(--ui-font-meta, 12px)', fontWeight: 600, margin: '8px 0 6px', color: 'var(--text-dim)' }}>{t('group.setup.tempAgents')}</div>
            {tempAgents.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
                {tempAgents.map((a) => (
                  <div key={a.slug} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 'var(--radius-sm, 6px)', border: '1px solid var(--accent-ink)', background: 'var(--accent-soft)' }}>
                    <UserPlus size={14} style={{ flexShrink: 0, opacity: 0.8 }} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontSize: 'var(--ui-font-body, 13px)', fontWeight: 600 }}>{a.name}</span>
                      <span style={{ fontSize: 'var(--ui-font-caption, 11px)', color: 'var(--text-dim)', marginLeft: 6 }}>{t('group.setup.tempBadge')}</span>
                    </span>
                    <button className="icon-btn" title={t('common.edit')} onClick={() => setEditingTemp({ slug: a.slug, name: a.name, description: a.description, model: a.model, systemPrompt: a.systemPrompt, thinkingLevel: a.thinkingLevel, maxIterations: a.maxIterations != null ? String(a.maxIterations) : '', approvalMode: a.approvalMode })}><Pencil size={13} /></button>
                    <button className="icon-btn" title={t('common.delete')} onClick={() => setTempAgents((prev) => prev.filter((x) => x.slug !== a.slug))}><Trash2 size={13} /></button>
                  </div>
                ))}
              </div>
            )}
            <button className="btn ghost sm" style={{ marginBottom: 14 }} onClick={() => setEditingTemp(emptyDraft())}>
              <Plus size={13} /> {t('group.setup.addTemp')}
            </button>

            <div style={{ fontSize: 'var(--ui-font-meta, 12px)', color: 'var(--text-dim)', margin: '6px 0 14px' }}>{t('group.setup.selfPacedHint')}</div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              {active && !hideDisable && <button className="btn sm" onClick={() => { onDisable(); onClose() }}>{t('group.setup.disable')}</button>}
              <button className="btn primary sm" onClick={confirm} disabled={!canStart}>{active ? t('group.setup.update') : t('group.setup.start')}</button>
            </div>
            {!canStart && <div style={{ fontSize: 'var(--ui-font-caption, 11px)', color: 'var(--danger)', textAlign: 'right', marginTop: 6 }}>{t('group.setup.needTwo')}</div>}
          </>
        )}
      </div>
    </div>
  )
}
