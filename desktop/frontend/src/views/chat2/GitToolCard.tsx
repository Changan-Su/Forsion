/**
 * 对话里的 Git 卡(仓根 docs/ToBeImproved/Git对话卡片方案_2026-10-28,方案 B):git_status / git_commit / git_push / git_pull
 * 跑完后在工具行后面接一张卡,连续几步 git 并成一张(partitionToolSegment 切段)。
 *   - 只看过(全是 git_status)→ 状态卡:分支、改动、推送去向那个远端,能直接点的提交 / 推送 / 拉取。
 *   - 动过(commit / push / pull)→ 结果卡:每步一行(失败写清原因和出路),底下一行此刻的状况。
 * 状况一律现读(项目详情 › Git 页同一组接口):卡留在回答上,翻回旧对话看到的也是此刻。卡上的按钮是用户亲手点的,直接做,
 * 和 Git 页同一套动作,不经 Tangu、不过审批。读不到现状(手机 / 网页 / 别的电脑上的会话)→ 只按工具结果画,不给写按钮。
 * 远端的站名与「用谁的账号」复用 ProjectGitRemotes(Forsion Git / GitHub / 别的站一张表)。
 * 审批卡里的结构化卡身也在这里(useGitApproval,ApprovalCard 用)。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ArrowDownToLine, Check, ExternalLink, GitBranch, GitCommitHorizontal, Loader2, Sparkles, Upload, UserRound, X } from 'lucide-react'
import type { GitRemoteInfo, GitSummary, ToolEvent } from '../../../../../tangu-agent/src/contracts/clientTypes'
import { registerMessages, useI18n } from '../../i18n'
import { UI_MODE } from '@lcl/engine'
import { generateGitCommitMessage, getGitHosting, getProjectContext, gitCommitProject, gitPendingProject, gitPullProject, gitPushProject } from '../../services/backendService'
import { homeTarget, refForSession } from '../../services/engine/targets'
import { showDetails } from '../../stores/detailsSubject'
import { useApp } from '../../stores/appStore'
import { RemoteHostIcon, remoteAuthText, siteName } from '../ProjectGitRemotes'
import { GIT_ERROR_CODES } from '../projectProfileMessages'
import './gitToolCard.css'

registerMessages({
  'gitCard.title': { zh: 'Git · {name}', en: 'Git · {name}' },
  'gitCard.noChanges': { zh: '没有未提交的改动', en: 'Nothing uncommitted' },
  'gitCard.noRemote': { zh: '还没有远端', en: 'No remote yet' },
  'gitCard.moreRemotes': { zh: '共 {count} 个远端', en: '{count} remotes' },
  'gitCard.pushTo': { zh: '推送到 {site}', en: 'Push to {site}' },
  'gitCard.pushToCount': { zh: '推送到 {site}（{count}）', en: 'Push to {site} ({count})' },
  'gitCard.openDetails': { zh: '在项目详情中打开', en: 'Open in project details' },
  'gitCard.openPage': { zh: '打开仓库网页', en: 'Open repository page' },
  'gitCard.retryPush': { zh: '重试推送', en: 'Retry push' },
  'gitCard.writing': { zh: '正在写提交信息…', en: 'Writing a commit message…' },
  'gitCard.cancel': { zh: '取消', en: 'Cancel' },
  'gitCard.commitDo': { zh: '提交', en: 'Commit' },
  'gitCard.committedTo': { zh: '提交到 {branch} · {count} 个文件', en: 'Committed to {branch} · {count} files' },
  'gitCard.committedToOne': { zh: '提交到 {branch} · {count} 个文件', en: 'Committed to {branch} · {count} file' },
  'gitCard.pushedTo': { zh: '推送到 {site}', en: 'Pushed to {site}' },
  'gitCard.pushedCommits': { zh: '{count} 个提交', en: '{count} commits' },
  'gitCard.pushedCommitsOne': { zh: '{count} 个提交', en: '{count} commit' },
  'gitCard.ownCredentials': { zh: '用的是这台电脑自己的 git 凭据', en: 'Used this computer’s own git credentials' },
  'gitCard.pulledFrom': { zh: '从 {upstream} 拉取', en: 'Pulled from {upstream}' },
  'gitCard.pulledCount': { zh: '快进了 {count} 个提交', en: 'Fast-forwarded {count} commits' },
  'gitCard.pulledCountOne': { zh: '快进了 {count} 个提交', en: 'Fast-forwarded {count} commit' },
  'gitCard.pulledNothing': { zh: '已经是最新的', en: 'Already up to date' },
  'gitCard.commitFailed': { zh: '没提交成功', en: 'Not committed' },
  'gitCard.pushFailed': { zh: '没推上去', en: 'Not pushed' },
  'gitCard.pushFailedTo': { zh: '没推上 {site}', en: 'Not pushed to {site}' },
  'gitCard.pullFailed': { zh: '没拉取成功', en: 'Not pulled' },
  'gitCard.statusFailed': { zh: '没读到 Git 状况', en: 'Couldn’t read the git state' },
  'gitCard.inSync': { zh: '已同步', en: 'Up to date' },
  'gitCard.inSyncHint': { zh: '和 {upstream} 一致，没有未提交的改动', en: 'Matches {upstream}, nothing uncommitted' },
  'gitCard.nowState': { zh: '现在：{state}', en: 'Now: {state}' },
  'gitCard.apv.commit': { zh: '提交到 {branch}', en: 'Commit to {branch}' },
  'gitCard.apv.push': { zh: '推送到 {site}', en: 'Push to {site}' },
  'gitCard.apv.pull': { zh: '从 {upstream} 拉取', en: 'Pull from {upstream}' },
  'gitCard.apv.pullHint': { zh: '只快进；两边都有新提交时什么都不改。', en: 'Fast-forward only; nothing changes if both sides have new commits.' },
  'gitCard.apv.once': { zh: '只推这一次，推送去向仍是 {remote}', en: 'This once; the push target stays {remote}' },
  'gitCard.apv.commits': { zh: '{count} 个提交', en: '{count} commits' },
  'gitCard.apv.commitsOne': { zh: '{count} 个提交', en: '{count} commit' },
})

export const GIT_CARD_TOOLS: ReadonlySet<string> = new Set(['git_status', 'git_commit', 'git_push', 'git_pull'])
export const isGitTool = (ev: { name: string }): boolean => GIT_CARD_TOOLS.has(ev.name)
/** 只看过状态的那张卡,在同一条回答里后面又有提交 / 推送 / 拉取时不画:否则卡上的「推送」和等你批准的那次推送并排(后面那张结果卡会写清现状)。 */
export function gitStatusSuperseded(run: ToolEvent[], all: ToolEvent[] | undefined): boolean {
  if (!run.length || run.some((e) => e.name !== 'git_status') || !all) return false
  const at = all.findIndex((e) => e.id === run[run.length - 1].id)
  return at >= 0 && all.slice(at + 1).some((e) => isGitTool(e) && e.name !== 'git_status')
}

