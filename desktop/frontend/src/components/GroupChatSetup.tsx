/**
 * 群聊模式设置:选 ≥2 个参与者(已有 Normal Agent 勾选 + 临时 Agent 内联创建)+ 讨论强度。
 * 临时 Agent 字段同 Normal Agent,但**不持久化**到 ~/.tangu/agents,仅随本会话 agentConfig 传给后端。
 * 确认 → 写入会话 agentConfig(groupChat/groupAgents/groupTempAgents/groupIntensity/groupMaxRounds)。
 */
import React, { useMemo, useState } from 'react'
import { Users, Check, X, Plus, Pencil, Trash2, UserPlus } from 'lucide-react'
import { useI18n } from '../i18n'
import type { ModelInfo, NormalAgentDef } from '../types'

type Intensity = 'relaxed' | 'medium' | 'intense' | 'custom'
const PRESET_ROUNDS: Record<Exclude<Intensity, 'custom'>, number> = { relaxed: 3, medium: 7, intense: 15 }

export interface GroupSetupResult {
  groupAgents: string[]
  groupTempAgents: NormalAgentDef[]
  groupIntensity: Intensity
  groupMaxRounds: number
}

type TempDraft = {
  slug?: string
  name: string
  description: string
  model: string
  systemPrompt: string
  thinkingLevel: '' | 'off' | 'low' | 'medium' | 'high'
  maxIterations: string
  approvalMode: '' | 'readonly' | 'auto-edit' | 'full-auto'
}

const emptyDraft = (): TempDraft => ({ name: '', description: '', model: '', systemPrompt: '', thinkingLevel: '', maxIterations: '', approvalMode: '' })

const genSlug = (): string => `temp-${Date.now().toString(36)}-${Math.floor(Math.random() * 46656).toString(36)}`

