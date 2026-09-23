import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ExtendViewController, ExtendViewHandle } from '@lcl/engine/extendView'
import { Check, ChevronDown, ChevronRight, ExternalLink, FolderInput, Loader2, Plus, Search, Trash2, X } from 'lucide-react'
import { CapabilityMenu } from '../components/CapabilityMenu'
import { translate, useI18n } from '../i18n'
import { useApp } from '../stores/appStore'
import {
  copySkillCatalogEntry, createSkillCatalogEntry, deleteSkillCatalogEntry, getSkillCatalogEntry,
  importSkillCatalogEntry, listSkillCatalog, listSkills, setSkillCatalogEntryDisabled, updateSkillCatalogEntry,
} from '../services/backendService'
import type { SkillCatalogEntry, SkillInfo, TanguDesktopConfig } from '../types'

type Props = {
  cfg: TanguDesktopConfig
  agentSlug: string
  surface: 'space' | 'details'
  selectedIds?: string[]
  onSelectedIds: (ids: string[] | undefined) => void
  /** Host's temporary View: Main View → beside it, side panel → covering it with Back. Absent → the detail expands in place. */
  extendView?: ExtendViewController
}
type SkillEditorDraft = { detailKey: string | null; editing: boolean; createOpen: boolean; copyOpen: boolean; copySlug: string; slug: string; name: string; description: string; content: string }
const skillEditorDrafts = new Map<string, SkillEditorDraft>()
export function moveAgentSkillsDraft(oldSlug: string, newSlug: string): void {
  for (const surface of ['space', 'details'] as const) {
    const oldKey = `${surface}:${oldSlug}`
    const draft = skillEditorDrafts.get(oldKey)
    if (draft) { skillEditorDrafts.set(`${surface}:${newSlug}`, draft); skillEditorDrafts.delete(oldKey) }
  }
}

