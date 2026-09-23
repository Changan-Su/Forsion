import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, Check, ChevronDown, ChevronRight, Copy, FileText, FolderInput, FolderOpen, Loader2, MoreHorizontal, Plus, RefreshCw, Search, Sparkles, Trash2, UploadCloud } from 'lucide-react'
import {
  copySkillCatalogEntry, createSkillCatalogEntry, deleteSkillCatalogEntry, deleteUserCloudSkill,
  getSkillCatalogEntry, importSkillCatalogEntry, listAgents, listSkillCatalog, listSkills,
  setSkillCatalogEntryDisabled, updateSkillCatalogEntry, uploadSkillToCloud,
} from '../services/backendService'
import type { NormalAgentDef, SkillCatalogEntry, SkillInfo, TanguDesktopConfig } from '../types'
import { registerMessages, useI18n } from '../i18n'
import { CapabilityMenu } from './CapabilityMenu'
import './globalSkillsLibrary.css'

registerMessages({
  'globalSkills.title': { zh: '全局技能', en: 'Global skills' },
  'globalSkills.intro': { zh: '在这里维护所有 Agent 可发现的技能。每个 Agent 的使用规则在它自己的档案中调整。', en: 'Manage skills available to every agent. Adjust each agent’s use of them in its own profile.' },
  'globalSkills.search': { zh: '搜索技能名称或用途', en: 'Search skills by name or purpose' },
  'globalSkills.source': { zh: '来源', en: 'Source' },
  'globalSkills.more': { zh: '更多操作', en: 'More actions' },
  'globalSkills.allSources': { zh: '全部来源', en: 'All sources' },
  'globalSkills.mine': { zh: '我的技能', en: 'My skills' },
  'globalSkills.packaged': { zh: '随包提供', en: 'Included with Forsion' },
  'globalSkills.cloud': { zh: '我的云端正文副本', en: 'My cloud text copies' },
  'globalSkills.fromUser': { zh: '自建或导入', en: 'Created or imported' },
  'globalSkills.fromBuiltin': { zh: '内置', en: 'Built in' },
  'globalSkills.fromBundle': { zh: '插件包', en: 'Plugin bundle' },
  'globalSkills.add': { zh: '添加技能', en: 'Add skill' },
  'globalSkills.create': { zh: '新建技能', en: 'Create skill' },
  'globalSkills.import': { zh: '导入文件夹', en: 'Import folder' },
  'globalSkills.importCli': { zh: '从 Agent CLI 导入', en: 'Import from Agent CLI' },
  'globalSkills.browseMarket': { zh: '浏览市场', en: 'Browse marketplace' },
  'globalSkills.refresh': { zh: '刷新技能库', en: 'Refresh skill library' },
  'globalSkills.openFolder': { zh: '打开本机技能目录', en: 'Open host skills folder' },
  'globalSkills.remoteHost': { zh: '当前目录位于连接的后端。此设备的文件夹选择器不能访问它；可直接管理该后端已有的技能。', en: 'This library is on the connected backend. This device’s folder picker cannot access it; you can manage skills already on that backend.' },
  'globalSkills.localHost': { zh: '本机技能保存在当前后端的用户目录；具体路径以右侧详情为准。', en: 'Host skills live in the current backend’s user directory. See each skill’s details for its exact path.' },
  'globalSkills.empty': { zh: '这里还没有技能。', en: 'No skills here yet.' },
  'globalSkills.noResults': { zh: '没有匹配的技能。', en: 'No matching skills.' },
  'globalSkills.pick': { zh: '选择一项技能查看内容和管理选项。', en: 'Select a skill to see its contents and management options.' },
  'globalSkills.loading': { zh: '正在读取技能…', en: 'Loading skills…' },
  'globalSkills.unavailable': { zh: '当前后端尚不支持本机技能目录管理。云端副本仍可在下方查看。', en: 'This backend does not support host skill management yet. Cloud copies remain available below.' },
  'globalSkills.loadFailed': { zh: '读取技能库失败：{error}', en: 'Could not load skill library: {error}' },
  'globalSkills.actionFailed': { zh: '操作失败：{error}', en: 'Action failed: {error}' },
  'globalSkills.editConflict': { zh: '这项技能已在别处修改。草稿已保留，请先刷新详情再决定如何合并。', en: 'This skill changed elsewhere. Your draft is preserved; refresh its details before deciding how to merge.' },
  'globalSkills.saved': { zh: '技能已保存。', en: 'Skill saved.' },
  'globalSkills.imported': { zh: '技能文件夹已复制到全局目录。', en: 'Skill folder copied to the global library.' },
  'globalSkills.copied': { zh: '已复制到 {name}。', en: 'Copied to {name}.' },
  'globalSkills.deleted': { zh: '技能已移至备份目录：{path}', en: 'Skill moved to backup folder: {path}' },
  'globalSkills.deleteConfirm': { zh: '删除“{name}”及其目录中的所有文件？这会影响使用该全局技能的 Agent。', en: 'Delete “{name}” and every file in its folder? Agents using this global skill will be affected.' },
  'globalSkills.deleteCloudConfirm': { zh: '删除云端正文副本“{name}”？本机技能不受影响。', en: 'Delete cloud text copy “{name}”? The host skill will remain.' },
  'globalSkills.readOnly': { zh: '随包技能只读', en: 'Included skill · read only' },
  'globalSkills.legacyReadOnly': { zh: '旧目录名仍可使用；请复制为新技能后再编辑或停用。', en: 'This older folder name still works. Copy it as a new skill to edit or pause it.' },
  'globalSkills.available': { zh: '可用', en: 'Available' },
  'globalSkills.disabled': { zh: '已停用', en: 'Paused' },
  'globalSkills.shadowed': { zh: '被其他版本覆盖', en: 'Overridden by another copy' },
  'globalSkills.overriddenBy': { zh: '当前同名技能由“{source}”版本提供。', en: 'The “{source}” copy currently provides this skill.' },
  'globalSkills.edit': { zh: '编辑', en: 'Edit' },
  'globalSkills.pause': { zh: '停用', en: 'Pause' },
  'globalSkills.resume': { zh: '启用', en: 'Resume' },
  'globalSkills.delete': { zh: '删除技能', en: 'Delete skill' },
  'globalSkills.copyToAgent': { zh: '复制给 Agent', en: 'Copy to agent' },
  'globalSkills.copyToMine': { zh: '复制到我的技能', en: 'Copy to my skills' },
  'globalSkills.publish': { zh: '发布正文副本', en: 'Publish text copy' },
  'globalSkills.publishWarning': { zh: '只会发布 SKILL.md 的名称、说明与正文；{count} 个随附文件不会上传。云端执行可能因此缺少资源。继续发布？', en: 'Only the SKILL.md name, description and body will be published. {count} attached files will not upload, so the cloud copy may lack resources. Continue?' },
  'globalSkills.published': { zh: '云端正文副本已发布；后续本机修改不会自动更新它。', en: 'Cloud text copy published. Later host edits will not update it automatically.' },
  'globalSkills.cloudExplanation': { zh: '这里是独立的正文副本，不包含 scripts、references 等随附文件，也不会随本机技能自动更新。', en: 'These are separate text copies. They exclude attached files such as scripts and references and do not update with host edits.' },
  'globalSkills.cloudPreview': { zh: '云端接口只提供名称与用途摘要，无法在这里读取完整正文。', en: 'The cloud API only provides the name and purpose summary, so the full body cannot be previewed here.' },
  'globalSkills.path': { zh: '实际路径', en: 'Actual path' },
  'globalSkills.content': { zh: '技能正文', en: 'Skill body' },
  'globalSkills.files': { zh: '随附文件', en: 'Files in folder' },
  'globalSkills.noContent': { zh: '没有正文。', en: 'No body content.' },
  'globalSkills.selectFolder': { zh: '选择技能文件夹', en: 'Choose skill folder' },
  'globalSkills.importHint': { zh: '选择包含 SKILL.md 的文件夹。导入会复制完整目录，原文件保持不变；同名不会覆盖。', en: 'Choose a folder containing SKILL.md. Import copies the full folder and leaves the source untouched; an existing name will not be overwritten.' },
  'globalSkills.sourceFolder': { zh: '源文件夹', en: 'Source folder' },
  'globalSkills.slugOverride': { zh: '目录名（可选）', en: 'Folder name (optional)' },
  'globalSkills.slugHint': { zh: '遇到同名时填一个新目录名再试。', en: 'If the name already exists, enter a different folder name and try again.' },
  'globalSkills.importAction': { zh: '复制到全局技能库', en: 'Copy to global library' },
  'globalSkills.name': { zh: '名称', en: 'Name' },
  'globalSkills.description': { zh: '用途', en: 'Purpose' },
  'globalSkills.slug': { zh: '目录名', en: 'Folder name' },
  'globalSkills.body': { zh: 'SKILL.md 正文', en: 'SKILL.md body' },
  'globalSkills.bodyHint': { zh: '名称和用途会写入 frontmatter；这里只填写说明与步骤。', en: 'Name and purpose are saved in frontmatter. Write the instructions and steps here.' },
  'globalSkills.chooseAgent': { zh: '选择 Agent', en: 'Choose agent' },
  'globalSkills.noAgent': { zh: '还没有可复制到的 Agent。请先在 Agent Space 创建。', en: 'No agent is available. Create one in Agent Space first.' },
  'globalSkills.cancel': { zh: '取消', en: 'Cancel' },
  'globalSkills.save': { zh: '保存', en: 'Save' },
  'globalSkills.copyAction': { zh: '复制技能', en: 'Copy skill' },
  'globalSkills.cloudDeleted': { zh: '云端正文副本已删除。', en: 'Cloud text copy deleted.' },
})