const FILES_SHOWN = 8
/** 英文要分单复数的几句(中文同一句):count 为 1 时取 <key>One。 */
const countKey = (key: string, count: unknown): string => (Number(count) === 1 ? `${key}One` : key)

/** 工具结果:成功是一个 JSON;失败以 `Error:` 开头、第二行起是带机器码的 JSON(tangu-agent tools/builtin/git.ts)。 */
export function parseGitResult(ev: Pick<ToolEvent, 'result' | 'isError'>): { ok: boolean; data: Record<string, any> } | null {
  const raw = ev.result || ''
  const failed = !!ev.isError || raw.startsWith('Error:')
  const body = failed ? raw.slice(raw.indexOf('\n') + 1) : raw
  try {
    const data = JSON.parse(body)
    return data && typeof data === 'object' ? { ok: !failed, data } : null
  } catch {
    return failed ? { ok: false, data: { message: raw.replace(/^Error:\s*/, '').split('\n')[0] } } : null
  }
}
const argsOf = (raw?: string): Record<string, any> => { try { return raw ? JSON.parse(raw) : {} } catch { return {} } }

/** 这张卡能不能现读 / 能不能动手:只有这台电脑上的桌面端、会话在本机引擎上。 */
function canReach(sessionId: string | null | undefined): boolean {
  return !!sessionId && UI_MODE !== 'mobile' && !window.tangu?.mobile && refForSession(sessionId).kind !== 'unit'
}