export const GroupChatSetup: React.FC<{
  agents: NormalAgentDef[]
  models?: ModelInfo[] | null
  initialAgents: string[]
  initialTempAgents?: NormalAgentDef[]
  initialIntensity?: Intensity
  initialRounds?: number
  active: boolean
  onConfirm: (r: GroupSetupResult) => void
  onDisable: () => void
  onClose: () => void
}> = ({ agents, models, initialAgents, initialTempAgents, initialIntensity = 'medium', initialRounds = 7, active, onConfirm, onDisable, onClose }) => {
  const { t } = useI18n()
  const savedSlugs = useMemo(() => new Set(agents.map((a) => a.slug)), [agents])
  const [selectedSaved, setSelectedSaved] = useState<string[]>(() => initialAgents.filter((s) => savedSlugs.has(s)))
  const [tempAgents, setTempAgents] = useState<NormalAgentDef[]>(initialTempAgents || [])
  const [intensity, setIntensity] = useState<Intensity>(initialIntensity)
  const [customRounds, setCustomRounds] = useState<number>(initialIntensity === 'custom' ? initialRounds : 5)
  const [editingTemp, setEditingTemp] = useState<TempDraft | null>(null)

  const modelOptions = useMemo(() => (models || []).map((m) => ({ id: m.id, label: m.name || m.id })), [models])
  const rounds = intensity === 'custom' ? Math.max(1, Math.min(30, Math.floor(customRounds) || 1)) : PRESET_ROUNDS[intensity]
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
      groupIntensity: intensity,
      groupMaxRounds: rounds,
    })
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: 480, maxWidth: '92vw', maxHeight: '86vh', overflow: 'auto', borderRadius: 12,
        background: 'var(--bg, #1e1e1e)', color: 'var(--text, #eee)', border: '1px solid var(--border, rgba(127,127,127,0.25))',
        boxShadow: '0 12px 40px rgba(0,0,0,0.35)', padding: 18,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <Users size={18} />
          <strong style={{ fontSize: 15, flex: 1 }}>{t('group.setup.title')}</strong>
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
                  <option value="off">off</option><option value="low">low</option>
                  <option value="medium">medium</option><option value="high">high</option>
                </select>
              </div>
              <div className="field">
                <label>{t('settings.agents.maxIter')}</label>
                <input type="number" min={1} max={200} value={editingTemp.maxIterations}
                  onChange={(e) => setEditingTemp({ ...editingTemp, maxIterations: e.target.value })} />
              </div>
              <div className="field">
                <label>{t('settings.agents.approval')}</label>
                <select value={editingTemp.approvalMode} onChange={(e) => setEditingTemp({ ...editingTemp, approvalMode: e.target.value as TempDraft['approvalMode'] })}>
                  <option value="">{t('settings.agents.inherit')}</option>
                  <option value="readonly">readonly</option>
                  <option value="auto-edit">auto-edit</option>
                  <option value="full-auto">full-auto</option>
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
            <p style={{ fontSize: 12, color: 'var(--text-dim, #999)', margin: '0 0 12px' }}>{t('group.setup.hint')}</p>

            {/* 已有 Agent 多选 */}
            {agents.length > 0 && (
              <>
                <div style={{ fontSize: 12, fontWeight: 600, margin: '8px 0 6px', color: 'var(--text-dim, #999)' }}>{t('group.setup.savedAgents')}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
                  {agents.map((a) => {
                    const on = selectedSaved.includes(a.slug)
                    return (
                      <button key={a.slug} onClick={() => toggleSaved(a.slug)} style={{
                        display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left', padding: '8px 10px', borderRadius: 8,
                        border: `1px solid ${on ? 'var(--accent, #6b7cff)' : 'var(--border, rgba(127,127,127,0.25))'}`,
                        background: on ? 'var(--accent-soft, rgba(107,124,255,0.12))' : 'transparent', color: 'inherit', cursor: 'pointer',
                      }}>
                        <span style={{ width: 16, height: 16, borderRadius: 4, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: `1px solid ${on ? 'var(--accent, #6b7cff)' : 'var(--border, #888)'}`, background: on ? 'var(--accent, #6b7cff)' : 'transparent' }}>
                          {on && <Check size={12} color="#fff" />}
                        </span>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600 }}>{a.name}</div>
                          {a.description && <div style={{ fontSize: 11, color: 'var(--text-dim, #999)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.description}</div>}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </>
            )}

            {/* 临时 Agent(本会话用,不保存) */}
            <div style={{ fontSize: 12, fontWeight: 600, margin: '8px 0 6px', color: 'var(--text-dim, #999)' }}>{t('group.setup.tempAgents')}</div>
            {tempAgents.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
                {tempAgents.map((a) => (
                  <div key={a.slug} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--accent, #6b7cff)', background: 'var(--accent-soft, rgba(107,124,255,0.12))' }}>
                    <UserPlus size={14} style={{ flexShrink: 0, opacity: 0.8 }} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{a.name}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-dim, #999)', marginLeft: 6 }}>{t('group.setup.tempBadge')}</span>
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

            {/* 讨论强度 */}
            <div style={{ fontSize: 12, fontWeight: 600, margin: '4px 0 6px', color: 'var(--text-dim, #999)' }}>{t('group.setup.intensity')}</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
              {(['relaxed', 'medium', 'intense', 'custom'] as const).map((k) => {
                const on = intensity === k
                const label = k === 'custom' ? t('group.intensity.custom') : `${t(`group.intensity.${k}`)} · ${PRESET_ROUNDS[k]}${t('group.setup.roundsUnit')}`
                return (
                  <button key={k} onClick={() => setIntensity(k)} style={{
                    padding: '6px 12px', borderRadius: 16, fontSize: 12, cursor: 'pointer',
                    border: `1px solid ${on ? 'var(--accent, #6b7cff)' : 'var(--border, rgba(127,127,127,0.25))'}`,
                    background: on ? 'var(--accent, #6b7cff)' : 'transparent', color: on ? '#fff' : 'inherit',
                  }}>{label}</button>
                )
              })}
            </div>
            {intensity === 'custom' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, fontSize: 13 }}>
                <span>{t('group.setup.customRounds')}</span>
                <input type="number" min={1} max={30} value={customRounds} onChange={(e) => setCustomRounds(Number(e.target.value))}
                  style={{ width: 72, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border, #888)', background: 'var(--bg-input, #2a2a2a)', color: 'inherit' }} />
                <span style={{ color: 'var(--text-dim, #999)' }}>{t('group.setup.roundsRange')}</span>
              </div>
            )}

            <div style={{ fontSize: 12, color: 'var(--text-dim, #999)', margin: '6px 0 14px' }}>{t('group.setup.scaleHint', { rounds, agents: total })}</div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              {active && <button className="btn sm" onClick={() => { onDisable(); onClose() }}>{t('group.setup.disable')}</button>}
              <button className="btn primary sm" onClick={confirm} disabled={!canStart}>{active ? t('group.setup.update') : t('group.setup.start')}</button>
            </div>
            {!canStart && <div style={{ fontSize: 11, color: 'var(--danger, #e5534b)', textAlign: 'right', marginTop: 6 }}>{t('group.setup.needTwo')}</div>}
          </>
        )}
      </div>
    </div>
  )
}