type Editor =
  | { kind: 'create'; name: string; description: string; slug: string; slugEdited: boolean; content: string }
  | { kind: 'edit'; key: string; name: string; description: string; slug: string; content: string; baseline: { name: string; description: string; content: string } }
  | { kind: 'import'; sourcePath: string; slug: string }
  | { kind: 'copy'; key: string; target: 'user' | 'agent'; agentSlug: string; slug: string }

type Selected = { kind: 'catalog'; key: string } | { kind: 'cloud'; id: string }
type Filter = 'all' | 'user' | 'builtin' | 'bundle' | 'cloud'

function slugFromName(name: string, previous: string): string {
  const readable = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '')
  return readable || previous || `skill-${crypto.randomUUID().slice(0, 8)}`
}

function notifySkillsChanged(): void {
  window.dispatchEvent(new Event('forsion:skills-changed'))
  window.tangu?.requestMainAction?.('skills-changed')
}

export function GlobalSkillsLibrary({ cfg, localHost, initialSkillKey, onImportCli, onBrowseMarket }: {
  cfg: TanguDesktopConfig
  localHost: boolean
  initialSkillKey?: string
  onImportCli?: () => void
  onBrowseMarket: () => void
}) {
  const { t } = useI18n()
  const [catalog, setCatalog] = useState<SkillCatalogEntry[] | null>(null)
  const [cloud, setCloud] = useState<SkillInfo[]>([])
  const [catalogError, setCatalogError] = useState('')
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [packagedOpen, setPackagedOpen] = useState(false)
  const [selected, setSelected] = useState<Selected | null>(initialSkillKey ? { kind: 'catalog', key: initialSkillKey } : null)
  const [detail, setDetail] = useState<SkillCatalogEntry | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [detailRevision, setDetailRevision] = useState(0)
  const ownMutation = useRef(false)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [agents, setAgents] = useState<NormalAgentDef[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    const [localResult, cloudResult] = await Promise.allSettled([listSkillCatalog(cfg), listSkills(cfg)])
    if (localResult.status === 'fulfilled') {
      setCatalog(localResult.value.filter((skill) => skill.scope === 'user'))
      setCatalogError('')
    } else {
      setCatalog(null)
      const error = localResult.reason as Error & { status?: number }
      setCatalogError(error.status === 404 ? '' : t('globalSkills.loadFailed', { error: error.message }))
    }
    setCloud(cloudResult.status === 'fulfilled' ? cloudResult.value.filter((skill) => skill.source === 'user') : [])
    setLoading(false)
  }, [cfg, t])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    const onChange = (): void => {
      if (ownMutation.current) return
      void refresh()
      setDetailRevision((value) => value + 1)
    }
    window.addEventListener('forsion:skills-changed', onChange)
    return () => window.removeEventListener('forsion:skills-changed', onChange)
  }, [refresh])
  useEffect(() => {
    if (!initialSkillKey) return
    setSelected({ kind: 'catalog', key: initialSkillKey })
    setEditor(null)
  }, [initialSkillKey])
  useEffect(() => {
    const focus = (event: Event): void => {
      const key = (event as CustomEvent<{ key?: string }>).detail?.key
      if (key) { setSelected({ kind: 'catalog', key }); setEditor(null); setFilter('all'); setQuery('') }
    }
    window.addEventListener('forsion:settings-skill-focus', focus)
    return () => window.removeEventListener('forsion:settings-skill-focus', focus)
  }, [])
  useEffect(() => {
    if (!selected || selected.kind !== 'catalog') { setDetail(null); return }
    let active = true
    setDetail(null)
    setDetailError('')
    setDetailLoading(true)
    void getSkillCatalogEntry(cfg, selected.key)
      .then((skill) => { if (active) setDetail(skill) })
      .catch((error) => { if (active) setDetailError(t('globalSkills.loadFailed', { error: String(error?.message || error) })) })
      .finally(() => { if (active) setDetailLoading(false) })
    return () => { active = false }
  }, [cfg, selected, t, detailRevision])

  const selectedCatalog = selected?.kind === 'catalog' ? catalog?.find((s) => s.key === selected.key) ?? (detail?.key === selected.key ? detail : null) : null
  const currentDetail = selectedCatalog && detail?.key === selectedCatalog.key ? detail : null
  const selectedCloud = selected?.kind === 'cloud' ? cloud.find((s) => s.id === selected.id) : null
  const lowerQuery = query.trim().toLocaleLowerCase()
  const matches = (name: string, description: string): boolean => !lowerQuery || `${name} ${description}`.toLocaleLowerCase().includes(lowerQuery)
  const mine = useMemo(() => (catalog || []).filter((s) => s.provenance === 'user' && matches(s.name, s.description)), [catalog, lowerQuery])
  const packaged = useMemo(() => (catalog || []).filter((s) => s.provenance !== 'user' && matches(s.name, s.description)), [catalog, lowerQuery])
  const cloudMatches = useMemo(() => cloud.filter((s) => matches(s.name, s.description)), [cloud, lowerQuery])
  const showMine = filter === 'all' || filter === 'user'
  const showPackaged = filter === 'all' || filter === 'builtin' || filter === 'bundle'
  const shownPackaged = filter === 'builtin' ? packaged.filter((s) => s.provenance === 'builtin' || s.provenance === 'builtin-mirror') : filter === 'bundle' ? packaged.filter((s) => s.provenance === 'bundle') : packaged
  const showCloud = filter === 'all' || filter === 'cloud'
  const anyMatches = (showMine && mine.length > 0) || (showPackaged && shownPackaged.length > 0) || (showCloud && cloudMatches.length > 0)

  const choose = (item: Selected): void => { setSelected(item); setEditor(null); setMessage('') }
  const run = async <Result,>(action: () => Promise<Result>, success: string | ((result: Result) => string), next?: Selected | null): Promise<void> => {
    setBusy(true); setMessage('')
    try {
      const result = await action()
      if (next !== undefined) setSelected(next)
      setEditor(null)
      setMessage(typeof success === 'string' ? success : success(result))
      await refresh()
      ownMutation.current = true
      notifySkillsChanged()
      ownMutation.current = false
    } catch (error: any) {
      setMessage(t('globalSkills.actionFailed', { error: String(error?.message || error) }))
    } finally { setBusy(false) }
  }

  const saveEditor = async (): Promise<void> => {
    if (!editor) return
    const draft = editor
    if (draft.kind === 'create') {
      if (!draft.name.trim() || !draft.slug.trim() || !draft.description.trim() || !draft.content.trim()) return
      await run(async () => { const created = await createSkillCatalogEntry(cfg, { scope: 'user', slug: draft.slug.trim(), name: draft.name.trim(), description: draft.description.trim(), content: draft.content }); setSelected({ kind: 'catalog', key: created.key }) }, t('globalSkills.saved'))
    } else if (draft.kind === 'edit') {
      if (!draft.name.trim() || !draft.description.trim() || !draft.content.trim()) return
      await run(async () => {
        const latest = await getSkillCatalogEntry(cfg, draft.key)
        if (latest.name !== draft.baseline.name || latest.description !== draft.baseline.description || latest.content !== draft.baseline.content) throw new Error(t('globalSkills.editConflict'))
        return updateSkillCatalogEntry(cfg, draft.key, { name: draft.name.trim(), description: draft.description.trim(), content: draft.content })
      }, t('globalSkills.saved'))
      const updated = await getSkillCatalogEntry(cfg, draft.key).catch(() => null)
      if (updated) setDetail(updated)
    } else if (draft.kind === 'import') {
      if (!draft.sourcePath) return
      await run(async () => { const imported = await importSkillCatalogEntry(cfg, { scope: 'user', sourcePath: draft.sourcePath, ...(draft.slug.trim() ? { slug: draft.slug.trim() } : {}) }); setSelected({ kind: 'catalog', key: imported.key }) }, t('globalSkills.imported'))
    } else {
      if (draft.target === 'agent' && !draft.agentSlug) return
      const targetName = draft.target === 'user' ? t('globalSkills.mine') : agents.find((a) => a.slug === draft.agentSlug)?.name || draft.agentSlug
      await run(async () => {
        const copied = await copySkillCatalogEntry(cfg, draft.key, { scope: draft.target, ...(draft.target === 'agent' ? { agentSlug: draft.agentSlug } : {}), ...(draft.slug.trim() ? { slug: draft.slug.trim() } : {}) })
        if (draft.target === 'user') setSelected({ kind: 'catalog', key: copied.key })
      }, t('globalSkills.copied', { name: targetName }))
    }
  }

  const startImport = async (): Promise<void> => {
    if (!localHost || !window.tangu?.pickDirectory) return
    const sourcePath = await window.tangu.pickDirectory()
    if (sourcePath) { setEditor({ kind: 'import', sourcePath, slug: '' }); setMessage('') }
  }
  const startCopy = async (skill: SkillCatalogEntry, target: 'user' | 'agent'): Promise<void> => {
    try {
      const available = target === 'agent' ? await listAgents(cfg) : []
      setAgents(available)
      setEditor({ kind: 'copy', key: skill.key, target, agentSlug: available[0]?.slug || '', slug: skill.compatibility ? slugFromName(skill.name, '') : target === 'user' ? `${skill.slug}-custom` : '' })
      setMessage('')
    } catch (error: any) { setMessage(t('globalSkills.actionFailed', { error: String(error?.message || error) })) }
  }
  const publish = async (skill: SkillCatalogEntry): Promise<void> => {
    const detailed = detail?.key === skill.key ? detail : await getSkillCatalogEntry(cfg, skill.key)
    const attached = (detailed.files || []).filter((file) => file.path !== 'SKILL.md')
    if (attached.length && !window.confirm(t('globalSkills.publishWarning', { count: attached.length }))) return
    await run(() => uploadSkillToCloud(cfg, skill.id), t('globalSkills.published'))
  }
  const provenanceLabel = (skill: SkillCatalogEntry): string => t(skill.provenance === 'user' ? 'globalSkills.fromUser' : skill.provenance === 'bundle' ? 'globalSkills.fromBundle' : 'globalSkills.fromBuiltin')
  const statusLabel = (skill: SkillCatalogEntry): string => t(skill.availability === 'disabled' ? 'globalSkills.disabled' : skill.availability === 'shadowed' ? 'globalSkills.shadowed' : 'globalSkills.available')
  const catalogRow = (skill: SkillCatalogEntry) => <button type="button" key={skill.key} className={`gsk-row${selected?.kind === 'catalog' && selected.key === skill.key ? ' selected' : ''}`} onClick={() => choose({ kind: 'catalog', key: skill.key })} aria-pressed={selected?.kind === 'catalog' && selected.key === skill.key}>
    <span className="gsk-row-icon"><Sparkles size={15} /></span>
    <span className="gsk-row-copy"><strong>{skill.name}</strong><small>{skill.description || skill.slug}</small></span>
    <span className={`gsk-state${skill.disabled ? ' paused' : ''}`}>{statusLabel(skill)}</span>
    <ChevronRight size={14} className="gsk-chevron" />
  </button>

  return <div className="gsk-library">
    <div className="gsk-toolbar">
      <div className="gsk-search"><Search size={15} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('globalSkills.search')} aria-label={t('globalSkills.search')} /></div>
      <CapabilityMenu label={t('globalSkills.source')} selection items={([
        ['all', 'globalSkills.allSources'], ['user', 'globalSkills.mine'], ['builtin', 'globalSkills.fromBuiltin'], ['bundle', 'globalSkills.fromBundle'], ['cloud', 'globalSkills.cloud'],
      ] as const).map(([id, key]) => ({ id, label: t(key), selected: filter === id, onSelect: () => setFilter(id) }))}>
        <span>{t(({ all: 'globalSkills.allSources', user: 'globalSkills.mine', builtin: 'globalSkills.fromBuiltin', bundle: 'globalSkills.fromBundle', cloud: 'globalSkills.cloud' } as const)[filter])}</span><ChevronDown size={13} />
      </CapabilityMenu>
      {catalog !== null && <CapabilityMenu label={t('globalSkills.add')} className="btn primary sm" items={[
        { id: 'create', label: t('globalSkills.create'), icon: <FileText size={14} />, onSelect: () => setEditor({ kind: 'create', name: '', slug: '', slugEdited: false, description: '', content: '' }) },
        ...(localHost && !!window.tangu?.pickDirectory ? [{ id: 'import', label: t('globalSkills.import'), icon: <FolderInput size={14} />, onSelect: () => void startImport() }] : []),
        ...(onImportCli ? [{ id: 'cli', label: t('globalSkills.importCli'), icon: <FolderInput size={14} />, onSelect: onImportCli }] : []),
        { id: 'market', label: t('globalSkills.browseMarket'), icon: <Sparkles size={14} />, onSelect: onBrowseMarket },
      ]}><Plus size={13} />{t('globalSkills.add')}<ChevronDown size={12} /></CapabilityMenu>}
      <button className="icon-btn" type="button" onClick={() => void refresh()} title={t('globalSkills.refresh')} aria-label={t('globalSkills.refresh')}><RefreshCw size={14} className={loading ? 'spin' : ''} /></button>
    </div>
    {catalog !== null && <p className="gsk-host-note">{t(localHost ? 'globalSkills.localHost' : 'globalSkills.remoteHost')}{localHost && !!window.tangu?.openSkillsDir && <button type="button" onClick={() => void window.tangu?.openSkillsDir?.()}><FolderOpen size={13} />{t('globalSkills.openFolder')}</button>}</p>}
    <div className="gsk-columns">
      <div className="gsk-list">
        {catalog === null && <p className="gsk-list-message">{loading ? t('globalSkills.loading') : catalogError || t('globalSkills.unavailable')}</p>}
        {catalog !== null && showMine && <section className="gsk-group"><div className="gsk-group-head"><strong>{t('globalSkills.mine')}</strong><span>{mine.length}</span></div>{mine.length ? mine.map(catalogRow) : !lowerQuery && <p className="gsk-empty">{t('globalSkills.empty')}</p>}</section>}
        {catalog !== null && showPackaged && !!shownPackaged.length && <section className="gsk-group"><button className="gsk-group-head gsk-group-toggle" type="button" aria-expanded={packagedOpen || !!lowerQuery || filter !== 'all'} onClick={() => setPackagedOpen((open) => !open)}><strong>{t('globalSkills.packaged')}</strong><span>{shownPackaged.length}</span>{packagedOpen || !!lowerQuery || filter !== 'all' ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>{(packagedOpen || !!lowerQuery || filter !== 'all') && shownPackaged.map(catalogRow)}</section>}
        {showCloud && !!cloudMatches.length && <section className="gsk-group"><div className="gsk-group-head"><strong>{t('globalSkills.cloud')}</strong><span>{cloudMatches.length}</span></div>{cloudMatches.map((skill) => <button type="button" key={skill.id} className={`gsk-row${selected?.kind === 'cloud' && selected.id === skill.id ? ' selected' : ''}`} onClick={() => choose({ kind: 'cloud', id: skill.id })} aria-pressed={selected?.kind === 'cloud' && selected.id === skill.id}><span className="gsk-row-icon"><UploadCloud size={15} /></span><span className="gsk-row-copy"><strong>{skill.name}</strong><small>{skill.description || skill.id}</small></span><ChevronRight size={14} className="gsk-chevron" /></button>)}</section>}
        {!loading && catalog !== null && !anyMatches && <p className="gsk-list-message">{t(lowerQuery ? 'globalSkills.noResults' : 'globalSkills.empty')}</p>}
      </div>
      <div className="gsk-detail" key={editor ? `editor:${editor.kind}` : JSON.stringify(selected)}>
        {editor ? <>
          <div className="gsk-detail-head"><div><span>{t(editor.kind === 'create' ? 'globalSkills.create' : editor.kind === 'edit' ? 'globalSkills.edit' : editor.kind === 'import' ? 'globalSkills.import' : editor.target === 'user' ? 'globalSkills.copyToMine' : 'globalSkills.copyToAgent')}</span><h3>{editor.kind === 'edit' ? editor.name : t(editor.kind === 'create' ? 'globalSkills.create' : editor.kind === 'import' ? 'globalSkills.import' : editor.target === 'user' ? 'globalSkills.copyToMine' : 'globalSkills.copyToAgent')}</h3></div></div>
          <div className="gsk-form">
            {(editor.kind === 'create' || editor.kind === 'edit') && <>
              <label>{t('globalSkills.name')}<input value={editor.name} onChange={(e) => setEditor({ ...editor, name: e.target.value, ...(editor.kind === 'create' && !editor.slugEdited ? { slug: slugFromName(e.target.value, editor.slug) } : {}) })} /></label>
              {editor.kind === 'create' && <label>{t('globalSkills.slug')}<input value={editor.slug} onChange={(e) => setEditor({ ...editor, slug: e.target.value, slugEdited: true })} /></label>}
              <label>{t('globalSkills.description')}<input value={editor.description} onChange={(e) => setEditor({ ...editor, description: e.target.value })} /></label>
              <label>{t('globalSkills.body')}<textarea rows={12} value={editor.content} onChange={(e) => setEditor({ ...editor, content: e.target.value })} /></label>
              <p>{t('globalSkills.bodyHint')}</p>
            </>}
            {editor.kind === 'import' && <><p>{t('globalSkills.importHint')}</p><label>{t('globalSkills.sourceFolder')}<input value={editor.sourcePath} readOnly /></label><label>{t('globalSkills.slugOverride')}<input value={editor.slug} onChange={(e) => setEditor({ ...editor, slug: e.target.value })} placeholder={t('globalSkills.slugHint')} /></label></>}
            {editor.kind === 'copy' && <>{editor.target === 'agent' && (agents.length ? <label>{t('globalSkills.chooseAgent')}<select value={editor.agentSlug} onChange={(e) => setEditor({ ...editor, agentSlug: e.target.value })}>{agents.map((agent) => <option key={agent.slug} value={agent.slug}>{agent.name}</option>)}</select></label> : <p>{t('globalSkills.noAgent')}</p>)}<label>{t('globalSkills.slugOverride')}<input value={editor.slug} onChange={(e) => setEditor({ ...editor, slug: e.target.value })} placeholder={t('globalSkills.slugHint')} /></label></>}
            <div className="gsk-form-actions"><button className="btn primary sm" type="button" disabled={busy || (editor.kind === 'copy' && (editor.target === 'agent' && !editor.agentSlug || editor.target === 'user' && !editor.slug.trim())) || (editor.kind === 'create' && (!editor.name.trim() || !editor.description.trim() || !editor.slug.trim() || !editor.content.trim())) || (editor.kind === 'edit' && (!editor.name.trim() || !editor.description.trim() || !editor.content.trim()))} onClick={() => void saveEditor()}>{busy && <Loader2 size={13} className="spin" />}{t(editor.kind === 'import' ? 'globalSkills.importAction' : editor.kind === 'copy' ? 'globalSkills.copyAction' : 'globalSkills.save')}</button><button className="btn ghost sm" type="button" onClick={() => setEditor(null)}>{t('globalSkills.cancel')}</button></div>
          </div>
        </> : selectedCatalog ? <>
          <div className="gsk-detail-head"><div><span>{provenanceLabel(selectedCatalog)}</span><h3>{selectedCatalog.name}</h3><p>{selectedCatalog.description}</p></div><span className={`gsk-detail-status${selectedCatalog.disabled ? ' paused' : ''}`}>{statusLabel(selectedCatalog)}</span></div>
          {selectedCatalog.availability === 'shadowed' && selectedCatalog.shadowedBy && <p className="gsk-readonly">{t('globalSkills.overriddenBy', { source: catalog?.find((item) => item.key === selectedCatalog.shadowedBy)?.provenance === 'user' ? t('globalSkills.fromUser') : t('globalSkills.packaged') })}</p>}
          <div className="gsk-actions">
            {!selectedCatalog.readOnly && <button type="button" className="btn ghost sm" onClick={() => { const s = currentDetail; if (s) setEditor({ kind: 'edit', key: s.key, name: s.name, description: s.description, slug: s.slug, content: s.content || '', baseline: { name: s.name, description: s.description, content: s.content || '' } }) }} disabled={detailLoading || !currentDetail}><BookOpen size={13} />{t('globalSkills.edit')}</button>}
            <button type="button" className="btn ghost sm" onClick={() => void startCopy(selectedCatalog, 'agent')}><Copy size={13} />{t('globalSkills.copyToAgent')}</button>
            {selectedCatalog.readOnly && <button type="button" className="btn ghost sm" onClick={() => void startCopy(selectedCatalog, 'user')}><Copy size={13} />{t('globalSkills.copyToMine')}</button>}
            {selectedCatalog.provenance === 'user' && selectedCatalog.availability === 'available' && <button type="button" className="btn ghost sm" onClick={() => void publish(selectedCatalog)} disabled={busy}><UploadCloud size={13} />{t('globalSkills.publish')}</button>}
            {!selectedCatalog.compatibility && <div className="gsk-more"><CapabilityMenu label={t('globalSkills.more')} className="icon-btn" items={[
              ...(selectedCatalog.availability !== 'shadowed' ? [{ id: 'pause', label: t(selectedCatalog.disabled ? 'globalSkills.resume' : 'globalSkills.pause'), onSelect: () => void run(() => setSkillCatalogEntryDisabled(cfg, selectedCatalog.key, !selectedCatalog.disabled), t('globalSkills.saved')) }] : []),
              ...(!selectedCatalog.readOnly ? [{ id: 'delete', label: t('globalSkills.delete'), icon: <Trash2 size={14} />, danger: true, onSelect: () => { if (window.confirm(t('globalSkills.deleteConfirm', { name: selectedCatalog.name }))) void run(() => deleteSkillCatalogEntry(cfg, selectedCatalog.key), (result) => t('globalSkills.deleted', { path: result.backupPath || '' }), null) } }] : []),
            ]}><MoreHorizontal size={16} /></CapabilityMenu></div>}

          </div>
          {selectedCatalog.readOnly && <p className="gsk-readonly"><Check size={13} />{t(selectedCatalog.compatibility ? 'globalSkills.legacyReadOnly' : 'globalSkills.readOnly')}</p>}
          <div className="gsk-meta"><span>{t('globalSkills.path')}</span><code title={selectedCatalog.path}>{selectedCatalog.path}</code></div>
          {detailError ? <p className="gsk-message" role="alert">{detailError}</p> : detailLoading || !currentDetail ? <p className="gsk-detail-loading"><Loader2 size={14} className="spin" />{t('globalSkills.loading')}</p> : <><section className="gsk-content"><h4>{t('globalSkills.content')}</h4><pre>{currentDetail.content || t('globalSkills.noContent')}</pre></section>{!!currentDetail.files?.length && <section className="gsk-files"><h4>{t('globalSkills.files')} · {currentDetail.files.length}</h4><div>{currentDetail.files.map((file) => <span key={file.path}><FileText size={12} />{file.path}</span>)}</div></section>}</>}
        </> : selectedCloud ? <>
          <div className="gsk-detail-head"><div><span>{t('globalSkills.cloud')}</span><h3>{selectedCloud.name}</h3><p>{selectedCloud.description}</p></div></div>
          <p className="gsk-cloud-note">{t('globalSkills.cloudExplanation')}</p><p className="gsk-cloud-note">{t('globalSkills.cloudPreview')}</p>
          <div className="gsk-actions"><button className="btn ghost sm" type="button" disabled={busy} onClick={() => { if (window.confirm(t('globalSkills.deleteCloudConfirm', { name: selectedCloud.name }))) void run(() => deleteUserCloudSkill(cfg, selectedCloud.id), t('globalSkills.cloudDeleted'), null) }}><Trash2 size={13} />{t('globalSkills.delete')}</button></div>
        </> : <div className="gsk-placeholder"><Sparkles size={22} /><p>{t('globalSkills.pick')}</p></div>}
      </div>
    </div>
    {message && <p className="gsk-message" role="status">{message}</p>}
  </div>
}
