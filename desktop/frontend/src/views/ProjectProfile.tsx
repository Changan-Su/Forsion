import { useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, Check, ChevronRight, Copy, ExternalLink, FileText, Folder, FolderGit2, FolderOpen, GitBranch, GitBranchPlus, GitCommitHorizontal, ImageUp, Loader2, MessageSquarePlus, Plus, RefreshCw, Search, Settings2, Smile, Sparkles, Star, TerminalSquare, Upload, Users, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useApp } from '../stores/appStore'
import { useI18n } from '../i18n'
import { createProjectSkill, deleteProjectIcon, generateGitCommitMessage, getGitSettings, getProjectContext, gitCommitProject, gitCreateProjectBranch, gitInitProject, gitPendingProject, gitPushProject, gitTrustProject, initProjectContext, putProjectDoc, putProjectSettings, setProjectIconEmoji, uploadProjectIcon } from '../services/backendService'
import { askString } from '../amadeus/components/askString'
import { normPath } from './coding/studioModel'
import type { AgentConfig, NormalAgentDef, ProjectContext, ProjectSettings, SessionRecord, TeamDef } from '../types'
import { isTeamImageAvatar, sessionWorkspaceKey, THINKING_LEVELS } from '../types'
import { ProfileModelField, ProfileTextEditor } from './profileControls'
import { AvatarStack } from '../components/AvatarStack'
import { openSpecial } from './SpecialViews'
import { openTerminal } from '../builtins'
import { isProjectWorkspace, type ProjectWorkspace } from '../stores/projectSettings'
import { projectExecutors, shortenPath, type ProjectExecutor } from './projectProfileState'
import { formatRelative } from '../format/time'
import './projectProfileMessages'
import './teamProfile.css'
import './projectProfile.css'
import { AgentAvatar } from '../components/AgentAvatar'
import { ProjectIcon } from '../components/ProjectIcon'
import { IconPicker } from '@amadeus/chrome/pageChrome'
import { thinkingLabel } from '../components/thinkingLabel'

type Tab = 'agents' | 'settings' | 'git'
const TABS: Array<{ id: Tab; icon: typeof Users }> = [{ id: 'agents', icon: Users }, { id: 'settings', icon: Settings2 }, { id: 'git', icon: GitBranch }]

type Props = {
  session: SessionRecord
  config: AgentConfig
  workspace: ProjectWorkspace
  renderAgent: (agent: NormalAgentDef, sessionId?: string | null) => ReactNode
  renderTeam: (session: SessionRecord, config: AgentConfig) => ReactNode
  /** 「当前会话」标记跟谁:缺省 = session。侧栏「查看详情」打开时 session 只是借来的载体(引擎端点按 sessionId 绑定),传真正的当前会话。 */
  currentSessionId?: string | null
}

/** 当前会话所属的 Project(侧栏分组口径:非系统的本地目录);不是 → null。选择器只吐一个字符串签名,`workspaces()` 每次都造新对象,
 *  直接返回它会让面板随每个 store 更新重渲。 */
export function useProjectWorkspace(session?: SessionRecord | null): ProjectWorkspace | null {
  const signature = useApp((a) => {
    if (!session?.project_path || session.projectless) return ''
    const all = a.workspaces()
    const ws = all.find((w) => w.key === sessionWorkspaceKey(session, all))
    // 家目录不行:引擎的 isForbiddenProjectDir 拒绝它(默认工作区没配置时回落家目录,或旧别名会话就在家目录)→ 照旧 Agent 详情。
    // 判的是**会话自己的**路径:引擎按 sessionId 绑定的就是它。
    return isProjectWorkspace(ws) && session.project_path !== a.homeDir ? JSON.stringify({ key: ws.key, name: ws.name, path: ws.path, system: ws.system, isDefault: ws.isDefault, sessionKeys: ws.sessionKeys }) : ''
  })
  return useMemo(() => (signature ? { ...(JSON.parse(signature) as Omit<ProjectWorkspace, 'kind'>), kind: 'local' as const } : null), [signature])
}

/** 侧栏「查看详情」指定的项目(不看当前会话):按路径找工作区,借它最近的一条会话当载体。没有会话可借 → null。 */
export function useProjectSubject(path: string | null): { workspace: ProjectWorkspace; carrierId: string } | null {
  const signature = useApp((a) => {
    if (!path || path === a.homeDir) return ''
    const ws = a.workspaces().find((w) => w.path === path)
    const carrier = [...a.sessions, ...a.archivedSessions].find((x) => x.project_path === path && !x.projectless)
    return isProjectWorkspace(ws) && carrier ? JSON.stringify({ ws: { key: ws.key, name: ws.name, path: ws.path, system: ws.system, isDefault: ws.isDefault, sessionKeys: ws.sessionKeys }, carrierId: carrier.id }) : ''
  })
  return useMemo(() => {
    if (!signature) return null
    const v = JSON.parse(signature) as { ws: Omit<ProjectWorkspace, 'kind'>; carrierId: string }
    return { workspace: { ...v.ws, kind: 'local' as const }, carrierId: v.carrierId }
  }, [signature])
}

/** 引擎 git 动作的机器码(services/gitActions.ts);有词条的按当前语言说,没有的回落引擎原文。 */
const GIT_ERROR_CODES = new Set([
  'git_unavailable', 'git_timeout', 'git_failed', 'not_repo', 'already_repo', 'nothing_to_commit', 'empty_message', 'message_too_long',
  'embedded_repo', 'too_many_files', 'large_files', 'no_identity', 'invalid_branch', 'detached', 'no_remote', 'ambiguous_remote', 'no_model', 'quota_exceeded',
  'shared_workspace', 'nested_repo', 'untrusted_config', 'credential_files', 'git_too_old', 'changes_changed', 'hook_changed_commit',
])
type GitErr = { message: string; info?: string; retry?: () => void }

/** PROJECT 详情:骨架与 TEAM 详情同一套(头部即基本信息 / 滑块导航 / 一个滚动体 / 底部保存栏),内容换成项目的三面:
 *  Agents(谁在这里工作过)/ 配置(指令文件 · 项目技能 · 计划 · 本机默认项)/ Git(现场 + 用户点的建仓 / 提交 / 建分支 / 推送)。数据全部来自引擎的 project-context,
 *  它读到什么就显示什么 —— 这个面板存在的意义就是回答「Tangu 到底看没看见这个项目的约定」。 */