interface Live { git: GitSummary | null; login: string | null | undefined; name: string }

/** 此刻的状况(项目上下文的 git 一段)+ 绑定的 GitHub 账号(只在有 GitHub 远端时多问一趟)。 */
function useLiveGit(sessionId: string | null | undefined, refreshKey: string) {
  const [live, setLive] = useState<Live | null>(null)
  const [tick, setTick] = useState(0)
  const reach = canReach(sessionId)
  useEffect(() => {
    if (!reach || !sessionId) return
    let alive = true
    void getProjectContext(homeTarget(), sessionId).then(async (ctx) => {
      const git = ctx?.git ?? null
      const name = ctx?.cwd ? ctx.cwd.split(/[\\/]/).filter(Boolean).pop() || '' : ''
      const needLogin = git?.remoteList?.some((r) => r.auth === 'github')
      const hosting = needLogin ? await getGitHosting(homeTarget(), sessionId).catch(() => null) : null
      const login = hosting?.github ? (hosting.github.linked ? hosting.github.login ?? undefined : null) : undefined
      if (alive) setLive({ git, login, name })
    }, () => { if (alive) setLive(null) })
    return () => { alive = false }
  }, [reach, sessionId, refreshKey, tick])
  return { live, reach, reload: useCallback(() => setTick((n) => n + 1), []) }
}

const targetRemote = (git: GitSummary | null | undefined): GitRemoteInfo | undefined =>
  git?.pushRemote ? git.remoteList?.find((r) => r.name === git.pushRemote) : undefined

function useErrText() {
  const { t } = useI18n()
  return (code: unknown, fallback: unknown): string =>
    typeof code === 'string' && GIT_ERROR_CODES.has(code) ? t(`projectProfile.git.err.${code}`) : String(fallback || t('projectProfile.git.err.git_failed'))
}

function RemoteRow({ r, login, tag }: { r: GitRemoteInfo; login: string | null | undefined; tag?: boolean }) {
  const { t } = useI18n()
  return <div className="git-card-remote">
    <RemoteHostIcon host={r.host} />
    <div className="git-card-rt">
      <strong>{r.path || r.url}</strong>
      <small>{`${siteName(r, t)} · ${remoteAuthText(r, login, t)}`}{tag && <span className="git-card-tag">{t('gitRemotes.pushHere')}</span>}</small>
    </div>
  </div>
}

/** 状态卡与结果卡共用的「此刻」:分支 / 上游 / 领先落后 / 改动。 */
function StateBlock({ git, files }: { git: GitSummary; files: boolean }) {
  const { t } = useI18n()
  const total = git.changesTotal ?? git.changes?.length ?? 0
  return <>
    <div className="git-card-row">
      <span className="git-card-branch"><GitBranch size={13} />{git.detached ? t('projectProfile.git.detached') : git.branch}</span>
      {git.upstream ? <span className="git-card-faint">→ {git.upstream}</span> : <span className="git-card-faint">{t('projectProfile.git.noUpstream')}</span>}
      {!!git.ahead && <span className="git-card-chip">{t('projectProfile.git.ahead', { count: git.ahead })}</span>}
      {!!git.behind && <span className="git-card-chip">{t('projectProfile.git.behind', { count: git.behind })}</span>}
    </div>
    {files && (total ? <>
      <div className="git-card-row">
        {!!git.staged && <span className="git-card-chip staged">{t('projectProfile.git.staged', { count: git.staged })}</span>}
        {!!git.unstaged && <span className="git-card-chip">{t('projectProfile.git.unstaged', { count: git.unstaged })}</span>}
        {!!git.untracked && <span className="git-card-chip">{t('projectProfile.git.untracked', { count: git.untracked })}</span>}
      </div>
      <ul className="git-card-files">
        {(git.changes || []).slice(0, FILES_SHOWN).map((c) => <li key={c.path}><code className={c.code === '??' ? 'untracked' : c.code[0] !== ' ' ? 'staged' : ''}>{c.code.trim() || c.code}</code><span>{c.path}</span></li>)}
        {total > FILES_SHOWN && <li className="git-card-faint"><span /><span>{t('projectProfile.git.more', { count: total - FILES_SHOWN })}</span></li>}
      </ul>
    </> : <div className="git-card-faint">{t('gitCard.noChanges')}</div>)}
  </>
}

