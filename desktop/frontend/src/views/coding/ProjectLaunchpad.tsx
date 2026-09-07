import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { ArrowRight, Bot, Check, ChevronDown, Folder, FolderOpen, Image, LayoutDashboard, Lightbulb, Loader2, MessageSquare, Palette, Search, UserRound, WandSparkles, X, RotateCw } from 'lucide-react'
import { useI18n } from '../../i18n'
import { projectBasename, STUDIO_CAPABILITIES, STUDIO_TEMPLATES, validateProjectName, type StudioBrief, type StudioCapability, type StudioTemplate } from './projectBrief'
import './launchpadMessages'
import './launchpad.css'

export interface ProjectLaunchpadProps {
  root: string | null
  recentProjects?: ReadonlyArray<{ path: string; name: string }>
  onOpen(path: string, name: string): void
  onCreate(path: string, name: string, brief: StudioBrief): void
}

const CAPABILITY_ICONS = { chat: MessageSquare, agent: Bot, images: Image, account: UserRound }
const TEMPLATE_ICONS = { assistant: WandSparkles, dashboard: LayoutDashboard, portfolio: Palette, explainer: Lightbulb, image: Image, research: Bot }
type Project = { name: string; path: string }

export function ProjectLaunchpad({ root, recentProjects, onOpen, onCreate }: ProjectLaunchpadProps) {
  const { t, locale } = useI18n()
  const id = useId()
  const [idea, setIdea] = useState('')
  const [audience, setAudience] = useState('')
  const [constraints, setConstraints] = useState('')
  const [name, setName] = useState('')
  const [templateId, setTemplateId] = useState<string>()
  const [capabilities, setCapabilities] = useState<StudioCapability[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [existingNames, setExistingNames] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<'create' | 'import' | null>(null)
  const [errorKey, setErrorKey] = useState<string | null>(null)
  const [listError, setListError] = useState(false)
  const [nameTouched, setNameTouched] = useState(false)
  const inFlight = useRef(false)
  const listRequest = useRef(0)
  const canCreate = !!window.tangu?.mkdirHost && !!window.tangu?.listDir
  const canImport = !!window.tangu?.pickDirectory
  const canList = !!window.tangu?.listDir
  const nameIssue = nameTouched ? validateProjectName(name, existingNames) : null

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

  const allProjects = useMemo(() => {
    const seen = new Set<string>()
    return [...(recentProjects || []), ...projects].filter((project) => {
      const normalized = project.path.replace(/\\/g, '/').replace(/\/+$/, '').normalize('NFC')
      if (!normalized || seen.has(normalized)) return false
      seen.add(normalized); return true
    })
  }, [projects, recentProjects])
  const filtered = useMemo(() => {
    const q = search.trim().toLocaleLowerCase()
    return allProjects.filter((p) => p.name.toLocaleLowerCase().includes(q))
  }, [allProjects, search])

  function chooseTemplate(template: StudioTemplate) {
    const previous = STUDIO_TEMPLATES.find((v) => v.id === templateId)
    setIdea(t(template.ideaKey))
    if (!name.trim() || name === previous?.folderName) setName(template.folderName)
    setCapabilities([...template.capabilities])
    setTemplateId(template.id)
    setNameTouched(false); setErrorKey(null)
  }

  function toggleCapability(capability: StudioCapability) {
    setCapabilities((current) => current.includes(capability) ? current.filter((v) => v !== capability) : [...current, capability])
  }

  async function create(event: FormEvent) {
    event.preventDefault()
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
      onCreate(result.path, normalizedName, { idea: idea.trim(), audience: audience.trim(), constraints: constraints.trim(), capabilities: [...capabilities], templateId, locale })
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
        <header className="csl-header">
          <span className="csl-eyebrow">{t('csl.eyebrow')}</span>
          <h1>{t('csl.title')}</h1>
          <p>{t('csl.subtitle')}</p>
        </header>
        <div className="csl-layout">
          <main className="csl-main">
            <form className="csl-brief" onSubmit={(e) => void create(e)}>
              <label className="csl-idea-label" htmlFor={`${id}-idea`}>{t('csl.idea')}</label>
              <textarea id={`${id}-idea`} className="csl-idea" placeholder={t('csl.ideaPlaceholder')}
                value={idea} maxLength={16000} onChange={(e) => { setIdea(e.target.value); setErrorKey(null) }} disabled={!!busy} />
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
              <fieldset className="csl-capabilities">
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
              </fieldset>
              <div className="csl-create-row">
                <div className="csl-name-field">
                  <label htmlFor={`${id}-name`}>{t('csl.projectName')}</label>
                  <input id={`${id}-name`} placeholder={t('csl.projectNamePlaceholder')} value={name}
                    onChange={(e) => { setName(e.target.value); setErrorKey(null) }} onBlur={() => setNameTouched(true)}
                    aria-invalid={!!nameIssue} aria-describedby={nameIssue ? `${id}-name-error` : undefined} disabled={!!busy} maxLength={110} />
                </div>
                <button type="submit" className="csl-create" disabled={!!busy || !root || !canCreate}>
                  {busy === 'create' ? <Loader2 size={15} className="csl-spin" /> : <ArrowRight size={15} />}
                  {t(busy === 'create' ? 'csl.creating' : 'csl.create')}
                </button>
              </div>
              {nameIssue && <p id={`${id}-name-error`} className="csl-error">{t(`csl.name.${nameIssue}`)}</p>}
              {errorKey && errorKey !== `csl.name.${nameIssue}` && <p role="alert" className="csl-error">{t(errorKey)}</p>}
              {canCreate ? <>
                <p className="csl-location" title={root || undefined}>{root ? t('csl.location', { path: root }) : t('csl.rootLoading')}</p>
                <p className="csl-draft-hint">{t('csl.draftHint')}</p>
              </> : <p className="csl-host-hint">{t('csl.hostUnavailable')}</p>}
            </form>
            <section className="csl-templates" aria-labelledby={`${id}-templates`}>
              <div className="csl-section-heading"><h2 id={`${id}-templates`}>{t('csl.templates')}</h2><p>{t('csl.templatesHint')}</p></div>
              <div className="csl-template-list">
                {STUDIO_TEMPLATES.map((template) => {
                  const Icon = TEMPLATE_ICONS[template.id as keyof typeof TEMPLATE_ICONS]
                  const selected = templateId === template.id
                  return <button key={template.id} type="button" className="csl-template" onClick={() => chooseTemplate(template)}
                    aria-pressed={selected} disabled={!!busy} title={selected ? t('csl.templateSelected') : undefined}>
                    <Icon size={18} /><span><strong>{t(template.nameKey)}</strong><small>{t(template.summaryKey)}</small></span>
                    {selected ? <Check size={14} /> : <ArrowRight size={14} className="csl-template-arrow" />}
                  </button>
                })}
              </div>
            </section>
          </main>
          <aside className="csl-projects" aria-labelledby={`${id}-projects`}>
            <div className="csl-projects-head"><h2 id={`${id}-projects`}>{t('csl.projects')}</h2>
              {canList && <button type="button" className="csl-icon-button" title={t('csl.refresh')} aria-label={t('csl.refresh')}
                onClick={() => void refresh()} disabled={loading || !!busy || !root}><RotateCw size={14} className={loading ? 'csl-spin' : undefined} /></button>}
            </div>
            {canImport && <button className="csl-import" type="button" onClick={() => void importProject()} disabled={!!busy}>
              {busy === 'import' ? <Loader2 size={15} className="csl-spin" /> : <FolderOpen size={15} />}
              {t(busy === 'import' ? 'csl.importing' : 'csl.import')}
            </button>}
            {allProjects.length > 0 && <div className="csl-search"><Search size={14} />
              <input type="search" aria-label={t('csl.search')} placeholder={t('csl.search')} value={search} onChange={(e) => setSearch(e.target.value)} />
              {search && <button className="csl-icon-button" type="button" aria-label={t('csl.clearSearch')} onClick={() => setSearch('')}><X size={12} /></button>}
            </div>}
            {listError && <p className="csl-error" role="alert">{t('csl.listFailed')}</p>}
            {loading && allProjects.length === 0 ? <p className="csl-status" role="status"><Loader2 size={16} className="csl-spin" />{t('csl.projectsLoading')}</p>
              : listError && allProjects.length === 0 ? null
                : !canList ? <p className="csl-status">{t('csl.hostUnavailable')}</p>
                  : allProjects.length === 0 ? <div className="csl-empty"><Folder size={24} /><strong>{t('csl.emptyTitle')}</strong><p>{t('csl.emptyHint')}</p></div>
                    : <div className="csl-project-list">
                      {filtered.map((project) => <button type="button" key={project.path} className="csl-project" title={project.path}
                        onClick={() => onOpen(project.path, project.name)} disabled={!!busy}>
                        <Folder size={16} /><span>{project.name}</span><ArrowRight size={13} />
                      </button>)}
                      {filtered.length === 0 && <p className="csl-status">{t('csl.noResults')}</p>}
                    </div>}
          </aside>
        </div>
      </div>
    </div>
  )
}

export default ProjectLaunchpad
