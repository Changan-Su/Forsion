import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { ArrowLeft, ArrowRight, Bot, Check, ChevronDown, Code2, Folder, FolderOpen, Image, LayoutDashboard, Lightbulb, Loader2, MessageSquare, Palette, Plus, Puzzle, Search, UserRound, WandSparkles, X, RotateCw } from 'lucide-react'
import { useI18n } from '../../i18n'
import { formatDate } from '../../format/time'
import { ChatBox, useChatBoxSelection, type ChatBoxSelection } from '../../components/chatbox'
import { projectBasename, STUDIO_CAPABILITIES, STUDIO_TEMPLATES, validateProjectName, type StudioBrief, type StudioCapability, type StudioTemplate } from './projectBrief'
import { useLaunchNavigation } from './launchpadNavigation'
import './launchpadMessages'
import './launchpad.css'

export interface ProjectLaunchpadProps {
  root: string | null
  recentProjects?: ReadonlyArray<{ path: string; name: string; openedAt?: number; description?: string; kind?: 'web' | 'plugin'; templateId?: string }>
  onOpen(path: string, name: string): void
  onCreate(path: string, name: string, brief: StudioBrief, selection: ChatBoxSelection): void
}

const CAPABILITY_ICONS = { chat: MessageSquare, agent: Bot, images: Image, account: UserRound }
// 按模板 id 取图标,没有兜底 —— 新增模板必须同时在这里加一行,否则 <Icon> 是 undefined,整块启动页直接崩。
const TEMPLATE_ICONS = { assistant: WandSparkles, dashboard: LayoutDashboard, portfolio: Palette, explainer: Lightbulb, image: Image, research: Bot, plugin: Puzzle }
type Project = { name: string; path: string; openedAt?: number; description?: string; kind?: 'web' | 'plugin'; templateId?: string }
function ProjectIcon({ project }: { project: Project }) {
  const Icon = project.templateId && Object.hasOwn(TEMPLATE_ICONS, project.templateId)
    ? TEMPLATE_ICONS[project.templateId as keyof typeof TEMPLATE_ICONS]
    : project.kind === 'plugin' ? Puzzle : Code2
  return <Icon size={18} />
}