/** 卡上的提交框:清单与署名现取(同 Git 页),信息由会话的模型写、可改;提交带清单指纹,清单变了就不提交。 */
function CommitForm({ sessionId, onDone, onCancel }: { sessionId: string; onDone: () => void; onCancel: () => void }) {
  const { t } = useI18n()
  const errText = useErrText()
  const [pending, setPending] = useState<Awaited<ReturnType<typeof gitPendingProject>> | null>(null)
  const [message, setMessage] = useState('')
  const [writing, setWriting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const write = useCallback(() => {
    setWriting(true)
    void generateGitCommitMessage(homeTarget(), sessionId).then((m) => setMessage(m), (e) => setErr(errText(e?.code, e?.message))).finally(() => setWriting(false))
  }, [sessionId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void gitPendingProject(homeTarget(), sessionId).then((p) => { setPending(p); if (p.total) write() }, (e) => setErr(errText(e?.code, e?.message)))
  }, [sessionId]) // eslint-disable-line react-hooks/exhaustive-deps
  const commit = () => {
    if (!pending || !message.trim()) return
    setBusy(true); setErr('')
    void gitCommitProject(homeTarget(), sessionId, message, pending.token).then(onDone, (e) => setErr(errText(e?.code, e?.message))).finally(() => setBusy(false))
  }
  return <div className="git-card-form" data-git-card-form>
    {pending && <div className="git-card-faint">{t(pending.stagedOnly ? 'projectProfile.git.filesStaged' : 'projectProfile.git.filesAll', { count: pending.total })}</div>}
    <textarea className="git-card-msg" rows={3} value={writing ? '' : message} placeholder={writing ? t('gitCard.writing') : ''} disabled={writing || busy} onChange={(e) => setMessage(e.target.value)} />
    {pending?.identity && <div className="git-card-id"><UserRound size={12} />{t('projectProfile.git.commitAs', { name: pending.identity.name, email: pending.identity.email })}</div>}
    {err && <p className="git-card-err">{err}</p>}
    <div className="git-card-acts">
      <button type="button" className="btn sm" disabled={writing || busy || !pending?.total} onClick={write}>{writing ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}{t('projectProfile.git.regenerate')}</button>
      <span className="git-card-end">
        <button type="button" className="btn sm" disabled={busy} onClick={onCancel}>{t('gitCard.cancel')}</button>
        <button type="button" className="btn sm primary" data-git-card-act="commit-do" disabled={busy || writing || !message.trim() || !pending?.total || !!pending?.tooMany} onClick={commit}>
          {busy ? <Loader2 size={13} className="spin" /> : <Check size={13} />}{t('gitCard.commitDo')}
        </button>
      </span>
    </div>
  </div>
}

/** 一步结果(结果卡的一行)。 */
function Step({ ev, git, login }: { ev: ToolEvent; git: GitSummary | null | undefined; login: string | null | undefined }) {
  const { t } = useI18n()
  const errText = useErrText()
  const r = parseGitResult(ev)
  const d = r?.data || {}
  const ok = !!r?.ok
  // 推到哪个远端:成功时结果里有;失败时看参数(「只推这一次」点了名)再退回推送去向
  const pushed = ev.name === 'git_push' ? git?.remoteList?.find((x) => x.name === (d.remote || argsOf(ev.arguments).remote || git.pushRemote)) : undefined
  const site = d.site?.site || (pushed ? siteName(pushed, t) : '')
  let title: ReactNode = null
  let sub: ReactNode = null
  if (ev.name === 'git_commit') {
    title = ok ? <><span className="git-card-sha">{d.short}</span><b>{d.subject}</b></> : <b>{t('gitCard.commitFailed')}</b>
    if (ok) sub = [t(countKey('gitCard.committedTo', d.files), { branch: d.branch || 'HEAD', count: d.files ?? '?' }), d.author].filter(Boolean).join(' · ')
  } else if (ev.name === 'git_push') {
    title = <b>{ok ? t('gitCard.pushedTo', { site: site || d.remote }) : site ? t('gitCard.pushFailedTo', { site }) : t('gitCard.pushFailed')}</b>
    if (ok) {
      sub = [d.site?.repo || pushed?.path || d.remote, d.branch, d.commits ? t(countKey('gitCard.pushedCommits', d.commits), { count: d.commits }) : '',
        pushed ? remoteAuthText(pushed, login, t) : '', d.ownCredentials ? t('gitCard.ownCredentials') : ''].filter(Boolean).join(' · ')
    }
  } else if (ev.name === 'git_pull') {
    title = <b>{ok ? t('gitCard.pulledFrom', { upstream: d.upstream }) : t('gitCard.pullFailed')}</b>
    if (ok) sub = d.updated ? t(countKey('gitCard.pulledCount', d.commits), { count: d.commits }) : t('gitCard.pulledNothing')
  } else {
    title = <b>{t('gitCard.statusFailed')}</b>
  }
  return <div className={`git-card-step${ok ? '' : ' bad'}`} data-git-step={ev.name}>
    {ok ? <Check size={14} /> : <X size={14} />}
    <div className="git-card-t">
      {title}
      {sub && <div className="git-card-faint">{sub}</div>}
      {!ok && <p className="git-card-err">{errText(d.error, d.message)}</p>}
      {!ok && typeof d.detail === 'string' && d.detail && <pre className="git-card-pre">{d.detail}</pre>}
    </div>
  </div>
}

export function GitToolCard({ events, sessionId }: { events: ToolEvent[]; sessionId?: string | null }) {
  const { t } = useI18n()
  const errText = useErrText()
  const { live, reach, reload } = useLiveGit(sessionId, events.map((e) => e.id).join(','))
  const [busy, setBusy] = useState<'' | 'push' | 'pull'>('')
  const [form, setForm] = useState(false)
  const [actErr, setActErr] = useState('')
  const projectName = useApp((s) => (sessionId ? s.sessions.find((x) => x.id === sessionId)?.project_name : '')) || live?.name || ''
  const writes = events.filter((e) => e.name !== 'git_status')
  const git = live?.git
  const remote = targetRemote(git)
  const lastPush = [...writes].reverse().find((e) => e.name === 'git_push')
  const pushFailed = !!lastPush && !parseGitResult(lastPush)?.ok
  // 失败的那次若是「只推这一次」到别的远端,重试也推到那里
  const retryRemote = pushFailed ? (argsOf(lastPush!.arguments).remote as string | undefined) || undefined : undefined
  // 读不到现状时,状态卡退回最后一次 git_status 的结果(手机 / 网页看得到卡,只是不能动手)
  const fromTool = !reach ? parseGitResult([...events].reverse().find((e) => e.name === 'git_status') || { result: '' })?.data : undefined
  const shown: GitSummary | null | undefined = git ?? (fromTool?.repo ? {
    available: true, repo: true, branch: fromTool.branch, upstream: fromTool.upstream, ahead: fromTool.ahead, behind: fromTool.behind,
    staged: fromTool.changes?.staged, unstaged: fromTool.changes?.unstaged, untracked: fromTool.changes?.untracked,
    changes: fromTool.changes?.files, changesTotal: fromTool.changes?.total,
  } as GitSummary : null)
  const canAct = reach && !!git?.repo && !git.nested && !git.detached && !!sessionId
  const act = (kind: 'push' | 'pull') => {
    if (!sessionId) return
    setBusy(kind); setActErr('')
    void (kind === 'push' ? gitPushProject(homeTarget(), sessionId, false, retryRemote) : gitPullProject(homeTarget(), sessionId))
      .then(reload, (e) => setActErr(errText(e?.code, e?.message))).finally(() => setBusy(''))
  }
  const openDetails = () => {
    const path = useApp.getState().sessions.find((x) => x.id === sessionId)?.project_path
    if (path) showDetails({ kind: 'project', path, git: Date.now() })
  }
  const openPage = (url: string) => { void import('../../builtins').then((m) => m.routeExternalUrl(url)) }
  const total = git?.changesTotal ?? git?.changes?.length ?? 0
  const synced = !!git?.repo && !total && !git.ahead && !git.behind && !!git.upstream
  return <div className="git-card-wrap" data-git-card={writes.length ? 'result' : 'status'}>
    <div className="sketch-card plugin-tool-card">
      <div className="sketch-card-head"><span className="sketch-card-title">{t('gitCard.title', { name: projectName || 'Git' })}</span></div>
      <div className="plugin-tool-card-body inline"><div className="git-card">
        {writes.length > 0 && <div className="git-card-steps">{writes.map((ev) => <Step key={ev.id} ev={ev} git={git} login={live?.login} />)}</div>}
        {writes.length > 0 && git?.repo && (synced
          ? <div className="git-card-row"><span className="git-card-chip ok">{t('gitCard.inSync')}</span><span className="git-card-faint">{t('gitCard.inSyncHint', { upstream: git.upstream })}</span></div>
          : <StateBlock git={git} files={false} />)}
        {!writes.length && (shown?.repo ? <StateBlock git={shown} files /> : <p className="git-card-err">{errText(parseGitResult(events[events.length - 1])?.data.error, parseGitResult(events[events.length - 1])?.data.note || parseGitResult(events[events.length - 1])?.data.message)}</p>)}
        {!writes.length && git?.repo && (remote ? <RemoteRow r={remote} login={live?.login} tag={(git.remoteList?.length ?? 0) > 1} /> : !git.remoteList?.length && <div className="git-card-faint">{t('gitCard.noRemote')}</div>)}
        {!writes.length && (git?.remoteList?.length ?? 0) > 1 && <div className="git-card-faint">{t('gitCard.moreRemotes', { count: git!.remoteList!.length })}</div>}
        {actErr && <p className="git-card-err">{actErr}</p>}
        {form && canAct && sessionId ? <CommitForm sessionId={sessionId} onCancel={() => setForm(false)} onDone={() => { setForm(false); reload() }} /> : (reach || writes.length > 0) && <div className="git-card-acts">
          {canAct && !!total && <button type="button" className="btn sm primary" data-git-card-act="commit" onClick={() => setForm(true)}><GitCommitHorizontal size={13} />{t('projectProfile.git.commit')}</button>}
          {canAct && remote && (!!git?.ahead || pushFailed || !git?.upstream) && <button type="button" className="btn sm" data-git-card-act="push" disabled={!!busy} onClick={() => act('push')}>
            {busy === 'push' ? <Loader2 size={13} className="spin" /> : <Upload size={13} />}
            {pushFailed ? t('gitCard.retryPush') : git?.ahead ? t('gitCard.pushToCount', { site: siteName(remote, t), count: git.ahead }) : t('gitCard.pushTo', { site: siteName(remote, t) })}
          </button>}
          {canAct && !!git?.behind && <button type="button" className="btn sm" data-git-card-act="pull" disabled={!!busy} onClick={() => act('pull')}>
            {busy === 'pull' ? <Loader2 size={13} className="spin" /> : <ArrowDownToLine size={13} />}{t('projectProfile.git.pullCount', { count: git.behind })}
          </button>}
          {writes.length > 0 && !pushFailed && remote?.web && lastPush && <button type="button" className="btn sm" onClick={() => openPage(remote.web!)}><ExternalLink size={13} />{t('gitCard.openPage')}</button>}
          {reach && <button type="button" className="btn sm ghost git-card-end" data-git-card-act="details" onClick={openDetails}><ExternalLink size={13} />{t('gitCard.openDetails')}</button>}
        </div>}
      </div></div>
    </div>
  </div>
}

/**
 * 审批卡里的 git 卡身(ApprovalCard):模型的参数里只有提交信息 / 远端名,文件清单、推到哪个站、用谁的账号由这里现读。
 * 读不到(手机 / 网页 / 远端审批页、项目上下文出错)→ null,审批卡照旧显示引擎写的说明(它在闸门那里也读过一遍)。
 */
export function useGitApproval(name: string, rawArgs: string | undefined, sessionId: string | undefined, active: boolean): { title: string; body: ReactNode } | null {
  const { t } = useI18n()
  const isGit = active && (name === 'git_commit' || name === 'git_push' || name === 'git_pull')
  const { live } = useLiveGit(isGit ? sessionId : null, '')
  const [pending, setPending] = useState<Awaited<ReturnType<typeof gitPendingProject>> | null>(null)
  useEffect(() => {
    if (!isGit || name !== 'git_commit' || !sessionId || !canReach(sessionId)) return
    let alive = true
    void gitPendingProject(homeTarget(), sessionId).then((p) => { if (alive) setPending(p) }, () => {})
    return () => { alive = false }
  }, [isGit, name, sessionId])
  if (!isGit || !live?.git?.repo) return null
  const git = live.git
  const args = argsOf(rawArgs)
  if (name === 'git_commit') {
    if (!pending) return null
    const msg = typeof args.message === 'string' ? args.message.trim() : ''
    const [subject, ...rest] = msg.split('\n')
    return {
      title: t('gitCard.apv.commit', { branch: git.branch || 'HEAD' }),
      body: <div className="git-apv" data-git-approval="commit">
        <div className="git-apv-msg"><b>{subject}</b>{rest.join('\n').trim() ? `\n\n${rest.join('\n').trim()}` : ''}</div>
        <div className="git-card-faint">{t(pending.stagedOnly ? 'projectProfile.git.filesStaged' : 'projectProfile.git.filesAll', { count: pending.total })}</div>
        <ul className="git-card-files">
          {pending.files.slice(0, FILES_SHOWN).map((f) => <li key={f.path}><code>{f.code.trim() || f.code}</code><span>{f.path}</span></li>)}
          {pending.total > FILES_SHOWN && <li className="git-card-faint"><span /><span>{t('projectProfile.git.more', { count: pending.total - FILES_SHOWN })}</span></li>}
        </ul>
        {pending.identity && <div className="git-card-id"><UserRound size={12} />{t('projectProfile.git.commitAs', { name: pending.identity.name, email: pending.identity.email })}</div>}
      </div>,
    }
  }
  if (name === 'git_pull') return {
    title: t('gitCard.apv.pull', { upstream: git.upstream || '—' }),
    body: <div className="git-apv" data-git-approval="pull"><div className="git-card-faint">{t('gitCard.apv.pullHint')}</div></div>,
  }
  const once = typeof args.remote === 'string' && args.remote.trim() ? args.remote.trim() : null
  const r = git.remoteList?.find((x) => x.name === (once ?? git.pushRemote))
  if (!r) return null
  const commits = !once && git.ahead ? (git.commits || []).slice(0, Math.min(git.ahead, FILES_SHOWN)) : []
  return {
    title: t('gitCard.apv.push', { site: siteName(r, t) }),
    body: <div className="git-apv" data-git-approval="push">
      <RemoteRow r={r} login={live.login} />
      <div className="git-card-faint">{[`${r.name} · ${git.branch}`, !once && git.ahead ? t(countKey('gitCard.apv.commits', git.ahead), { count: git.ahead }) : '', once && git.pushRemote && once !== git.pushRemote ? t('gitCard.apv.once', { remote: git.pushRemote }) : ''].filter(Boolean).join(' · ')}</div>
      {!!commits.length && <ul className="git-card-commits">{commits.map((c) => <li key={c.sha}><span className="git-card-sha">{c.short}</span>{c.subject}</li>)}</ul>}
    </div>,
  }
}
