/**
 * 设置 → 智能体（Normal Agent）：本地自定义对话人格的 CRUD。
 * 仅本地后端可用（后端 /agent/agents 在云端 404 → listAgents 已降级空列表）。
 */
import React, { useEffect, useMemo, useState } from 'react'
import { Loader2, Plus, Trash2, Pencil, Bot, Star, GripVertical, BookOpen, User, Cloud, FolderOpen } from 'lucide-react'
import { listAgents, saveAgentDef, deleteAgentDef, listModels, uploadAgentAvatar, fetchAgentAvatar, deleteAgentAvatar, getAgentsMeta, putAgentsMeta, getUserProfile, putUserProfile } from '../services/backendService'
import { AgentMemoryModal } from './AgentMemoryModal'
import type { ModelInfo, NormalAgentDef, TanguDesktopConfig } from '../types'
import { useI18n } from '../i18n'
import { track } from '../achievements/store'

type Draft = {
  slug?: string
  name: string
  description: string
  model: string
  systemPrompt: string
  soul: string
  thinkingLevel: '' | 'off' | 'low' | 'medium' | 'high'
  maxIterations: string
  approvalMode: '' | 'readonly' | 'auto-edit' | 'full-auto'
  shareDefaultMemory: boolean
  cloudSync: boolean
}

const emptyDraft = (): Draft => ({
  name: '', description: '', model: '', systemPrompt: '', soul: '',
  thinkingLevel: '', maxIterations: '', approvalMode: '', shareDefaultMemory: false, cloudSync: false,
})