export function ProjectLaunchpad({ root, recentProjects, onOpen, onCreate }: ProjectLaunchpadProps) {
  const { t, locale } = useI18n()
  const id = useId()
  const [selection, setSelection] = useChatBoxSelection('coding')
  const [idea, setIdea] = useState('')
  const [audience, setAudience] = useState('')
  const [constraints, setConstraints] = useState('')
  const [name, setName] = useState('')
  const [templateId, setTemplateId] = useState<string>()
  const [capabilities, setCapabilities] = useState<StudioCapability[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [existingNames, setExistingNames] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const page = useLaunchNavigation(s => s.page)
  const filter = useLaunchNavigation(s => s.filter)
  const showProjects = useLaunchNavigation(s => s.showProjects)
  const showCreate = useLaunchNavigation(s => s.showCreate)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<'create' | 'import' | null>(null)
  const [errorKey, setErrorKey] = useState<string | null>(null)
  const [listError, setListError] = useState(false)
  const [nameTouched, setNameTouched] = useState(false)
  const ideaInput = useRef<HTMLTextAreaElement>(null)
  const newButton = useRef<HTMLButtonElement>(null)
  const visitedCreate = useRef(false)
  const inFlight = useRef(false)
  const listRequest = useRef(0)
  const canCreate = !!window.tangu?.mkdirHost && !!window.tangu?.listDir
  const canImport = !!window.tangu?.pickDirectory
  const canList = !!window.tangu?.listDir
  const nameIssue = nameTouched ? validateProjectName(name, existingNames) : null
  const selectedTemplate = STUDIO_TEMPLATES.find((template) => template.id === templateId)
  // 插件跑在 Forsion 宿主里,不经网页 SDK:这些能力对它无意义,所以整块收起来而不是留着让人勾。
  const pluginProject = selectedTemplate?.kind === 'plugin'

  const refresh = useCallback(async () => {
    const request = ++listRequest.current
    if (!root || !window.tangu?.listDir) { setProjects([]); setExistingNames([]); setLoading(false); return }
    setLoading(true); setListError(false)
    try {
      const entries = await window.tangu.listDir(root)
      if (request !== listRequest.current) return
      setExistingNames(entries.map((e) => e.name))
      setProjects(entries.filter((e) => e.isDir && !e.name.startsWith('.'))
        .map((e) => ({ name: e.name, path: e.path })).sort((a, b) => a.name.localeCompare(b.name)))
    } catch {
      if (request === listRequest.current) setListError(true)
    } finally {
      if (request === listRequest.current) setLoading(false)
    }
  }, [root])

  useEffect(() => {
    setProjects([]); setExistingNames([])
    void refresh()
    return () => { listRequest.current++ }
  }, [refresh])
  useEffect(() => {
    if (page === 'create') { visitedCreate.current = true; ideaInput.current?.focus({ preventScroll: true }) }
    else if (page === 'projects' && visitedCreate.current) newButton.current?.focus({ preventScroll: true })
  }, [page])

  const allProjects = useMemo(() => {
    const seen = new Set<string>()
    return [...(recentProjects || []), ...projects].filter((project) => {
      const normalized = project.path.replace(/\\/g, '/').replace(/\/+$/, '').normalize('NFC')
      if (!normalized || seen.has(normalized)) return false
      seen.add(normalized); return true
    }).sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0) || a.name.localeCompare(b.name, locale))
  }, [projects, recentProjects, locale])
  const isImported = (path: string) => !!root && !path.replace(/\\/g, '/').startsWith(`${root.replace(/\\/g, '/').replace(/\/+$/, '')}/`)
  const filtered = useMemo(() => {
    const q = search.trim().toLocaleLowerCase()
    return allProjects.filter((p) => (filter === 'all' || (filter === 'recent' ? !!p.openedAt : isImported(p.path)))
      && (!q || `${p.name} ${p.description || ''} ${p.path}`.toLocaleLowerCase().includes(q)))
  }, [allProjects, filter, search, root])
  const formatOpened = (timestamp?: number) => timestamp && Number.isFinite(timestamp)
    ? formatDate(timestamp, { locale, year: 'always' })
    : t('csl.notOpened')

  function chooseTemplate(template: StudioTemplate) {
    const previous = STUDIO_TEMPLATES.find((v) => v.id === templateId)
    setIdea(t(template.ideaKey))
    if (!name.trim() || name === previous?.folderName) setName(template.folderName)
    setCapabilities([...template.capabilities])
    setTemplateId(template.id)
    setNameTouched(false); setErrorKey(null)
    showCreate()
    ideaInput.current?.focus({ preventScroll: true })
    ideaInput.current?.scrollIntoView?.({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
  }

  function toggleCapability(capability: StudioCapability) {
    setCapabilities((current) => current.includes(capability) ? current.filter((v) => v !== capability) : [...current, capability])
  }

  async function create(event?: FormEvent) {
    event?.preventDefault()
    if (inFlight.current || !root || !window.tangu?.mkdirHost || !window.tangu?.listDir) return
    setNameTouched(true); setErrorKey(null)
    if (!idea.trim()) { setErrorKey('csl.ideaRequired'); return }
    const normalizedName = name.trim().normalize('NFC')
    const issue = validateProjectName(normalizedName, existingNames)
    if (issue) { setErrorKey(`csl.name.${issue}`); return }
    inFlight.current = true; setBusy('create')
    try {
      // Read again at submission time: another app or window may have created a folder.
      const entries = await window.tangu.listDir(root)
      const latestIssue = validateProjectName(normalizedName, entries.map((e) => e.name))
      if (latestIssue) {
        setExistingNames(entries.map((e) => e.name)); setErrorKey(`csl.name.${latestIssue}`)
        return
      }
      const result = await window.tangu.mkdirHost(root, normalizedName)
      if (!result.path) throw new Error('Missing created project path')
      onCreate(result.path, normalizedName, { idea: idea.trim(), audience: audience.trim(), constraints: constraints.trim(), capabilities: pluginProject ? [] : [...capabilities], templateId, ...(pluginProject ? { kind: 'plugin' as const } : {}), locale }, selection)
    } catch {
      setErrorKey('csl.createFailed')
      void refresh()
    } finally {
      inFlight.current = false; setBusy(null)
    }
  }

  async function importProject() {
    if (inFlight.current || !window.tangu?.pickDirectory) return
    inFlight.current = true; setBusy('import'); setErrorKey(null)
    try {
      const path = await window.tangu.pickDirectory()
      if (path) onOpen(path, projectBasename(path))
    } catch { setErrorKey('csl.importFailed') }
    finally { inFlight.current = false; setBusy(null) }
  }

  return (
    <div className="csl-launchpad">
      <div className="csl-inner">
        {page === 'projects' ? <main className="csl-catalog">
          <header className="csl-catalog-header">
            <div><h1>{t(filter === 'all' ? 'csl.projects' : `csl.filter.${filter}`)}</h1><p>{t('csl.subtitle')}</p></div>
            <div className="csl-catalog-actions">
              {canImport && <button className="csl-import" type="button" onClick={() => void importProject()} disabled={!!busy}>
                {busy === 'import' ? <Loader2 size={15} className="csl-spin" /> : <FolderOpen size={15} />}
                {t(busy === 'import' ? 'csl.importing' : 'csl.import')}
              </button>}
              <button ref={newButton} className="csl-new" type="button" onClick={showCreate} disabled={!canCreate || !root}><Plus size={16} />{t('csl.newProject')}</button>
            </div>
          </header>
          <div className="csl-catalog-toolbar">
            <div className="csl-search"><Search size={15} /><input type="search" aria-label={t('csl.search')} placeholder={t('csl.search')} value={search} onChange={(e) => setSearch(e.target.value)} />
              {search && <button className="csl-icon-button" type="button" aria-label={t('csl.clearSearch')} onClick={() => setSearch('')}><X size={13} /></button>}
            </div>
            {canList && <button type="button" className="csl-icon-button csl-refresh" title={t('csl.refresh')} aria-label={t('csl.refresh')}
              onClick={() => void refresh()} disabled={loading || !!busy || !root}><RotateCw size={15} className={loading ? 'csl-spin' : undefined} /></button>}
          </div>
          {listError && <p className="csl-error" role="alert">{t('csl.listFailed')}</p>}
          {canList && !root ? <p className="csl-status" role="status"><Loader2 size={16} className="csl-spin" />{t('csl.rootLoading')}</p>
            : loading && allProjects.length === 0 ? <p className="csl-status" role="status"><Loader2 size={16} className="csl-spin" />{t('csl.projectsLoading')}</p>
            : listError && allProjects.length === 0 ? null
              : !canList ? <p className="csl-status">{t('csl.hostUnavailable')}</p>
                : allProjects.length === 0 ? <div className="csl-empty"><Code2 size={25} /><strong>{t('csl.emptyTitle')}</strong><p>{t('csl.emptyHint')}</p><button type="button" className="csl-new" disabled={!canCreate} onClick={showCreate}><Plus size={15} />{t('csl.newProject')}</button></div>
                  : <div className="csl-project-list" role="group" aria-label={t('csl.projects')}>
                    <div className="csl-list-head" aria-hidden="true"><span>{t('csl.columnName')} · {filtered.length}</span><span>{t('csl.lastOpened')}</span></div>
                    {filtered.map((project) => <button type="button" key={project.path} className="csl-project" title={project.path}
                      onClick={() => onOpen(project.path, project.name)} disabled={!!busy}>
                      <span className={`csl-project-icon${project.kind === 'plugin' ? ' csl-project-icon--plugin' : ''}`} aria-hidden="true"><ProjectIcon project={project} /></span>
                      <span className="csl-project-info"><strong>{project.name}</strong><small>{project.description?.replace(/\s+/g, ' ').trim().slice(0, 180) || project.path}</small></span>
                      <span className="csl-project-meta"><span>{formatOpened(project.openedAt)}</span><small>{t(isImported(project.path) ? 'csl.importedProject' : 'csl.localProject')}</small></span>
                      <ArrowRight size={15} className="csl-project-arrow" aria-hidden="true" />
                    </button>)}
                    {filtered.length === 0 && <p className="csl-status">{t('csl.noResults')}</p>}
                  </div>}
        </main> : page === 'gallery' ? <main className="csl-gallery">
          <header className="csl-catalog-header"><div><h1>{t('csl.gallery')}</h1><p>{t('csl.galleryHint')}</p></div></header>
          <div className="csl-gallery-grid">
            {STUDIO_TEMPLATES.map(template => {
              const Icon = TEMPLATE_ICONS[template.id as keyof typeof TEMPLATE_ICONS]
              return <button key={template.id} type="button" className="csl-gallery-card" onClick={() => chooseTemplate(template)}>
                <span className="csl-gallery-icon"><Icon size={21} /></span><strong>{t(template.nameKey)}</strong><small>{t(template.summaryKey)}</small><span className="csl-gallery-action">{t('csl.useTemplate')}<ArrowRight size={14} /></span>
              </button>
            })}
          </div>
        </main> : <main className="csl-create-page">
          <button className="csl-back" type="button" onClick={() => showProjects()}><ArrowLeft size={15} />{t('csl.backToProjects')}</button>
          <header className="csl-create-header"><h1>{t('csl.createTitle')}</h1><p>{t('csl.createSubtitle')}</p></header>
          <div className="csl-main">
            <form className="csl-brief" onSubmit={(e) => void create(e)}>
              <ChatBox className="csl-chatbox" value={idea} onValueChange={value => { setIdea(value); setErrorKey(null) }}
                selection={selection} onSelectionChange={setSelection} inputRef={ideaInput}
                inputProps={{ id: `${id}-idea`, className: 'csl-idea', placeholder: t('csl.ideaPlaceholder'), maxLength: 16000 }}
                disabled={!!busy} submitDisabled={!root || !canCreate}
                submitLabel={t(busy === 'create' ? 'csl.creating' : 'csl.create')} onSubmit={() => void create()}
                submitClassName="csl-create"
                submitContent={<>{busy === 'create' ? <Loader2 size={15} className="csl-spin" /> : <ArrowRight size={15} />}{t(busy === 'create' ? 'csl.creating' : 'csl.create')}</>}
                beforeInput={<>
              <div className="csl-idea-head">
                <label className="csl-idea-label" htmlFor={`${id}-idea`}>{t('csl.idea')}</label>
                {selectedTemplate && <span className="csl-template-status" role="status" title={t('csl.templateSelected')}><Check size={12} />{t(selectedTemplate.nameKey)}</span>}
              </div>
                </>}
                afterInput={<div className="csl-project-options">
              <details className="csl-details">
                <summary><ChevronDown size={14} />{t('csl.details')}<span>{t('csl.optional')}</span></summary>
                <div className="csl-details-body">
                  <label htmlFor={`${id}-audience`}>{t('csl.audience')}</label>
                  <input id={`${id}-audience`} value={audience} onChange={(e) => setAudience(e.target.value)}
                    maxLength={500} placeholder={t('csl.audiencePlaceholder')} disabled={!!busy} />
                  <label htmlFor={`${id}-constraints`}>{t('csl.constraints')}</label>
                  <textarea id={`${id}-constraints`} value={constraints} onChange={(e) => setConstraints(e.target.value)}
                    maxLength={4000} placeholder={t('csl.constraintsPlaceholder')} disabled={!!busy} rows={3} />
                </div>
              </details>
              {pluginProject
                ? <p className="csl-plugin-note" data-plugin-note>{t('csl.pluginProjectHint')}</p>
                : <fieldset className="csl-capabilities">
                  <legend>{t('csl.capabilities')}<span>{t('csl.optional')}</span></legend>
                  <div className="csl-capability-list">
                    {STUDIO_CAPABILITIES.map((cap) => {
                      const Icon = CAPABILITY_ICONS[cap]
                      return <button key={cap} type="button" className="csl-capability" aria-pressed={capabilities.includes(cap)}
                        title={t(`csl.cap.${cap}Hint`)} onClick={() => toggleCapability(cap)} disabled={!!busy}>
                        <Icon size={14} /><span>{t(`csl.cap.${cap}`)}</span>{capabilities.includes(cap) && <Check size={12} />}
                      </button>
                    })}
                  </div>
                  {capabilities.length > 0 && <p className="csl-capability-hint">{t('csl.capabilitiesHint')}</p>}
                </fieldset>}
              <div className="csl-create-row">
                <div className="csl-name-field">
                  <label htmlFor={`${id}-name`}>{t('csl.projectName')}</label>
                  <input id={`${id}-name`} placeholder={t('csl.projectNamePlaceholder')} value={name}
                    onChange={(e) => { setName(e.target.value); setErrorKey(null) }} onBlur={() => setNameTouched(true)}
                    aria-invalid={!!nameIssue} aria-describedby={nameIssue ? `${id}-name-error` : undefined} disabled={!!busy} maxLength={110} />
                </div>
              </div>
              {nameIssue && <p id={`${id}-name-error`} className="csl-error">{t(`csl.name.${nameIssue}`)}</p>}
              {errorKey && errorKey !== `csl.name.${nameIssue}` && <p role="alert" className="csl-error">{t(errorKey)}</p>}
                </div>} />
              {canCreate ? <>
                <p className="csl-draft-hint">{t('csl.draftHint')}</p>
                <details className="csl-save-location"><summary><Folder size={11} /><span>{t('csl.saveLocation')}</span><ChevronDown size={11} /></summary>
                  <p className="csl-location">{root ? t('csl.location', { path: root }) : t('csl.rootLoading')}</p>
                </details>
              </> : <p className="csl-host-hint">{t('csl.hostUnavailable')}</p>}
            </form>
            <section className="csl-templates" aria-labelledby={`${id}-templates`}>
              <div className="csl-section-heading"><h2 id={`${id}-templates`}>{t('csl.templates')}</h2><p>{t('csl.templatesHint')}</p></div>
              <div className="csl-template-list">
                {STUDIO_TEMPLATES.map((template) => {
                  const Icon = TEMPLATE_ICONS[template.id as keyof typeof TEMPLATE_ICONS]
                  const selected = templateId === template.id
                  return <button key={template.id} type="button" className="csl-template" data-template-id={template.id} onClick={() => chooseTemplate(template)}
                    aria-pressed={selected} disabled={!!busy} title={selected ? t('csl.templateSelected') : undefined}>
                    <Icon size={18} /><span><strong>{t(template.nameKey)}</strong><small>{t(template.summaryKey)}</small></span>
                    {selected ? <Check size={14} /> : <ArrowRight size={14} className="csl-template-arrow" />}
                  </button>
                })}
              </div>
            </section>
          </div>
        </main>}
      </div>
    </div>
  )
}

export default ProjectLaunchpad