/** Shared by the full Agent Space profile and the compact Tangu details profile. */
export function AgentSkillsPanel({ cfg, agentSlug, surface, selectedIds, onSelectedIds, extendView }: Props) {
  const { t } = useI18n()
  const cacheKey = `${surface}:${agentSlug}`
  const cached = skillEditorDrafts.get(cacheKey)
  const managedDesktop = useApp((s) => s.desktopConfig?.mode === 'managed')
  const canImportLocalFolder = managedDesktop && !!window.tangu?.pickDirectory
  const [catalog, setCatalog] = useState<SkillCatalogEntry[]>([])
  const [legacy, setLegacy] = useState<SkillInfo[] | null>(null)
  const [availableSkills, setAvailableSkills] = useState<SkillInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busyKey, setBusyKey] = useState('')
  const [version, setVersion] = useState(0)
  const [query, setQuery] = useState('')
  const [detailKey, setDetailKey] = useState<string | null>(cached?.detailKey || null)
  const [detail, setDetail] = useState<SkillCatalogEntry | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [editing, setEditing] = useState(cached?.editing || false)
  const [copyOpen, setCopyOpen] = useState(cached?.copyOpen || false)
  const [copySlug, setCopySlug] = useState(cached?.copySlug || '')
  const detailRef = useRef<HTMLDivElement>(null)
  const focusedDetailKey = useRef<string | null>(null)
  const [createOpen, setCreateOpen] = useState(cached?.createOpen || false)
  const [slug, setSlug] = useState(cached?.slug || '')
  const [name, setName] = useState(cached?.name || '')
  const [description, setDescription] = useState(cached?.description || '')
  const [content, setContent] = useState(cached?.content || '')
  const detailKeyRef = useRef(detailKey)
  detailKeyRef.current = detailKey
  const editingRef = useRef(editing)
  editingRef.current = editing
  const extendHandle = useRef<ExtendViewHandle | null>(null)
  const [reopen, setReopen] = useState(0)
  const detailSlot = useMemo(() => Object.assign(document.createElement('div'), { className: 'agent-skill-extend' }), [])
  const mode = selectedIds == null ? 'auto' : selectedIds.length ? 'selected' : 'off'
  useEffect(() => {
    skillEditorDrafts.set(cacheKey, { detailKey, editing, createOpen, copyOpen, copySlug, slug, name, description, content })
  }, [cacheKey, detailKey, editing, createOpen, copyOpen, copySlug, slug, name, description, content])

  useEffect(() => {
    let active = true
    setLoading(true); setError('')
    const legacyRequest = listSkills(cfg, agentSlug)
    void legacyRequest.then((skills) => { if (active) setAvailableSkills(skills) }).catch(() => { if (active) setAvailableSkills([]) })
    void listSkillCatalog(cfg, agentSlug).then((skills) => { if (active) { setCatalog(Array.isArray(skills) ? skills : []); setLegacy(null) } })
      .catch(async (e) => {
        if (!active) return
        if (e?.status === 404) {
          try { const skills = await legacyRequest; if (active) { setLegacy(skills); setError('') } }
          catch { if (active) setError(t('agentProfile.skillCatalogUnavailable')) }
        } else setError(String(e?.message || e))
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [cfg, agentSlug, version, t])
  useEffect(() => {
    const refresh = () => setVersion((v) => v + 1)
    window.addEventListener('forsion:skills-changed', refresh)
    return () => window.removeEventListener('forsion:skills-changed', refresh)
  }, [])
  useEffect(() => {
    if (!detailKey) { setDetail(null); return }
    let active = true
    setDetailLoading(true)
    void getSkillCatalogEntry(cfg, detailKey, agentSlug).then((entry) => {
      if (!active) return
      setDetail(entry)
      if (!editing && !createOpen) { setName(entry.name); setDescription(entry.description); setContent(entry.content || '') }
    }).catch((e) => {
      if (!active) return
      if (e?.status === 404) {
        setDetail(null)
        if (editing) setError(t('agentProfile.skillEditConflict'))
        else { setDetailKey(null); setNotice(t('agentProfile.skillRemovedElsewhere')) }
      } else {
        setError(String(e?.message || e))
        if (!editing) setDetail(null)
      }
    })
      .finally(() => { if (active) setDetailLoading(false) })
    return () => { active = false }
  }, [cfg, detailKey, agentSlug, version]) // editing drafts deliberately survive another view's refresh event
  useEffect(() => {
    if (!detailKey) { focusedDetailKey.current = null; return }
    if (detailLoading || editing) return
    detailRef.current?.scrollIntoView({ block: 'nearest' })
    if (focusedDetailKey.current !== detailKey) { detailRef.current?.focus(); focusedDetailKey.current = detailKey }
  }, [detailKey, detailLoading, editing])
  // With a host temporary View the detail opens there. A new key swaps in place; onClose clears only the key it
  // opened, so the 'replace' fired while swapping never wipes the key that replaced it.
  useEffect(() => {
    if (!extendView) return
    if (!detailKey) { extendHandle.current?.close(); extendHandle.current = null; return }
    const key = detailKey
    try {
      extendHandle.current = extendView.open({
        id: `agent-skill:${cacheKey}:${key}`,
        title: () => translate('agentProfile.skillDetail'),
        mount: (el) => { el.appendChild(detailSlot); return () => { if (detailSlot.parentElement === el) detailSlot.remove() } },
        onClose: (reason) => {
          if (detailKeyRef.current !== key) return
          if (reason === 'owner' && editingRef.current) return // owner hid mid-edit: keep the draft, the row reopens it
          setDetailKey(null); setEditing(false); setCopyOpen(false)
        },
      })
    } catch { setDetailKey(null) } // owner hidden or gone: nowhere to show it
  }, [extendView, detailKey, cacheKey, detailSlot, reopen])
  useEffect(() => () => {
    if (!extendView) return
    extendHandle.current?.close()
    // A closed temporary View stays closed on the next mount; only an unsaved edit comes back with its detail.
    const draft = skillEditorDrafts.get(cacheKey)
    if (draft && !draft.editing) skillEditorDrafts.set(cacheKey, { ...draft, detailKey: null, copyOpen: false })
  }, [extendView, cacheKey])

  const emitChange = () => {
    window.dispatchEvent(new Event('forsion:skills-changed'))
    window.tangu?.requestMainAction?.('skills-changed')
  }
  const mutate = async (key: string, action: () => Promise<unknown>, success?: string, onError?: () => void) => {
    setBusyKey(key); setError(''); setNotice('')
    try { await action(); if (success) setNotice(success); emitChange() }
    catch (e: any) { onError?.(); setError(String(e?.message || e)) }
    finally { setBusyKey('') }
  }

  const visible = useMemo(() => {
    const q = query.trim().toLocaleLowerCase()
    return q ? catalog.filter((entry) => `${entry.name} ${entry.description} ${entry.slug}`.toLocaleLowerCase().includes(q)) : catalog
  }, [catalog, query])
  const own = visible.filter((entry) => entry.scope === 'agent' && entry.owner === agentSlug)
  const global = visible.filter((entry) => entry.scope === 'user')
  const catalogIds = useMemo(() => new Set(catalog.map((entry) => entry.id)), [catalog])
  const extras = availableSkills.filter((entry) => !catalogIds.has(entry.id))
  const missingIds = (selectedIds || []).filter((id) => !catalogIds.has(id) && !availableSkills.some((entry) => entry.id === id))
  const q = query.trim().toLocaleLowerCase()
  const extraVisible = extras.filter((entry) => !q || `${entry.name} ${entry.description} ${entry.id}`.toLocaleLowerCase().includes(q))
  const missingVisible = missingIds.filter((id) => !q || id.toLocaleLowerCase().includes(q))
  const currentlyAvailable = (entry: SkillCatalogEntry) => entry.availability === 'available' && !entry.disabled && !entry.disabledForAgent
  const legacyDirectory = (entry: SkillCatalogEntry) => entry.compatibility === 'legacy-slug'
  const checked = (entry: SkillCatalogEntry) => mode === 'auto' ? currentlyAvailable(entry)
    : mode === 'selected' && currentlyAvailable(entry) && !!selectedIds?.includes(entry.id)
  const switchMode = (next: string) => {
    if (next === 'auto') onSelectedIds(undefined)
    else if (next === 'off') onSelectedIds([])
    else if (mode !== 'selected') onSelectedIds([...new Set([...catalog.filter(currentlyAvailable).map((entry) => entry.id), ...extras.filter((entry) => entry.id.startsWith('local:')).map((entry) => entry.id), ...(selectedIds || [])])])
  }
  const toggleExtra = (id: string, enabled: boolean) => {
    const all = selectedIds || [...new Set([...catalog.filter(currentlyAvailable).map((entry) => entry.id), ...extras.filter((entry) => entry.id.startsWith('local:')).map((entry) => entry.id)])]
    onSelectedIds(enabled ? [...new Set([...all, id])] : all.filter((entry) => entry !== id))
  }
  const toggle = (entry: SkillCatalogEntry, enabled: boolean) => {
    if (mode === 'off' || legacyDirectory(entry) || entry.availability === 'shadowed' || (entry.scope === 'user' && entry.disabled)) return
    if (mode === 'selected') {
      if (enabled && (entry.disabledForAgent || entry.disabled)) {
        void mutate(entry.key, async () => {
          await setSkillCatalogEntryDisabled(cfg, entry.key, false, agentSlug)
          onSelectedIds([...new Set([...(selectedIds || []), entry.id])])
        })
      } else onSelectedIds(enabled ? [...new Set([...(selectedIds || []), entry.id])] : (selectedIds || []).filter((id) => id !== entry.id))
      return
    }
    const previous = catalog
    setCatalog((current) => current.map((item) => item.key === entry.key ? {
      ...item,
      ...(item.scope === 'user' ? { disabledForAgent: !enabled } : { disabled: !enabled }),
      availability: enabled ? 'available' : 'disabled',
    } : item))
    void mutate(entry.key, () => setSkillCatalogEntryDisabled(cfg, entry.key, !enabled, agentSlug),
      t(enabled ? 'agentProfile.skillEnabled' : 'agentProfile.skillDisabled'), () => setCatalog(previous))
  }
  const status = (entry: SkillCatalogEntry) => {
    if (legacyDirectory(entry)) return t('agentProfile.skillLegacyDirectory')
    if (entry.availability === 'shadowed') return t('agentProfile.skillShadowed')
    if (entry.scope === 'user' && entry.disabled) return t('agentProfile.skillGlobalOff')
    if (entry.disabledForAgent || entry.disabled) return t('agentProfile.skillAgentOff')
    if (mode === 'off') return t('agentProfile.skillPolicyOff')
    if (mode === 'selected' && !selectedIds?.includes(entry.id)) return t('agentProfile.skillNotSelected')
    return t('agentProfile.skillAvailable')
  }
  const row = (entry: SkillCatalogEntry) => <div key={entry.key} className="agent-skill-entry">
    <div className={`agent-skill-row${checked(entry) ? ' enabled' : ''}${extendView && detailKey === entry.key ? ' current' : ''}`} data-skill-key={entry.key}>
    <label title={status(entry)}><input type="checkbox" checked={checked(entry)} disabled={!!busyKey || mode === 'off' || legacyDirectory(entry) || entry.availability === 'shadowed' || (entry.scope === 'user' && entry.disabled)} onChange={(event) => toggle(entry, event.target.checked)} aria-label={t('agentProfile.skillForAgent', { name: entry.name })} /></label>
    <button type="button" className="agent-skill-summary" onClick={() => {
      if (extendView && detailKey === entry.key && !extendHandle.current?.isOpen) { setReopen((n) => n + 1); return } // draft kept after the owner hid
      setCreateOpen(false); setEditing(false); setCopyOpen(false); setNotice(''); setError(''); setDetailKey(detailKey === entry.key ? null : entry.key)
    }} aria-expanded={extendView ? undefined : detailKey === entry.key} aria-current={extendView && detailKey === entry.key ? true : undefined}>
      <strong>{entry.name}</strong><span>{entry.description || entry.slug}</span><small>{status(entry)}{entry.readOnly ? ` · ${t('agentProfile.skillReadOnly')}` : ''}</small>
    </button>
    <ChevronRight size={14} className={!extendView && detailKey === entry.key ? 'open' : ''} aria-hidden="true" />
    </div>
    {!extendView && detailKey === entry.key && detailView()}
  </div>
  const create = async () => {
    if (!slug.trim() || !name.trim() || !content.trim()) return
    await mutate('create', async () => {
      const entry = await createSkillCatalogEntry(cfg, { scope: 'agent', agentSlug, slug: slug.trim(), name: name.trim(), description: description.trim(), content: content.trim() })
      setCreateOpen(false); setSlug(''); setName(''); setDescription(''); setContent(''); setDetailKey(entry.key)
    }, t('agentProfile.skillCreated'))
  }
  const importFolder = async () => {
    if (!canImportLocalFolder) return
    const sourcePath = await window.tangu?.pickDirectory?.()
    if (!sourcePath) return
    await mutate('import', () => importSkillCatalogEntry(cfg, { scope: 'agent', agentSlug, sourcePath }), t('agentProfile.skillImported'))
  }
  const saveDetail = async () => {
    if (!detail || !name.trim() || !content.trim()) return
    await mutate(detail.key, async () => {
      const latest = await getSkillCatalogEntry(cfg, detail.key, agentSlug)
      const changedElsewhere = (['name', 'description', 'content'] as const).some((key) => latest[key] !== detail[key] && latest[key] !== ({ name, description, content })[key])
      if (changedElsewhere) throw new Error(t('agentProfile.skillEditConflict'))
      const updated = await updateSkillCatalogEntry(cfg, detail.key, { name: name.trim(), description: description.trim(), content: content.trim(), agentSlug })
      setDetail(updated); setEditing(false)
    }, t('agentProfile.skillSaved'))
  }
  const deleteDetail = async () => {
    if (!detail || !window.confirm(t('agentProfile.skillDeleteConfirm', { name: detail.name }))) return
    await mutate(detail.key, async () => {
      const result = await deleteSkillCatalogEntry(cfg, detail.key, agentSlug) as { ok: boolean; backupPath?: string }
      if (!result.ok) throw new Error(t('agentProfile.skillDeleteFailed'))
      setNotice(result.backupPath ? t('agentProfile.skillDeletedBackup', { path: result.backupPath }) : t('agentProfile.skillDeleted'))
      setDetailKey(null); setDetail(null); setEditing(false)
    })
  }
  const copyGlobal = async (entry: SkillCatalogEntry) => {
    if (!copySlug.trim()) return
    await mutate(entry.key, async () => {
      const copied = await copySkillCatalogEntry(cfg, entry.key, { scope: 'agent', agentSlug, slug: copySlug.trim() }, entry.scope === 'agent' ? agentSlug : undefined)
      setCopyOpen(false); setDetailKey(copied.key)
    }, t('agentProfile.skillCopied'))
  }

  const messages = <>
    {error && <p className="agent-profile-error" role="alert">{error} <button className="profile-text-action" onClick={() => setVersion((v) => v + 1)}>{t('agentProfile.retry')}</button></p>}
    {notice && <p className="profile-save-notice" role="status"><Check size={13} />{notice}</p>}
  </>
  // The list is hidden or out of the way while the temporary View is open, so action results show next to the detail.
  // Opening a row clears the previous result first, or an old "disabled" notice would read as this skill's state.
  const messagesInDetail = !!extendView && !!detailKey && !!extendHandle.current?.isOpen
  const detailView = () => <div ref={detailRef} className="agent-skill-detail" data-skill-detail={detailKey} tabIndex={-1}>
      {detailLoading && <p className="agent-profile-muted"><Loader2 size={14} className="spin" /> {t('agentProfile.loading')}</p>}
      {detail && detail.key === detailKey && !detailLoading && <>
        <div className="agent-skill-detail-head"><strong>{detail.name}</strong>{!extendView && <button type="button" className="profile-text-action" onClick={() => { setDetailKey(null); setEditing(false) }} aria-label={t('common.close')}><X size={15} /></button>}</div>
        {messagesInDetail && messages}
        {legacyDirectory(detail) && <p className="agent-skills-policy-hint">{t('agentProfile.skillLegacyDirectory')}</p>}
        {/* Esc would dismiss the temporary View and drop this draft; Cancel and Back are the deliberate exits. */}
        {editing ? <form className="agent-skill-editor" onKeyDown={(e) => { if (e.key === 'Escape') e.preventDefault() }} onSubmit={(e) => { e.preventDefault(); void saveDetail() }}>
          <label>{t('agentProfile.name')}<input required value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label>{t('agentProfile.description')}<input value={description} onChange={(e) => setDescription(e.target.value)} /></label>
          <label>{t('agentProfile.skillInstructions')}<textarea required rows={12} value={content} onChange={(e) => setContent(e.target.value)} /></label>
          <div><button type="button" className="btn ghost sm" onClick={() => { setEditing(false); setName(detail.name); setDescription(detail.description); setContent(detail.content || '') }}>{t('agentProfile.cancel')}</button><button type="submit" className="btn primary sm" disabled={!!busyKey || !name.trim() || !content.trim()}>{t('common.save')}</button></div>
        </form> : <><p>{detail.description}</p><small>{detail.path}</small><pre>{detail.content || t('agentProfile.emptyText')}</pre>
          {!!detail.files?.length && <details><summary>{t('agentProfile.skillFiles', { count: detail.files.length })}</summary><ul>{detail.files.map((file) => <li key={file.path}>{file.path}</li>)}</ul></details>}
          <div className="agent-skill-detail-actions">{detail.scope === 'agent' && !detail.readOnly && <><button className="btn ghost sm" onClick={() => setEditing(true)}>{t('agentProfile.edit')}</button><button className="btn ghost sm danger" disabled={!!busyKey} onClick={() => void deleteDetail()}><Trash2 size={13} />{t('agentProfile.skillDelete')}</button></>}
            {(detail.scope === 'user' || legacyDirectory(detail)) && <button className="btn ghost sm" disabled={!!busyKey} onClick={() => { const validSlug = /^[a-z0-9][a-z0-9-]*$/.test(detail.slug) ? detail.slug : detail.slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'skill'; setCopySlug(catalog.some((entry) => entry.scope === 'agent' && entry.slug === validSlug) ? `${validSlug}-copy` : validSlug); setCopyOpen(!copyOpen) }}>{t('agentProfile.copyToAgent')}</button>}
            {detail.scope === 'user' && <button className="btn ghost sm" onClick={() => useApp.getState().openSettings('skills', detail.key)}>{t('agentProfile.editGlobalSkill')}<ExternalLink size={13} /></button>}
          </div>
          {(detail.scope === 'user' || legacyDirectory(detail)) && copyOpen && <form className="agent-skill-editor" onSubmit={(e) => { e.preventDefault(); void copyGlobal(detail) }}>
            <p className="agent-skills-policy-hint">{t('agentProfile.copySkillHint')}</p>
            <label>{t('agentProfile.skillFolder')}<input required pattern="[a-z0-9][a-z0-9-]*" value={copySlug} onChange={(e) => setCopySlug(e.target.value)} /></label>
            <div><button type="button" className="btn ghost sm" onClick={() => setCopyOpen(false)}>{t('agentProfile.cancel')}</button><button type="submit" className="btn primary sm" disabled={!!busyKey || !copySlug.trim()}>{t('agentProfile.copyToAgent')}</button></div>
          </form>}
        </>}
      </>}
    </div>

  if (legacy) {
    const q = query.trim().toLocaleLowerCase()
    const shown = legacy.filter((entry) => !q || `${entry.name} ${entry.description}`.toLocaleLowerCase().includes(q))
    return <section className="agent-skills-panel" aria-label={t('agentProfile.skills')}>
      <div className="profile-list-controls"><label className="profile-search"><Search size={14} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('agentProfile.searchEquipment')} aria-label={t('agentProfile.searchEquipment')} /></label>
        <CapabilityMenu label={t('agentProfile.skillPolicy')} selection items={([
        ['auto', 'agentProfile.skillAuto'], ['selected', 'agentProfile.skillSelected'], ['off', 'agentProfile.skillOff'],
      ] as const).map(([id, key]) => ({ id, label: t(key), selected: mode === id, onSelect: () => switchMode(id) }))}>
        <span>{t(mode === 'auto' ? 'agentProfile.skillAuto' : mode === 'selected' ? 'agentProfile.skillSelected' : 'agentProfile.skillOff')}</span><ChevronDown size={13} />
      </CapabilityMenu>
      </div>
      <p className="agent-skills-policy-hint">{t('agentProfile.skillLegacyHint')}</p>
      <div className="agent-skill-list">{shown.map((entry) => <div key={entry.id} className="agent-skill-row"><label><input type="checkbox" aria-label={t('agentProfile.skillForAgent', { name: entry.name })} checked={mode === 'auto' ? entry.id.startsWith('local:') : mode === 'selected' && !!selectedIds?.includes(entry.id)} disabled={mode === 'off'} onChange={(event) => {
          const all = mode === 'auto' ? legacy.filter((skill) => skill.id.startsWith('local:')).map((skill) => skill.id) : selectedIds || []
          onSelectedIds(event.target.checked ? [...new Set([...all, entry.id])] : all.filter((id) => id !== entry.id))
        }} /></label><span className="agent-skill-summary"><strong>{entry.name}</strong><span>{entry.description}</span></span></div>)}</div>
      {!shown.length && <p className="agent-profile-muted">{t('agentProfile.noResults')}</p>}
      <button className="agent-profile-link" onClick={() => useApp.getState().openSettings('skills')}>{t('agentProfile.manageSkills')}<ExternalLink size={13} /></button>
    </section>
  }

  return <section className="agent-skills-panel" aria-label={t('agentProfile.skills')}>
    <div className="profile-list-toolbar"><div className="profile-list-controls">
      <label className="profile-search"><Search size={14} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('agentProfile.searchEquipment')} aria-label={t('agentProfile.searchEquipment')} /></label>
        <CapabilityMenu label={t('agentProfile.skillPolicy')} selection items={([
        ['auto', 'agentProfile.skillAuto'], ['selected', 'agentProfile.skillSelected'], ['off', 'agentProfile.skillOff'],
      ] as const).map(([id, key]) => ({ id, label: t(key), selected: mode === id, onSelect: () => switchMode(id) }))}>
        <span>{t(mode === 'auto' ? 'agentProfile.skillAuto' : mode === 'selected' ? 'agentProfile.skillSelected' : 'agentProfile.skillOff')}</span><ChevronDown size={13} />
      </CapabilityMenu>
    </div><p className="agent-skills-policy-hint">{t(`agentProfile.skillPolicy.${mode}`)}</p></div>
    {loading && <p className="agent-profile-muted" role="status"><Loader2 size={14} className="spin" /> {t('agentProfile.loading')}</p>}
    {!messagesInDetail && messages}
    <div className="agent-skill-section-head"><div><h3>{t('agentProfile.agentSkills')}</h3><p>{t('agentProfile.agentSkillsHint')}</p></div><button type="button" className="btn ghost sm" onClick={() => { setDetailKey(null); setCreateOpen(!createOpen); setSlug(''); setName(''); setDescription(''); setContent('') }}><Plus size={13} />{t('agentProfile.addSkill')}</button></div>
    {createOpen && <form className="agent-skill-editor" onSubmit={(e) => { e.preventDefault(); void create() }}>
      <label>{t('agentProfile.skillFolder')}<input required pattern="[a-z0-9][a-z0-9-]*" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="my-skill" /></label>
      <label>{t('agentProfile.name')}<input required value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label>{t('agentProfile.description')}<input value={description} onChange={(e) => setDescription(e.target.value)} /></label>
      <label>{t('agentProfile.skillInstructions')}<textarea required rows={8} value={content} onChange={(e) => setContent(e.target.value)} /></label>
      <div><button type="button" className="btn ghost sm" onClick={() => setCreateOpen(false)}><X size={13} />{t('agentProfile.cancel')}</button><button type="submit" className="btn primary sm" disabled={!!busyKey || !slug.trim() || !name.trim() || !content.trim()}>{busyKey === 'create' && <Loader2 size={13} className="spin" />}{t('agentProfile.addSkill')}</button></div>
    </form>}
    {own.length > 0 ? <div className="agent-skill-list">{own.map(row)}</div> : !loading && !error && <p className="agent-profile-muted">{t(query ? 'agentProfile.noResults' : 'agentProfile.noAgentSkills')}</p>}
    {canImportLocalFolder && <button type="button" className="agent-profile-link" disabled={!!busyKey} onClick={() => void importFolder()}><FolderInput size={14} />{t('agentProfile.importAgentSkill')}</button>}
    <div className="agent-skill-section-head"><div><h3>{t('agentProfile.inheritedSkills')}</h3><p>{t('agentProfile.inheritedSkillsHint')}</p></div></div>
    {global.length > 0 ? <div className="agent-skill-list">{global.map(row)}</div> : !loading && !error && <p className="agent-profile-muted">{t(query ? 'agentProfile.noResults' : 'agentProfile.noGlobalSkills')}</p>}
    {!loading && (extraVisible.length > 0 || missingVisible.length > 0) && <>
      <div className="agent-skill-section-head"><div><h3>{t('agentProfile.otherSkills')}</h3><p>{t('agentProfile.otherSkillsHint')}</p></div></div>
      <div className="agent-skill-list">{extraVisible.map((entry) => {
        const autoLocal = entry.id.startsWith('local:')
        const enabled = mode === 'selected' ? !!selectedIds?.includes(entry.id) : mode === 'auto' && autoLocal
        return <div key={entry.id} className={`agent-skill-row${enabled ? ' enabled' : ''}`} data-skill-id={entry.id}>
          <label><input type="checkbox" checked={enabled} disabled={mode === 'off'} onChange={(e) => toggleExtra(entry.id, e.target.checked)} aria-label={t('agentProfile.skillForAgent', { name: entry.name })} /></label>
          <span className="agent-skill-summary"><strong>{entry.name}</strong><span>{entry.description || entry.id}</span><small>{entry.id.startsWith('local:@') ? t('agentProfile.sharedAgentSkill') : autoLocal ? t('agentProfile.localExtraSkill') : t('agentProfile.cloudExtraSkill')} · {mode === 'auto' && !autoLocal ? t('agentProfile.extraChoose') : enabled ? t('agentProfile.skillAvailable') : t('agentProfile.skillNotSelected')}</small></span>
        </div>
      })}{missingVisible.map((id) => <div key={id} className="agent-skill-row" data-skill-id={id}>
        <label><input type="checkbox" checked disabled={mode !== 'selected'} onChange={() => toggleExtra(id, false)} aria-label={t('agentProfile.skillForAgent', { name: id })} /></label>
        <span className="agent-skill-summary"><strong>{id}</strong><small>{t('agentProfile.skillUnavailableKept')}</small></span>
      </div>)}</div>
    </>}
    {extendView && detailKey && createPortal(detailView(), detailSlot)}
  </section>
}