export const AgentsTab: React.FC<{ cfg: TanguDesktopConfig; onEditingChange?: (editing: boolean) => void }> = ({ cfg, onEditingChange }) => {
  const { t } = useI18n()
  const [agents, setAgents] = useState<NormalAgentDef[] | null>(null)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [editing, setEditing] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const [avatarBusy, setAvatarBusy] = useState(false)
  const [defaultSlug, setDefaultSlug] = useState('xyra')
  const [dragSlug, setDragSlug] = useState<string | null>(null)
  const [viewing, setViewing] = useState<NormalAgentDef | null>(null)
  const [userMd, setUserMd] = useState('')
  const [userMdBusy, setUserMdBusy] = useState(false)
  const [userMdOpen, setUserMdOpen] = useState(false)

  const load = (): void => {
    void listAgents(cfg).then(setAgents).catch(() => setAgents([]))
    void getAgentsMeta(cfg).then((m) => setDefaultSlug(m.defaultSlug || 'xyra')).catch(() => { /* ignore */ })
  }
  useEffect(() => {
    load()
    void listModels(cfg).then((r) => setModels(r.models)).catch(() => setModels([]))
    // USER.md:有内容直接载入;为空则用登录用户名/昵称预填模板。
    void getUserProfile(cfg).then(async (content) => {
      if (content.trim()) { setUserMd(content); return }
      let nick = ''
      try { const a = await window.tangu?.authStatus?.(); nick = a?.nickname || a?.username || '' } catch { /* ignore */ }
      setUserMd(`# 用户画像\n\n## 名字 / 称呼\n${nick}\n\n## 偏好\n- \n\n## 水平 / 背景\n\n## 长期需求 / 目标\n`)
    }).catch(() => { /* ignore */ })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => { onEditingChange?.(!!editing) }, [editing, onEditingChange])

  const startEdit = (a: NormalAgentDef): void => {
    setEditing({
      slug: a.slug, name: a.name, description: a.description, model: a.model,
      systemPrompt: a.systemPrompt, soul: a.soul || '', thinkingLevel: a.thinkingLevel,
      maxIterations: a.maxIterations != null ? String(a.maxIterations) : '', approvalMode: a.approvalMode,
      shareDefaultMemory: !!a.shareDefaultMemory, cloudSync: !!a.cloudSync,
    })
    setAvatarUrl(null)
    if (a.avatar) void fetchAgentAvatar(cfg, a.slug).then(setAvatarUrl).catch(() => {})
  }

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
        soul: editing.soul,
        thinkingLevel: editing.thinkingLevel || undefined,
        maxIterations: editing.maxIterations ? Number(editing.maxIterations) : null,
        approvalMode: editing.approvalMode || undefined,
        shareDefaultMemory: editing.shareDefaultMemory,
        cloudSync: editing.cloudSync,
      } as Partial<NormalAgentDef>, editing.slug)
      if (!editing.slug) track('agent.create')
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

  const onPickAvatar = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !editing?.slug) return
    if (file.size > 1_048_576) { setMsg(t('settings.agents.avatarTooLarge')); return }
    setAvatarBusy(true); setMsg('')
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(String(r.result))
        r.onerror = () => reject(new Error('read failed'))
        r.readAsDataURL(file)
      })
      await uploadAgentAvatar(cfg, editing.slug, dataUrl, file.type)
      setAvatarUrl(await fetchAgentAvatar(cfg, editing.slug))
      load()
    } catch (err: any) {
      setMsg(t('settings.agents.saveFail', { e: err?.message || err }))
    } finally {
      setAvatarBusy(false)
    }
  }

  const onRemoveAvatar = async (): Promise<void> => {
    if (!editing?.slug || !avatarUrl) return
    setAvatarBusy(true); setMsg('')
    try {
      await deleteAgentAvatar(cfg, editing.slug)
      setAvatarUrl(null)
      load()
    } catch (err: any) {
      setMsg(t('settings.agents.saveFail', { e: err?.message || err }))
    } finally {
      setAvatarBusy(false)
    }
  }

  const setDefault = (slug: string): void => {
    void putAgentsMeta(cfg, { defaultSlug: slug }).then((m) => setDefaultSlug(m.defaultSlug)).catch(() => { /* ignore */ })
  }
  /** 列表行快捷开关云同步:开启的 agent 全部文件跨设备完全镜像。 */
  const toggleCloudSync = (a: NormalAgentDef): void => {
    void saveAgentDef(cfg, { cloudSync: !a.cloudSync } as Partial<NormalAgentDef>, a.slug).then(() => load()).catch(() => { /* ignore */ })
  }
  const reorder = (from: string, to: string): void => {
    if (!agents || from === to) return
    const slugs = agents.map((a) => a.slug).filter((s) => s !== from)
    const ti = slugs.indexOf(to)
    if (ti < 0) return
    slugs.splice(ti, 0, from) // 拖到目标之前
    void putAgentsMeta(cfg, { order: slugs }).then(() => load()).catch(() => { /* ignore */ })
  }

  const saveUserMd = async (): Promise<void> => {
    setUserMdBusy(true)
    try { await putUserProfile(cfg, userMd) } finally { setUserMdBusy(false) }
  }

  const modelOptions = useMemo(() => models.map((m) => ({ id: m.id, label: m.name || m.id })), [models])

  if (editing) {
    return (
      <>
      <div className="field">
        {editing.slug ? (
          <div className="field">
            <label>{t('settings.agents.avatar')}</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {avatarUrl
                ? <img src={avatarUrl} alt="" style={{ width: 48, height: 48, borderRadius: '50%', objectFit: 'cover' }} />
                : <span style={{ width: 48, height: 48, borderRadius: '50%', background: 'var(--overlay-light)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, fontWeight: 600 }}>{(Array.from(editing.name.trim())[0] || '?').toUpperCase()}</span>}
              <label className="btn ghost sm" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {avatarBusy ? <Loader2 size={13} className="spin" /> : null}{t('settings.agents.avatarPick')}
                <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" style={{ display: 'none' }} onChange={(e) => void onPickAvatar(e)} />
              </label>
              {avatarUrl && (
                <button type="button" className="btn ghost sm" disabled={avatarBusy} onClick={() => void onRemoveAvatar()}>
                  {t('settings.agents.avatarRemove')}
                </button>
              )}
            </div>
            <div className="hint">{t('settings.agents.avatarHint')}</div>
          </div>
        ) : (
          <div className="hint" style={{ marginBottom: 8 }}>{t('settings.agents.avatarSaveFirst')}</div>
        )}
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
        <div className="field">
          <label>{t('settings.agents.soul')}</label>
          <textarea rows={5} value={editing.soul} placeholder={t('settings.agents.soulPlaceholder')}
            onChange={(e) => setEditing({ ...editing, soul: e.target.value })} />
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
        <div className="field">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}>
            <input type="checkbox" checked={editing.shareDefaultMemory}
              onChange={(e) => setEditing({ ...editing, shareDefaultMemory: e.target.checked })} />
            {t('settings.agents.shareMemory')}
          </label>
          <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 2 }}>{t('settings.agents.shareMemoryHint')}</div>
        </div>
        <div className="field">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}>
            <input type="checkbox" checked={editing.cloudSync}
              onChange={(e) => setEditing({ ...editing, cloudSync: e.target.checked })} />
            {t('settings.agents.cloudSync')}
          </label>
          <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 2 }}>{t('settings.agents.cloudSyncHint')}</div>
        </div>
        {editing.slug && (
          <div className="field">
            <label style={{ margin: 0 }}>{t('settings.agents.brainSection')}</label>
            <div style={{ fontSize: 11.5, color: 'var(--text-faint)', margin: '2px 0 6px' }}>{t('settings.agents.brainSectionHint')}</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn ghost sm" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                onClick={() => setViewing({ slug: editing.slug!, name: editing.name } as NormalAgentDef)}>
                <BookOpen size={13} /> {t('settings.agents.openBrain')}
              </button>
              {window.tangu?.openAgentDir && (
                <button className="btn ghost sm" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                  onClick={() => void window.tangu?.openAgentDir?.(editing.slug!)}>
                  <FolderOpen size={13} /> {t('settings.agents.openFolder')}
                </button>
              )}
            </div>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn primary sm" disabled={busy || !editing.name.trim() || !editing.systemPrompt.trim()} onClick={() => void save()}>
            {busy ? <Loader2 size={13} className="spin" /> : null} {t('common.save')}
          </button>
          <button className="btn ghost sm" onClick={() => setEditing(null)}>{t('common.cancel')}</button>
          {msg && <span style={{ fontSize: 12.5, color: 'var(--danger)' }}>{msg}</span>}
        </div>
      </div>
      {viewing && <AgentMemoryModal cfg={cfg} slug={viewing.slug} name={viewing.name} onClose={() => setViewing(null)} />}
      </>
    )
  }

  return (
    <div className="field">
      <div className="field" style={{ borderBottom: '1px solid var(--border)', paddingBottom: 10, marginBottom: 10 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }} onClick={() => setUserMdOpen((v) => !v)}>
          <User size={14} /> {t('settings.agents.userProfile')} <span style={{ color: 'var(--text-faint)' }}>{userMdOpen ? '▾' : '▸'}</span>
        </label>
        {userMdOpen && (
          <div style={{ marginTop: 6 }}>
            <div className="hint" style={{ marginBottom: 6 }}>{t('settings.agents.userProfileHint')}</div>
            <textarea rows={6} value={userMd} onChange={(e) => setUserMd(e.target.value)} />
            <button className="btn primary sm" style={{ marginTop: 6 }} disabled={userMdBusy} onClick={() => void saveUserMd()}>
              {userMdBusy ? <Loader2 size={13} className="spin" /> : null} {t('common.save')}
            </button>
          </div>
        )}
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Bot size={14} /> {t('settings.agents.title')}
      </label>
      <div className="hint" style={{ marginBottom: 8 }}>{t('settings.agents.hint')}</div>
      {agents === null && <div className="hint">{t('common.loading')}</div>}
      {agents?.length === 0 && <div className="hint">{t('settings.agents.empty')}</div>}
      {!!agents?.length && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
          {agents.map((a) => (
            <div key={a.slug} className="file-row" draggable
              onDragStart={() => setDragSlug(a.slug)}
              onDragEnd={() => setDragSlug(null)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => { if (dragSlug && dragSlug !== a.slug) reorder(dragSlug, a.slug); setDragSlug(null) }}
              style={{ cursor: 'grab', opacity: dragSlug === a.slug ? 0.45 : 1 }}>
              <GripVertical size={13} style={{ color: 'var(--text-faint)', flexShrink: 0 }} />
              <span className="file-name" style={{ flex: 1 }}>
                <b>{a.name}</b>
                {a.slug === defaultSlug && <span style={{ color: 'var(--accent)', marginLeft: 8, fontSize: 11 }}>· {t('settings.agents.isDefault')}</span>}
                {a.createdBy === 'agent' && <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: 11 }}>· {t('settings.agents.byAgent')}</span>}
                {a.createdBy === 'system' && <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: 11 }}>· {t('agent.badge.system')}</span>}
                {a.description && <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: 12 }}>{a.description.length > 60 ? `${a.description.slice(0, 60)}…` : a.description}</span>}
              </span>
              <button className="icon-btn" title={a.cloudSync ? t('settings.agents.cloudSyncOn') : t('settings.agents.cloudSyncOff')}
                onClick={() => toggleCloudSync(a)} style={a.cloudSync ? { color: 'var(--accent)' } : { opacity: 0.5 }}><Cloud size={13} /></button>
              {a.slug !== defaultSlug && <button className="icon-btn" title={t('settings.agents.setDefault')} onClick={() => setDefault(a.slug)}><Star size={13} /></button>}
              <button className="icon-btn" title={t('settings.agents.viewMem')} onClick={() => setViewing(a)}><BookOpen size={13} /></button>
              <button className="icon-btn" title={t('common.edit')} onClick={() => startEdit(a)}><Pencil size={13} /></button>
              <button className="icon-btn" title={t('common.delete')} onClick={() => void remove(a)}><Trash2 size={13} /></button>
            </div>
          ))}
        </div>
      )}
      <button className="btn ghost sm" onClick={() => { setMsg(''); setEditing({ ...emptyDraft(), systemPrompt: t('settings.agents.starterTemplate') }) }}>
        <Plus size={13} /> {t('settings.agents.new')}
      </button>
      {viewing && <AgentMemoryModal cfg={cfg} slug={viewing.slug} name={viewing.name} onClose={() => setViewing(null)} />}
    </div>
  )
}