export function ProjectProfile({ session, config, workspace, renderAgent, renderTeam, currentSessionId }: Props) {
  const { t, locale } = useI18n()
  const s = useApp(useShallow((a) => ({
    cfg: a.cfg, agents: a.agentDefs, avatars: a.agentAvatars, teams: a.teams, teamAvatars: a.teamAvatars, engines: a.engines, models: a.modelsResp?.models,
    sessions: a.sessions, archived: a.archivedSessions, configBySession: a.configBySession, runningBySession: a.runningBySession,
    defaultSlug: a.defaultAgentSlug, connected: a.connState === 'ok', homeDir: a.homeDir,
  })))
  // 这个会话实际工作的目录 = 引擎按 sessionId 绑定的那个。默认工作区换过位置时,旧会话的目录(别名)≠ 组的当前路径:
  // 显示、读写、设置缓存一律跟会话走;只有「用它开新会话」落在组的当前目录(startWith 用 workspace)。
  const dir = session.project_path || workspace.path
  const [ctx, setCtx] = useState<ProjectContext | null>(null)
  const [loadError, setLoadError] = useState('')
  const [reloadAt, setReloadAt] = useState(0)
  const [tab, setTab] = useState<Tab>('agents')
  const [selected, setSelected] = useState('')
  const [opened, setOpened] = useState<string[]>([])
  const [picker, setPicker] = useState(false)
  const [query, setQuery] = useState('')
  const [nameDraft, setNameDraft] = useState(workspace.name)
  const [docDraft, setDocDraft] = useState('')
  const [docDirty, setDocDirty] = useState(false)
  const [settingsDraft, setSettingsDraft] = useState<ProjectSettings>({})
  const [settingsDirty, setSettingsDirty] = useState(false)
  const [skillForm, setSkillForm] = useState<{ slug: string; name: string; description: string; content: string } | null>(null)
  const [iconPick, setIconPick] = useState<{ x: number; y: number } | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  // Git 页:提交框(null = 收起)、生成中、带原文的 git 失败(git 的 stderr / 被点名的文件,显示在 Git 卡片里而不是底栏)
  const [commitDraft, setCommitDraft] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [gitErr, setGitErr] = useState<GitErr | null>(null)
  const [pending, setPending] = useState<{ files: Array<{ code: string; path: string; from?: string }>; total: number; stagedOnly: boolean; token: string; tooMany?: boolean } | null>(null)
  const genSeq = useRef(0)
  // 写动作的两处禁区(只读摘要照常):① 默认工作区 —— 所有不在项目里的对话共用、常在笔记库里,建仓 / 整目录提交 = 把整片笔记收进仓
  //   (引擎 gitActions 也拒,这里是第一道);② 编码工作室托管的项目(~/Forsion/Project/<项目>)—— 版本由宿主在「版本」面板里管,
  //   这里再按用户口径提交 / 建分支 = 两个驱动方改同一个仓。
  const [managedRoot, setManagedRoot] = useState('')
  useEffect(() => { let alive = true; void window.tangu?.codeProjectsRoot?.().then((root) => { if (alive) setManagedRoot(root || '') }).catch(() => {}); return () => { alive = false } }, [])
  // ③ 项目是更大仓库的子目录:写动作只在仓库根上做(add -A 会暂存整个父仓),引擎也拒(nested_repo)。
  const gitReadOnly: 'shared' | 'managed' | 'nested' | null = workspace.isDefault || workspace.system ? 'shared'
    : managedRoot && normPath(dir).replace(/\/[^/]*$/, '') === normPath(managedRoot) ? 'managed'
    : ctx?.git.nested ? 'nested' : null
  const now = Date.now()

  const current = currentSessionId === undefined ? session.id : currentSessionId
  const executors = useMemo(() => projectExecutors({
    sessions: [...s.sessions, ...s.archived], projectPath: dir, aliases: workspace.sessionKeys, configBySession: s.configBySession,
    runningBySession: s.runningBySession, defaultSlug: s.defaultSlug, currentSessionId: current,
  }), [s.sessions, s.archived, s.configBySession, s.runningBySession, s.defaultSlug, dir, workspace.sessionKeys, current])
  const running = executors.some((e) => e.running)
  const sessionRunning = !!s.runningBySession[session.id]

  useEffect(() => { setNameDraft(workspace.name) }, [workspace.name])
  useEffect(() => {
    let alive = true
    setLoadError('')
    void getProjectContext(s.cfg, session.id).then((value) => {
      if (!alive) return
      setCtx(value)
      useApp.getState().rememberProjectSettings(dir, value.settings)
    }).catch((e) => { if (alive) setLoadError(e?.status === 404 ? t('projectProfile.localOnly') : String(e?.message || e)) })
    return () => { alive = false }
  }, [s.cfg, session.id, dir, reloadAt]) // eslint-disable-line react-hooks/exhaustive-deps
  // 这个项目里的 run 刚结束(比如「让 Tangu 生成」写完了 AGENTS.md)→ 重拉;编辑中的草稿不动。
  const wasRunning = useRef(running)
  useEffect(() => { if (wasRunning.current && !running) setReloadAt((n) => n + 1); wasRunning.current = running }, [running])
  useEffect(() => { if (!docDirty) setDocDraft(ctx?.doc.content ?? '') }, [ctx?.doc.content, docDirty])
  useEffect(() => { if (!settingsDirty) setSettingsDraft(ctx?.settings ?? {}) }, [ctx?.settings, settingsDirty])

  const dirty = docDirty || settingsDirty
  const relDoc = ctx ? ctx.doc.path.startsWith(`${ctx.cwd}/`) ? ctx.doc.path.slice(ctx.cwd.length + 1) : ctx.doc.path : ''
  const skillsDir = ctx ? `${ctx.workspaceDirName}/skills` : ''
  const clear = () => { setError(''); setNotice('') }
  const open = (key: string) => { setSelected(key); setOpened((keys) => (keys.includes(key) ? keys : [...keys, key])) }
  const reveal = (p: string) => { void window.tangu?.revealHostPath?.(p) }
  const copyPath = () => { void navigator.clipboard?.writeText(dir).then(() => { setNotice(t('projectProfile.copied')) }) }
  const commitName = async () => {
    const name = nameDraft.trim()
    if (workspace.system || !name || name === workspace.name) { setNameDraft(workspace.name); return }
    await useApp.getState().renameWorkspace(workspace, name)
  }
  const patchSettings = (value: Partial<ProjectSettings>) => { setSettingsDraft((d) => ({ ...d, ...value })); setSettingsDirty(true); clear() }
  const execValue = settingsDraft.defaultAgent ? `agent:${settingsDraft.defaultAgent}` : settingsDraft.defaultTeam ? `team:${settingsDraft.defaultTeam}` : ''
  const setExec = (value: string) => {
    const [kind, id] = value.split(':')
    patchSettings({ defaultAgent: kind === 'agent' ? id : undefined, defaultTeam: kind === 'team' ? id : undefined })
  }

  /** 用某个执行者在这个项目里开新会话:落成「新对话草稿」(工作区 + 预选),会话在发送时才建 —— 不留空会话。 */
  const startWith = (target: { kind: 'agent'; slug: string } | { kind: 'team'; team: TeamDef }) => {
    const app = useApp.getState()
    app.setNewChatWs(workspace)
    app.setActiveId(null)
    if (target.kind === 'agent') { app.selectNewChatAgent(target.slug); app.setNewChatCfg((c) => ({ ...c, groupChat: undefined, groupAgents: undefined, teamRoles: undefined, teamDoc: undefined })) }
    else {
      const team = target.team
      app.setNewChatCfg((c) => ({ ...c, agentSlug: undefined, groupChat: true, groupAgents: team.members.map((m) => m.slug), teamRoles: Object.fromEntries(team.members.map((m) => [m.slug, m.role])), teamDoc: team.doc || undefined }))
    }
    setPicker(false); setQuery('')
  }
  /** 行内星标立即落盘。默认项是**一条**记录:配置页里还没保存的草稿一并带上(分开写会互相盖掉 —— 星标写完再点保存,旧草稿会把星标写回去),
   *  写完草稿即与落盘一致,保存栏收起。 */
  const saveDefaultExecutor = async (value: Pick<ProjectSettings, 'defaultAgent' | 'defaultTeam'>) => {
    if (busy) return
    setBusy('default'); clear()
    try {
      const saved = await putProjectSettings(s.cfg, session.id, { ...(settingsDirty ? settingsDraft : ctx?.settings || {}), defaultAgent: undefined, defaultTeam: undefined, ...value })
      setCtx((c) => (c ? { ...c, settings: saved } : c))
      setSettingsDraft(saved ?? {}); setSettingsDirty(false)
      useApp.getState().rememberProjectSettings(dir, saved)
      setNotice(t('projectProfile.saved'))
    } catch (e: any) { setError(String(e?.message || e)) } finally { setBusy('') }
  }
  // 图标即时落盘(与名称同一习惯,不走保存栏),只经 icon 端点改 —— PUT settings 在引擎侧保留 icon 现值,保存栏里的草稿碰不到它;
  // 这里只把 icon 并进草稿,别的未保存改动留着。
  const icon = ctx?.settings?.icon
  const applyIcon = (saved: ProjectSettings | null) => {
    setCtx((c) => (c ? { ...c, settings: saved } : c))
    setSettingsDraft((d) => ({ ...d, icon: saved?.icon }))
    useApp.getState().rememberProjectSettings(dir, saved)
    void useApp.getState().loadProjectIcon(dir, true) // 换图 → 拉新图;换 emoji / 移除 → 404,旧 objectURL 随之回收
  }
  const pickIconImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || busy) return
    if (file.size > 1_048_576) { setError(t('projectProfile.iconTooLarge')); return }
    setBusy('icon'); clear()
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error || new Error('read failed'))
        reader.readAsDataURL(file)
      })
      applyIcon(await uploadProjectIcon(s.cfg, session.id, dataUrl))
      setNotice(t('projectProfile.iconSaved'))
    } catch (e: any) { setError(String(e?.message || e)) } finally { setBusy('') }
  }
  /** emoji → 设为图标;null(选择器里的「移除图标」)→ 回默认。原来是导入的图片由引擎一并删掉(图片住在项目目录里,不留孤儿文件)。 */
  const pickIconEmoji = async (emoji: string | null) => {
    setIconPick(null)
    if (busy || (emoji ?? undefined) === icon) return
    setBusy('icon'); clear()
    try {
      applyIcon(await (emoji ? setProjectIconEmoji(s.cfg, session.id, emoji) : deleteProjectIcon(s.cfg, session.id)))
      setNotice(t(emoji ? 'projectProfile.iconSaved' : 'projectProfile.iconRemoved'))
    } catch (e: any) { setError(String(e?.message || e)) } finally { setBusy('') }
  }
  const init = async () => {
    if (busy) return
    setBusy('init'); clear()
    try {
      const r = await initProjectContext(s.cfg, session.id)
      setCtx(r.context)
      setNotice(t('projectProfile.initialized', { dir: r.context.workspaceDirName }))
    } catch (e: any) { setError(String(e?.message || e)) } finally { setBusy('') }
  }
  // ── Git 动作(用户点了才做;引擎按 sessionId 绑定目录,做完连同新的上下文一起回)──
  /** 失败的四种样子:① 带机器码 → 本地化(untrusted_config 附「信任并继续」= 带 trust 重跑同一个动作);② 404 = 引擎太旧;
   *  ③ 其余 4xx → 引擎原话;④ 超时 / 断连 / 5xx → 动作可能已经做完:如实说「结果未确认」并重读状态,别让用户照「失败」去重试
   *  (重试 = 重复提交、再跑一遍钩子)。 */
  const gitErrorOf = (e: any, retry?: () => void): GitErr => {
    // git 进程超时(引擎回的是 400 + git_timeout):提交 / 推送可能已经做完了 —— 与断连同样按「结果未确认」处理并重读
    if (e?.code === 'git_timeout') { setReloadAt((n) => n + 1); return { message: t('projectProfile.git.unconfirmed'), info: typeof e?.info === 'string' ? e.info : undefined } }
    // 提交已经落下但复核不过(钩子加了清单外的东西)/ 提交过程中仓库被别的东西改了、没法确认:不猜、不撤,说清楚并重读
    if (e?.code === 'commit_unverified' || e?.code === 'hook_changed_commit') { setReloadAt((n) => n + 1); return { message: t(`projectProfile.git.err.${e.code}`), info: typeof e?.info === 'string' ? e.info : undefined } }
    if (typeof e?.code === 'string') return {
      message: GIT_ERROR_CODES.has(e.code) ? t(`projectProfile.git.err.${e.code}`) : String(e?.message || e),
      info: typeof e?.info === 'string' && e.info ? e.info : undefined,
      ...(e.code === 'untrusted_config' && retry ? { retry } : {}),
    }
    if (e?.status === 404) return { message: t('projectProfile.git.err.unsupported') }
    if (e?.status && e.status < 500) return { message: String(e?.message || e) }
    setReloadAt((n) => n + 1)
    return { message: t('projectProfile.git.unconfirmed'), info: String(e?.message || e) }
  }
  /** 动作做完但引擎没读出新上下文(context:null)→ 照成功处理,自己重读。 */
  const applyContext = (value: ProjectContext | null) => { if (value) setCtx(value); else setReloadAt((n) => n + 1) }
  const gitRun = async <T,>(key: string, action: (trust: boolean) => Promise<T>, done: (value: T) => void, trust = false): Promise<void> => {
    if (busy) return
    setBusy(key); clear(); setGitErr(null)
    try { done(await action(trust)) }
    catch (e: any) { setGitErr(gitErrorOf(e, () => { void gitRun(key, action, done, true) })) }
    finally { setBusy('') }
  }
  const gitInit = () => gitRun('git-init', () => gitInitProject(s.cfg, session.id), (r) => {
    applyContext(r.context)
    setNotice(t(r.createdGitignore ? 'projectProfile.git.initDoneIgnore' : 'projectProfile.git.initDone'))
  })
  const trustRepo = () => gitRun('git-trust', () => gitTrustProject(s.cfg, session.id), (r) => {
    applyContext(r.context)
    setNotice(t('projectProfile.git.trustedNotice'))
  })
  /** 让会话自己的模型写提交信息。关掉提交框 / 再点一次 → 旧的那次回来也不落(genSeq)。 */
  const generateMessage = async (trust = false) => {
    const seq = ++genSeq.current
    setGenerating(true); setGitErr(null)
    try {
      const message = await generateGitCommitMessage(s.cfg, session.id, trust)
      if (seq === genSeq.current) setCommitDraft((d) => (d === null ? d : message))
    } catch (e: any) {
      if (seq === genSeq.current) setGitErr(gitErrorOf(e, () => { void generateMessage(true) }))
    } finally {
      if (seq === genSeq.current) setGenerating(false)
    }
  }
  /** 打开提交框:先拿这次会提交的**完整**清单(有已暂存的只列已暂存的)给用户过目,再让模型写信息。 */
  const openCommit = async (trust = false) => {
    clear(); setGitErr(null); setCommitDraft(''); setPending(null)
    const seq = ++genSeq.current
    setGenerating(true)
    try {
      const list = await gitPendingProject(s.cfg, session.id, trust)
      if (seq !== genSeq.current) return
      setPending(list)
      if (!list.total) { setCommitDraft(null); setGitErr({ message: t('projectProfile.git.err.nothing_to_commit') }); return }
      const message = await generateGitCommitMessage(s.cfg, session.id, trust)
      if (seq === genSeq.current) setCommitDraft((d) => (d === null ? d : message))
    } catch (e: any) {
      if (seq === genSeq.current) setGitErr(gitErrorOf(e, () => { void openCommit(true) }))
    } finally {
      if (seq === genSeq.current) setGenerating(false)
    }
  }
  const closeCommit = () => { genSeq.current++; setGenerating(false); setCommitDraft(null); setPending(null); setGitErr(null) }
  const commit = () => {
    const message = commitDraft?.trim()
    if (!message) return
    void gitRun('git-commit', (trust) => gitCommitProject(s.cfg, session.id, message, pending?.token, trust).catch(async (e) => {
      // 看完之后改动又变了:重新列出这次会提交的东西(保留已写好的信息),让用户再过目一次
      if (e?.code === 'changes_changed') await gitPendingProject(s.cfg, session.id).then(setPending).catch(() => {})
      // 提交可能已经落下(复核不过 / 没法确认 / 超时 / 断连 / 5xx):收起提交框,再点一次 = 重复提交
      const landed = ['hook_changed_commit', 'commit_unverified', 'git_timeout'].includes(e?.code) || (typeof e?.code !== 'string' && !(e?.status && e.status < 500))
      if (landed) { setCommitDraft(null); setPending(null) }
      throw e
    }), (r) => {
      applyContext(r.context); setCommitDraft(null); setPending(null)
      setNotice(t(r.commit.stagedOnly ? 'projectProfile.git.committedStaged' : 'projectProfile.git.committed', { subject: r.commit.subject }))
    })
  }
  const newBranch = async () => {
    if (busy) return
    const prefix = await getGitSettings(s.cfg).then((r) => r.settings.branchPrefix).catch(() => '')
    const name = (await askString(t('projectProfile.git.newBranchTitle'), prefix, { label: t('projectProfile.git.newBranchLabel'), confirmLabel: t('projectProfile.git.newBranchConfirm') }))?.trim()
    if (!name || name === prefix) return
    await gitRun('git-branch', (trust) => gitCreateProjectBranch(s.cfg, session.id, name, trust), (r) => {
      applyContext(r.context)
      setNotice(t('projectProfile.git.branched', { branch: r.branch }))
    })
  }
  const push = () => gitRun('git-push', (trust) => gitPushProject(s.cfg, session.id, trust), (r) => {
    applyContext(r.context)
    setNotice(t('projectProfile.git.pushed', { target: r.target }))
  })
  const generate = () => {
    if (!ctx || sessionRunning) return
    clear()
    // 从侧栏「查看详情」进来时载体不是当前会话:先切过去,生成过程用户看得见(切会话会让右栏回到跟随,仍是这个项目)
    if (current !== session.id) useApp.getState().setActiveId(session.id)
    void useApp.getState().send(t('projectProfile.generatePrompt', { file: relDoc }), [], undefined, undefined, undefined, session.id)
    setNotice(t('projectProfile.generateSent'))
  }
  const save = async () => {
    if (busy || !dirty || !ctx) return
    setBusy('save'); clear()
    try {
      if (docDirty) {
        const r = await putProjectDoc(s.cfg, session.id, docDraft, ctx.doc.mtimeMs)
        setCtx((c) => (c ? { ...c, doc: { ...c.doc, path: r.path, exists: true, content: docDraft, mtimeMs: r.mtimeMs, bytes: new TextEncoder().encode(docDraft).length } } : c))
        setDocDirty(false)
      }
      if (settingsDirty) {
        const saved = await putProjectSettings(s.cfg, session.id, settingsDraft)
        setCtx((c) => (c ? { ...c, settings: saved } : c))
        useApp.getState().rememberProjectSettings(dir, saved)
        setSettingsDirty(false)
      }
      setNotice(t('projectProfile.saved'))
    } catch (e: any) { setError(e?.status === 409 ? t('projectProfile.docConflict') : String(e?.message || e)) } finally { setBusy('') }
  }
  const submitSkill = async () => {
    if (!skillForm || busy) return
    setBusy('skill'); clear()
    try {
      await createProjectSkill(s.cfg, session.id, skillForm)
      setSkillForm(null)
      setReloadAt((n) => n + 1)
      setNotice(t('projectProfile.skillCreated'))
    } catch (e: any) { setError(String(e?.message || e)) } finally { setBusy('') }
  }

  const agentOf = (slug: string) => s.agents.find((a) => a.slug === slug)
  const teamOf = (slug: string) => s.teams.find((team) => team.slug === slug)
  const executorLabel = (ex: ProjectExecutor): string => ex.kind === 'agent' ? agentOf(ex.id)?.name || ex.id
    : ex.kind === 'team' ? teamOf(ex.id)?.name || ex.id
    : ex.kind === 'party' ? ex.sessions[0]?.title || t('projectProfile.party')
    : s.engines.find((e) => e.id === ex.id)?.name || ex.id
  const executorPortrait = (ex: ProjectExecutor): ReactNode => {
    if (ex.kind === 'agent') return <AgentAvatar name={agentOf(ex.id)?.name || ex.id} url={s.avatars[ex.id]} fill />
    if (ex.kind === 'engine') return <TerminalSquare size={26} strokeWidth={1.2} />
    const team = ex.kind === 'team' ? teamOf(ex.id) : undefined
    if (team && s.teamAvatars[team.slug] && isTeamImageAvatar(team.avatar)) return <img src={s.teamAvatars[team.slug]} alt="" />
    if (team?.avatar && !isTeamImageAvatar(team.avatar)) return <span aria-hidden="true">{team.avatar}</span>
    const cfg = s.configBySession[ex.sessions[0]?.id] || ex.sessions[0]?.agent_config
    const slugs = team ? team.members.map((m) => m.slug) : cfg?.groupAgents || []
    return slugs.length ? <AvatarStack size={38} items={slugs.map((slug) => ({ slug, name: agentOf(slug)?.name || slug, avatarUrl: s.avatars[slug] }))} /> : <Users size={26} strokeWidth={1.2} />
  }
  const isDefault = (ex: ProjectExecutor) => (ex.kind === 'agent' && ctx?.settings?.defaultAgent === ex.id) || (ex.kind === 'team' && ctx?.settings?.defaultTeam === ex.id)
  const q = query.trim().toLowerCase()
  const listed = new Set(executors.map((ex) => ex.key))
  const agentCandidates = s.agents.filter((a) => a.createdBy !== 'system' && !listed.has(`agent:${a.slug}`) && `${a.name} ${a.description} ${a.slug}`.toLowerCase().includes(q))
  const teamCandidates = s.teams.filter((team) => !listed.has(`team:${team.slug}`) && team.members.length >= 2 && `${team.name} ${team.description} ${team.slug}`.toLowerCase().includes(q))
  const git = ctx?.git
  const changeCount = git?.repo ? git.changesTotal ?? 0 : 0
  const docStatus = !ctx ? null : !ctx.doc.exists ? <span className="project-chip">{t('projectProfile.docMissing')}</span>
    : <>{ctx.doc.truncated ? <span className="project-chip warn">{t('projectProfile.docTruncated')}</span> : <span className="project-chip ok"><Check size={11} />{t('projectProfile.docActive')}</span>}
      {ctx.doc.sources.length > 1 && <span className="project-chip" title={ctx.doc.sources.filter((p) => p !== ctx.doc.path).join('\n')}>{t('projectProfile.docOthers', { count: ctx.doc.sources.length - 1 })}</span>}</>

  // 「当前会话」那一行点开 = 真正的当前会话:跟随模式下就是 session(用传进来的实时 config);侧栏「查看详情」时 session 只是借来的载体
  const currentOf = (ex: ProjectExecutor): SessionRecord | undefined => (!ex.current ? undefined : current === session.id ? session : ex.sessions.find((x) => x.id === current))
  const detailFor = (ex: ProjectExecutor): ReactNode => {
    const cur = currentOf(ex)
    if (ex.kind === 'agent') { const agent = agentOf(ex.id); return agent ? renderAgent(agent, cur ? cur.id : ex.sessions[0]?.id) : null }
    if (ex.kind === 'team' || ex.kind === 'party') {
      const target = cur || ex.sessions[0]
      return target ? renderTeam(target, (target === session ? config : s.configBySession[target.id]) || target.agent_config || {}) : null
    }
    return null
  }

  return <section className="team-profile project-profile" data-project-profile={dir}>
    <div className="team-profile-main" hidden={!!selected}>
      <header className="team-profile-hero">
        {/* 图标与 TEAM 头部同一套:点图标导入图片(存进项目的 .tangu/),角上笑脸开 emoji 选择器(内含「移除图标」)。 */}
        <div className="agent-portrait-slot">
          <label className="team-profile-emblem agent-portrait-edit" title={t('projectProfile.iconImageHint', { dir: ctx?.workspaceDirName || '.tangu' })} aria-busy={busy === 'icon' || undefined}>
            <ProjectIcon path={dir} fallback={git?.repo ? <FolderGit2 size={26} strokeWidth={1.5} /> : <Folder size={26} strokeWidth={1.5} />} />
            <span className="agent-portrait-badge" aria-hidden="true">{busy === 'icon' ? <Loader2 size={10} className="spin" /> : <ImageUp size={10} />}</span>
            <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" aria-label={t('projectProfile.iconChange')} disabled={!!busy || !ctx} onChange={(e) => void pickIconImage(e)} />
          </label>
          <button type="button" className="agent-portrait-remove" data-project-icon-emoji title={t('projectProfile.iconEmoji')} aria-label={t('projectProfile.iconEmoji')} disabled={!!busy || !ctx} onClick={(e) => setIconPick({ x: e.clientX, y: e.clientY })}><Smile size={10} /></button>
        </div>
        {/* 选择器自身是 position:fixed 却不 portal;右栏祖先带 backdrop-filter 会把 fixed 的参照系换掉 → 挂到 body。 */}
        {iconPick && createPortal(<IconPicker x={iconPick.x} y={iconPick.y} current={icon ?? null} onPick={(em) => void pickIconEmoji(em)} onClose={() => setIconPick(null)} />, document.body)}
        <div className="team-profile-identity"><h3>{t('projectProfile.kind')}</h3>
          <input className="agent-character-name team-profile-name" aria-label={t('projectProfile.name')} title={workspace.name} value={nameDraft} maxLength={100} disabled={!!busy} readOnly={!!workspace.system}
            onChange={(e) => setNameDraft(e.target.value)} onBlur={() => void commitName()} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); else if (e.key === 'Escape') { setNameDraft(workspace.name); e.currentTarget.blur() } }} />
          <span className={`agent-state${running ? ' working' : ''}`}><i />{t(!s.connected ? 'agentProfile.offline' : running ? 'projectProfile.status.working' : 'projectProfile.status.idle')}
            <span>· {t('projectProfile.sessions', { count: executors.reduce((n, ex) => n + ex.sessions.length, 0) })}</span>
            {git?.repo && <span className="project-branch" title={git.detached ? t('projectProfile.git.detached') : git.branch}><GitBranch size={10} /><span>{git.branch}</span>{changeCount > 0 && <span>*</span>}</span>}
          </span></div>
        <button className="profile-expand" title={t('projectProfile.open')} aria-label={t('projectProfile.open')} onClick={() => openSpecial('workspace', workspace.key)}><ExternalLink size={15} /></button>
      </header>
      <p className="team-profile-location project-profile-path"><button type="button" title={dir} onClick={() => reveal(dir)}>{shortenPath(dir, s.homeDir)}</button></p>
      <nav className="agent-section-nav" style={{ '--profile-tab-count': TABS.length, '--profile-tab-index': TABS.findIndex((item) => item.id === tab) } as CSSProperties} aria-label={t('projectProfile.navigation')} role="tablist" onKeyDown={(e) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
        e.preventDefault()
        const index = TABS.findIndex((x) => x.id === tab)
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length
        setTab(TABS[next].id); (e.currentTarget.children[next] as HTMLElement).focus()
      }}>{TABS.map(({ id, icon: Icon }) => <button key={id} role="tab" aria-selected={tab === id} tabIndex={tab === id ? 0 : -1} className={tab === id ? 'selected' : ''} onClick={() => setTab(id)}><Icon size={14} /><span>{t(`projectProfile.tab.${id}`)}</span></button>)}</nav>
      <fieldset disabled={!!busy} className="team-profile-fields" key={tab}>
        {loadError && <p className="agent-profile-error" role="alert" style={{ paddingTop: 16 }}>{loadError} <button className="profile-text-action" onClick={() => setReloadAt((n) => n + 1)}>{t('projectProfile.retry')}</button></p>}
        {tab === 'agents' && <>
          <div className="team-lineup-toolbar"><p className="team-profile-caption">{t('projectProfile.agentsHint')}</p><button className="team-member-add" onClick={() => setPicker(!picker)} aria-expanded={picker}><Plus size={24} strokeWidth={1.5} /><span>{t('projectProfile.add')}</span></button></div>
          {picker && <div className="team-candidate-picker"><div className="team-candidate-heading"><label className="agents-search"><Search size={13} /><input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} aria-label={t('agentProfile.search')} placeholder={t('agentProfile.search')} /></label><button aria-label={t('projectProfile.closePicker')} onClick={() => setPicker(false)}><X size={14} /></button></div>
            <p className="team-profile-caption">{t('projectProfile.addHint')}</p>
            <div className="team-candidates project-candidates">
              {agentCandidates.map((a) => <button key={a.slug} onClick={() => startWith({ kind: 'agent', slug: a.slug })}><AgentAvatar name={a.name || a.slug} url={s.avatars[a.slug]} size={16} className="agent-avatar-mini" /><span><strong>{a.name}</strong><small>{a.description}</small></span><MessageSquarePlus size={14} /></button>)}
              {teamCandidates.map((team) => <button key={team.slug} onClick={() => startWith({ kind: 'team', team })}><Users size={16} /><span><strong>{team.name}</strong><small>{team.description || team.members.map((m) => agentOf(m.slug)?.name || m.slug).join(' · ')}</small></span><MessageSquarePlus size={14} /></button>)}
              {!agentCandidates.length && !teamCandidates.length && <p className="agent-profile-muted">{t('projectProfile.noCandidates')}</p>}
            </div></div>}
          <div className="team-lineup">{executors.map((ex) => {
            const canOpen = ex.kind !== 'engine' && (ex.kind !== 'agent' || !!agentOf(ex.id))
            const team = ex.kind === 'team' ? teamOf(ex.id) : undefined
            return <article className="team-member project-executor" key={ex.key} data-project-executor={ex.key}>
              <button className="team-member-open" disabled={!canOpen} onClick={() => open(ex.key)} aria-label={[`${t('projectProfile.inspect')} ${executorLabel(ex)}`, ex.current && t('projectProfile.current'), isDefault(ex) && t('projectProfile.isDefault')].filter(Boolean).join(' · ')}>
                <span className="team-member-portrait">{executorPortrait(ex)}</span>
                <strong><span>{executorLabel(ex)}</span>{(ex.current || isDefault(ex)) && <span className="project-executor-tags">{ex.current && <em className="project-executor-tag is-text" title={t('projectProfile.current')}>{t('projectProfile.current')}</em>}{isDefault(ex) && <em className="project-executor-tag" title={t('projectProfile.isDefault')}><Star size={10} /></em>}</span>}</strong>
                <span className={`team-member-status ${ex.running ? 'working' : 'idle'}`}>{t(ex.running ? 'projectProfile.status.working' : ex.kind === 'party' ? 'projectProfile.party' : ex.kind === 'engine' ? 'projectProfile.engine' : 'projectProfile.status.idle')} · {t('projectProfile.sessions', { count: ex.sessions.length })}{ex.lastActive ? ` · ${t('projectProfile.lastActive', { time: formatRelative(ex.lastActive, { now, locale }) })}` : ''}</span>
                {canOpen && <ChevronRight size={14} className="team-member-chevron" />}
              </button>
              {(ex.kind === 'agent' || (ex.kind === 'team' && team)) && <div className="project-inline-actions">
                <button type="button" onClick={() => (ex.kind === 'agent' ? startWith({ kind: 'agent', slug: ex.id }) : team && startWith({ kind: 'team', team }))}><MessageSquarePlus size={13} />{t('projectProfile.startWith')}</button>
                <button type="button" className={isDefault(ex) ? 'is-default' : ''} aria-pressed={isDefault(ex)} disabled={!ctx} onClick={() => void saveDefaultExecutor(isDefault(ex) ? {} : ex.kind === 'agent' ? { defaultAgent: ex.id } : { defaultTeam: ex.id })}><Star size={13} />{t(isDefault(ex) ? 'projectProfile.isDefault' : 'projectProfile.setDefault')}</button>
              </div>}
            </article>
          })}</div>
        </>}
        {tab === 'settings' && ctx && <div className="project-section">
          <section className="project-card" data-project-doc>
            <div className="project-card-head"><div><h3><FileText size={13} style={{ verticalAlign: -2, marginRight: 5 }} />{t('projectProfile.instructions')}</h3><small title={ctx.doc.path}>{relDoc}</small><div className="project-chips">{docStatus}</div></div>
              {ctx.doc.exists && <button type="button" title={t('projectProfile.reveal')} aria-label={t('projectProfile.reveal')} onClick={() => reveal(ctx.doc.path)}><FolderOpen size={14} /></button>}</div>
            {ctx.doc.exists && ctx.doc.tooLarge ? <p className="agent-profile-muted">{t('projectProfile.docTooLarge')}</p>
              : ctx.doc.exists || docDirty ? <ProfileTextEditor label={t('projectProfile.instructions')} rows={12} value={docDraft} maxLength={200000} placeholder={t('projectProfile.docEmpty')} onChange={(value) => { setDocDraft(value); setDocDirty(true); clear() }} hint={t('projectProfile.docHint', { names: 'AGENTS.md / CLAUDE.md' })} />
              : <>
                <p className="agent-profile-muted">{t('projectProfile.docEmpty')}</p>
                <div className="project-card-actions">
                  <button type="button" className="btn ghost sm" onClick={() => void init()}>{busy === 'init' ? <Loader2 size={13} className="spin" /> : <Plus size={13} />}{t('projectProfile.init', { file: relDoc })}</button>
                  <button type="button" className="btn primary sm" disabled={sessionRunning || !s.connected} title={sessionRunning ? t('projectProfile.generateBusy') : undefined} onClick={generate}><Sparkles size={13} />{t('projectProfile.generate')}</button>
                </div>
                <p className="agent-profile-muted">{t('projectProfile.docHint', { names: 'AGENTS.md / CLAUDE.md' })}</p>
              </>}
          </section>
          <section className="project-card" data-project-skills>
            <div className="project-card-head"><div><h3><Sparkles size={13} style={{ verticalAlign: -2, marginRight: 5 }} />{t('projectProfile.skills')}</h3><small>{t('projectProfile.skillsHint', { dir: skillsDir })}</small></div>
              <button type="button" title={t('projectProfile.openSkills')} aria-label={t('projectProfile.openSkills')} onClick={() => void (ctx.skills.length || busy ? Promise.resolve() : initProjectContext(s.cfg, session.id).then((r) => setCtx(r.context))).then(() => reveal(`${ctx.workspaceDir}/skills`))}><FolderOpen size={14} /></button></div>
            {ctx.skills.length ? <div className="project-list">{ctx.skills.map((skill) => <button type="button" key={`${skill.id}:${skill.legacy}`} className="project-row" title={skill.path} onClick={() => reveal(`${skill.path}/SKILL.md`)}><strong>{skill.name}</strong>{skill.legacy && <small className="project-chip warn">{t('projectProfile.legacySkill')}</small>}<span style={{ gridColumn: '1 / -1' }}>{skill.description || skill.id}</span></button>)}</div>
              : <p className="agent-profile-muted">{t('projectProfile.noSkills')}</p>}
            {skillForm ? <form className="project-skill-form" onSubmit={(e) => { e.preventDefault(); void submitSkill() }}>
              <label>{t('projectProfile.skillFolder')}<input required autoFocus pattern="[a-z0-9][a-z0-9-]*" placeholder="my-skill" value={skillForm.slug} onChange={(e) => setSkillForm({ ...skillForm, slug: e.target.value })} /></label>
              <label>{t('agentProfile.name')}<input required value={skillForm.name} onChange={(e) => setSkillForm({ ...skillForm, name: e.target.value })} /></label>
              <label>{t('agentProfile.description')}<input value={skillForm.description} onChange={(e) => setSkillForm({ ...skillForm, description: e.target.value })} /></label>
              <label>{t('agentProfile.prompt')}<textarea required rows={6} value={skillForm.content} onChange={(e) => setSkillForm({ ...skillForm, content: e.target.value })} /></label>
              <div><button type="button" className="btn ghost sm" onClick={() => setSkillForm(null)}>{t('agentProfile.cancel')}</button><button type="submit" className="btn primary sm" disabled={!skillForm.slug.trim() || !skillForm.name.trim() || !skillForm.content.trim()}>{busy === 'skill' && <Loader2 size={13} className="spin" />}{t('projectProfile.newSkill')}</button></div>
            </form> : <div className="project-card-actions"><button type="button" className="btn ghost sm" onClick={() => { clear(); setSkillForm({ slug: '', name: '', description: '', content: '' }) }}><Plus size={13} />{t('projectProfile.newSkill')}</button></div>}
          </section>
          {ctx.plans.length > 0 && <section className="project-card" data-project-plans>
            <div className="project-card-head"><div><h3>{t('projectProfile.plans')}</h3><small>{t('projectProfile.plansHint', { dir: `${ctx.workspaceDirName}/plans` })}</small></div></div>
            <div className="project-list">{ctx.plans.map((plan) => <button type="button" key={plan.path} className="project-row" title={plan.path} onClick={() => void window.tangu?.openHostPath?.(plan.path)}><strong>{plan.title || plan.name}</strong><small>{formatRelative(plan.mtimeMs, { now, locale })}</small></button>)}</div>
          </section>}
          <section className="project-card" data-project-defaults>
            <div className="project-card-head"><div><h3>{t('projectProfile.defaults')}</h3><small>{t('projectProfile.defaultsHint')}</small></div></div>
            <label className="project-field">{t('projectProfile.defaultExecutor')}<select value={execValue} onChange={(e) => setExec(e.target.value)}>
              <option value="">{t('projectProfile.defaultNone')}</option>
              <optgroup label={t('projectProfile.agents')}>{s.agents.filter((a) => a.createdBy !== 'system').map((a) => <option key={a.slug} value={`agent:${a.slug}`}>{a.name}</option>)}</optgroup>
              {s.teams.length > 0 && <optgroup label={t('projectProfile.teams')}>{s.teams.map((team) => <option key={team.slug} value={`team:${team.slug}`}>{team.name}</option>)}</optgroup>}
            </select></label>
            <label className="project-field">{t('agentProfile.approval')}<select value={settingsDraft.approvalMode || ''} onChange={(e) => patchSettings({ approvalMode: (e.target.value || undefined) as ProjectSettings['approvalMode'] })}>
              <option value="">{t('projectProfile.inherit')}</option>
              {([['readonly', 'readonly'], ['auto-edit', 'autoEdit'], ['full-auto', 'fullAuto'], ['custom', 'custom']] as const).map(([v, k]) => <option key={v} value={v}>{t(`agentProfile.${k}`)}</option>)}
            </select></label>
            <ProfileModelField models={(s.models || []).filter((m) => (m.modelType || 'llm') === 'llm')} value={settingsDraft.model || ''} label={t('agentProfile.model')} onChange={(model) => patchSettings({ model: model || undefined })} />
            <label className="project-field">{t('agentProfile.thinking')}<select value={settingsDraft.thinkingLevel || ''} onChange={(e) => patchSettings({ thinkingLevel: (e.target.value || undefined) as ProjectSettings['thinkingLevel'] })}>
              <option value="">{t('projectProfile.inherit')}</option>
              {THINKING_LEVELS.map((lv) => <option key={lv} value={lv}>{thinkingLabel(lv, t)}</option>)}
            </select></label>
          </section>
        </div>}
        {tab === 'git' && ctx && git && <div className="project-section">
          <section className="project-card" data-project-git>
            {!git.available ? <p className="agent-profile-muted">{t('projectProfile.git.unavailable')}</p>
              : !git.repo ? <div className="project-git-empty">
                <p className="agent-profile-muted">{t('projectProfile.git.none')}</p>
                {!gitReadOnly && <>
                  <p className="agent-profile-muted">{t('projectProfile.git.initHint')}</p>
                  <div className="project-card-actions"><button className="btn primary sm" data-git-action="init" disabled={!!busy} onClick={() => void gitInit()}>{busy === 'git-init' ? <Loader2 size={13} className="spin" /> : <FolderGit2 size={13} />}{t('projectProfile.git.init')}</button></div>
                </>}
              </div>
              : <div className="project-git-summary">
                <div><span>{t('projectProfile.git.branch')}</span><strong title={git.branch}>{git.branch}</strong>{git.detached && <span className="project-chip">{t('projectProfile.git.detached')}</span>}</div>
                <div><span>{t('projectProfile.git.upstream')}</span>{git.upstream ? <><strong title={git.upstream}>{git.upstream}</strong><span className="project-chip">{git.ahead || git.behind ? [git.ahead ? t('projectProfile.git.ahead', { count: git.ahead }) : '', git.behind ? t('projectProfile.git.behind', { count: git.behind }) : ''].filter(Boolean).join(' · ') : t('projectProfile.git.inSync')}</span></> : <strong className="agent-profile-muted">{t('projectProfile.git.noUpstream')}</strong>}</div>
                <div><span>{t('projectProfile.git.changes')}</span>{git.changesUnread ? <span className="project-chip warn">{t('projectProfile.git.unread')}</span> : changeCount ? <div className="project-chips">{!!git.staged && <span className="project-chip ok">{t('projectProfile.git.staged', { count: git.staged })}</span>}{!!git.unstaged && <span className="project-chip">{t('projectProfile.git.unstaged', { count: git.unstaged })}</span>}{!!git.untracked && <span className="project-chip">{t('projectProfile.git.untracked', { count: git.untracked })}</span>}</div> : <strong className="agent-profile-muted">{t('projectProfile.git.clean')}</strong>}</div>
                {git.remote && <div><span>{t('projectProfile.git.remote')}</span><strong title={git.remote}>{git.remote}</strong></div>}
              </div>}
            {git.repo && git.changesUnread && <div className="project-git-trust" data-project-git-untrusted>
              <p>{t('projectProfile.git.untrustedNote')}</p>
              {!!git.configRisks?.length && <pre>{git.configRisks.join('\n')}</pre>}
              <div className="project-card-actions"><button className="btn sm" data-git-action="trust" disabled={!!busy} onClick={() => void trustRepo()}>{busy === 'git-trust' && <Loader2 size={13} className="spin" />}{t('projectProfile.git.trust')}</button></div>
            </div>}
            {git.available && gitReadOnly && <p className="agent-profile-muted" data-project-git-readonly={gitReadOnly}>{t(gitReadOnly === 'shared' ? 'projectProfile.git.sharedNote' : gitReadOnly === 'managed' ? 'projectProfile.git.managedNote' : 'projectProfile.git.nestedNote')}</p>}
            {git.repo && !gitReadOnly && <div className="project-card-actions" data-project-git-write>
              <button className="btn primary sm" data-git-action="commit" disabled={!!busy || (!changeCount && !git.changesUnread) || commitDraft !== null} onClick={() => void openCommit()}><GitCommitHorizontal size={13} />{t('projectProfile.git.commit')}</button>
              <button className="btn sm" data-git-action="branch" disabled={!!busy} onClick={() => void newBranch()}>{busy === 'git-branch' ? <Loader2 size={13} className="spin" /> : <GitBranchPlus size={13} />}{t('projectProfile.git.newBranch')}</button>
              {(git.upstream || git.remote || !!git.remotes) && <button className="btn sm" data-git-action="push" disabled={!!busy || !!git.detached} title={git.detached ? t('projectProfile.git.err.detached') : undefined} onClick={() => void push()}>{busy === 'git-push' ? <Loader2 size={13} className="spin" /> : <Upload size={13} />}{git.ahead ? t('projectProfile.git.pushCount', { count: git.ahead }) : t('projectProfile.git.push')}</button>}
            </div>}
            {gitErr && <div className="project-git-error" role="alert" data-project-git-error><p>{gitErr.message}</p>{gitErr.info && <pre>{gitErr.info}</pre>}
              {gitErr.retry && <div className="project-card-actions"><button className="btn sm" data-git-action="trust-retry" onClick={() => { const retry = gitErr.retry!; setGitErr(null); retry() }}>{t('projectProfile.git.trustRetry')}</button></div>}
            </div>}
            <div className="project-inline-actions start" data-project-git-actions>
              <button type="button" onClick={() => openTerminal(dir)}><TerminalSquare size={13} />{t('projectProfile.terminal')}</button>
              <button type="button" onClick={() => reveal(dir)}><FolderOpen size={13} />{t('projectProfile.reveal')}</button>
              <button type="button" onClick={copyPath}><Copy size={13} />{t('projectProfile.copyPath')}</button>
              <button type="button" onClick={() => setReloadAt((n) => n + 1)}><RefreshCw size={13} />{t('projectProfile.refresh')}</button>
            </div>
          </section>
          {git.repo && !gitReadOnly && commitDraft !== null && <section className="project-card project-git-commit-form" data-project-git-commit-form>
            <div className="project-card-head"><div><h3>{t('projectProfile.git.commitTitle', { count: pending?.total ?? changeCount })}</h3><small>{t('projectProfile.git.commitHint')}</small></div></div>
            {pending && !!pending.total && <div className="project-git-files" data-project-git-files>
              <small>{t(pending.stagedOnly ? 'projectProfile.git.filesStaged' : 'projectProfile.git.filesAll', { count: pending.total })}</small>
              <ul>{pending.files.map((f) => { const label = f.from ? `${f.from} → ${f.path}` : f.path; return <li key={`${f.code}${f.path}`} title={label}><code>{f.code.trim() || '·'}</code><span>{label}</span></li> })}</ul>
              {pending.total > pending.files.length && <small>{t('projectProfile.git.more', { count: pending.total - pending.files.length })}</small>}
              {pending.tooMany && <p className="project-git-error" data-project-git-toomany>{t('projectProfile.git.tooManyToList')}</p>}
            </div>}
            <textarea className="project-git-message" rows={4} value={commitDraft} disabled={generating || busy === 'git-commit'} aria-label={t('projectProfile.git.messageLabel')}
              placeholder={t(generating ? 'projectProfile.git.generating' : 'projectProfile.git.messagePlaceholder')} onChange={(e) => setCommitDraft(e.target.value)} />
            <div className="project-card-actions">
              <button className="btn sm" data-git-action="regenerate" disabled={generating || !!busy || !pending?.total} onClick={() => void generateMessage()}>{generating ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}{t('projectProfile.git.regenerate')}</button>
              {/* 取消与提交成组靠右:窄栏里折行时整组一起下去,不会把「提交」单独甩到下一行最左边 */}
              <div className="project-git-commit-confirm">
                <button className="btn sm" disabled={busy === 'git-commit'} onClick={closeCommit}>{t('common.cancel')}</button>
                <button className="btn primary sm" data-git-action="commit-confirm" disabled={!commitDraft.trim() || generating || !!busy || !pending?.token || !!pending.tooMany} onClick={commit}>{busy === 'git-commit' && <Loader2 size={13} className="spin" />}{t('projectProfile.git.commitConfirm')}</button>
              </div>
            </div>
          </section>}
          {git.repo && !!git.changes?.length && <section className="project-card" data-project-git-changes>
            <div className="project-card-head"><div><h3>{t('projectProfile.git.changeCount', { count: changeCount })}</h3></div></div>
            <div className="project-list">{git.changes.map((c) => <div key={`${c.code}${c.path}`} className="project-row project-row-static project-git-change" title={c.path}><code className={c.code === '??' ? 'untracked' : c.code[0] !== ' ' ? 'staged' : ''}>{c.code.trim() || '·'}</code><span>{c.path}</span></div>)}
              {changeCount > git.changes.length && <p className="agent-profile-muted">{t('projectProfile.git.more', { count: changeCount - git.changes.length })}</p>}</div>
          </section>}
          {git.repo && !!git.commits?.length && <section className="project-card" data-project-git-commits>
            <div className="project-card-head"><div><h3>{t('projectProfile.git.commits')}</h3></div></div>
            <div className="project-list">{git.commits.map((c) => <div key={c.sha} className="project-row project-row-static project-git-commit" title={c.sha}><strong>{c.subject}</strong><small>{formatRelative(c.at, { now, locale })}</small><code>{c.short}</code></div>)}</div>
          </section>}
        </div>}
        {!ctx && !loadError && <p className="agent-profile-muted" style={{ paddingTop: 16 }}><Loader2 size={14} className="spin" /> {t('projectProfile.loading')}</p>}
      </fieldset>
      <footer className={`agent-profile-save${dirty ? ' is-dirty' : ''}`}>
        {error && <p className="agent-profile-error" role="alert">{error}{error === t('projectProfile.docConflict') && <> <button className="profile-text-action" onClick={() => { setDocDirty(false); setReloadAt((n) => n + 1); clear() }}>{t('projectProfile.retry')}</button></>}</p>}
        {notice && <p className="profile-save-notice" role="status"><Check size={13} />{notice}</p>}
        {dirty ? <><small>{t('projectProfile.saveScope')}</small><div><button className="btn" disabled={!!busy} onClick={() => { setDocDirty(false); setSettingsDirty(false); setDocDraft(ctx?.doc.content ?? ''); setSettingsDraft(ctx?.settings ?? {}); clear() }}>{t('agentProfile.cancel')}</button><button className="btn primary" disabled={!!busy} onClick={() => void save()}>{busy === 'save' && <Loader2 size={13} className="spin" />}{t(busy === 'save' ? 'agentProfile.saving' : 'projectProfile.save')}</button></div></> : null}
      </footer>
    </div>
    {selected && <div className="team-member-heading"><button aria-label={t('projectProfile.back')} onClick={() => setSelected('')}><ArrowLeft size={14} />{t('projectProfile.back')}{dirty && <span className="team-draft-dot" title={t('agentProfile.unsaved')} />}</button><small>{executors.find((ex) => ex.key === selected) ? executorLabel(executors.find((ex) => ex.key === selected)!) : ''}</small></div>}
    {/* 点开过的执行者详情保持挂载:返回项目再点进去,里面没保存的草稿还在(与 TEAM 详情同一手法)。 */}
    {opened.map((key) => {
      const ex = executors.find((item) => item.key === key)
      if (!ex) return null
      return <div className="team-detail-pane" key={key} hidden={selected !== key} data-project-executor-detail={key}>{detailFor(ex)}</div>
    })}
  </section>
}
