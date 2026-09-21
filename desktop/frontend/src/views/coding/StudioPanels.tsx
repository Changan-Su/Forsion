import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, History, Loader2, Play, RefreshCw, Save, Undo2, X } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useApp } from '../../stores/appStore'
import { useCodeStudio } from '../../stores/codeStudioStore'
import { buildStudioDraft, type StudioBrief } from './projectBrief'
import { saveStudioBriefFile } from './briefFile'
import { flushStudioEditors, hasUnsavedStudioEditors } from './editorSession'
import { historyMode, relativeTime } from './gitHistory'
import { projectName, normPath } from './studioModel'
import type { CodeStudioSnapshotSummary } from '../../../../shared/codeStudio'
import type { GitPanelStatus, GitVersion } from '../../../../shared/products'
import type { EnvProbeResult } from '../../types'
import './studioMessages'
export type StudioPanel = 'brief' | 'history' | 'checks' | 'issues' | 'setup' | 'sandbox' | null
export const CHECKS = [
  ['main', 'studio.checkMain'], ['phone', 'studio.checkPhone'], ['failure', 'studio.checkFailure'], ['data', 'studio.checkData'], ['access', 'studio.checkAccess'],
] as const

export function BriefPanel({ root, onPrompt }: { root: string; onPrompt(text: string, plan?: boolean): void }) {
  const { t, locale } = useI18n()
  const saved = useCodeStudio(s => s.projects[root]?.brief)
  const [brief, setBrief] = useState<StudioBrief>(() => saved || { idea: '', audience: '', constraints: '', capabilities: [], locale })
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const inFlight = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const persist = async (snapshot: StudioBrief): Promise<boolean> => {
    if (inFlight.current) return false
    inFlight.current = true
    setSaving(true); setError(''); setNotice('')
    try {
      await saveStudioBriefFile(root, snapshot)
      if (!mounted.current || useCodeStudio.getState().activeProject !== root) return false
      useCodeStudio.getState().updateProject({ brief: snapshot })
      setNotice(t('studio.briefSaved'))
      return true
    } catch (e) { if (mounted.current) setError(String((e as Error).message || e)); return false }
    finally { inFlight.current = false; if (mounted.current) setSaving(false) }
  }
  const submit = async (plan?: boolean): Promise<void> => {
    const snapshot = { ...brief, capabilities: [...brief.capabilities], locale }
    if (await persist(snapshot) && plan !== undefined) onPrompt(buildStudioDraft(snapshot), plan)
  }
  return <div className="csu-panel-body">
    {!saved && <p className="csu-hint">{t('studio.noBrief')}</p>}
    {(['idea', 'audience', 'constraints'] as const).map(field => <label className="csu-field" key={field}><span>{t(`studio.${field}`)}</span><textarea aria-label={t(`studio.${field}`)} disabled={saving} rows={field === 'idea' ? 5 : 3} value={brief[field]} onChange={e => setBrief({ ...brief, [field]: e.target.value })} /></label>)}
    <div className="csu-actions"><button disabled={saving} onClick={() => void submit()}><Save size={14} />{t('studio.saveBrief')}</button><button disabled={saving || !brief.idea.trim()} onClick={() => void submit(true)}>{t('studio.plan')}</button><button className="csu-primary" disabled={saving || !brief.idea.trim()} onClick={() => void submit(false)}>{t('studio.build')}</button></div>
    {!!error && <p role="alert" className="csu-error">{error}</p>}
    {!!notice && <p role="status" className="csu-hint"><Check size={13} />{notice}</p>}
  </div>
}
export function ChecksPanel({ root, onPrompt }: { root: string; onPrompt(text: string): void }) {
  const { t } = useI18n()
  const checked = useCodeStudio(s => s.projects[root]?.checks || {})
  return <div className="csu-panel-body"><p className="csu-hint">{t('studio.manualChecks')}</p>
    <div className="csu-check-list">{CHECKS.map(([id, key]) => <label key={id}><input type="checkbox" checked={!!checked[id]} onChange={e => useCodeStudio.getState().updateProject({ checks: { ...checked, [id]: e.target.checked } })} /><span>{t(key)}</span></label>)}</div>
    <button className="csu-primary" onClick={() => onPrompt(`Review and test the current project against these acceptance criteria. Inspect the source and run the available tools; exercise the preview if browser tools are available. Do not claim checks passed without evidence. Report defects with reproduction steps. Do not change files during this review.\n${CHECKS.map(([, key]) => `- ${t(key)}`).join('\n')}`)}>{t('studio.askVerify')}</button>
  </div>
}
/** 没装 git:解释一句 + 复用环境检测那套一键安装(envCheck / envRun),装完「重新检测」直接回到版本列表。 */
function GitInstall({ onRecheck }: { onRecheck(): void }) {
  const { t } = useI18n()
  const [probe, setProbe] = useState<EnvProbeResult | null>(null)
  const [checking, setChecking] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  /** 返回这次探测到的 git 行(null = 探不到 / 没有这一行),装完要拿它判「装了但仍检测不到」。 */
  const probeGit = useCallback(async (): Promise<EnvProbeResult | null> => {
    if (!window.tangu?.envCheck) return null
    setChecking(true)
    try {
      const list = await window.tangu.envCheck()
      const found = list.find(item => item.tool === 'git') || null
      if (mounted.current) setProbe(found)
      return found
    } catch { return null /* 探测不到就只留说明文字:这一屏是引导,不该变成报错屏 */ }
    finally { if (mounted.current) setChecking(false) }
  }, [])
  useEffect(() => { void probeGit() }, [probeGit])
  const sudo = /^sudo\b/.test(probe?.installCommand || '')
  const install = async () => {
    if (!probe?.installId || !window.tangu?.envRun) return
    // sudo 需要 TTY 输密码,GUI 子进程里必然卡死 → 改成复制命令、请用户自己去终端跑(与 EnvProbeSection 同一处理)。
    if (sudo) {
      try { await navigator.clipboard.writeText(probe.installCommand || '') } catch { /* 剪贴板不可用时命令原文还在屏上 */ }
      setNote(t('onboarding.env.copied', { command: probe.installCommand }))
      return
    }
    // 在本机执行命令之前先让用户点头(与 EnvProbeSection 同一契约:装什么、装在哪台机器上,用户要看得见)。
    if (!window.confirm(t('onboarding.env.installConfirm', { command: probe.installCommand }))) return
    setInstalling(true); setNote(''); setError('')
    try {
      const result = await window.tangu.envRun(probe.installId)
      if (!mounted.current) return
      if (result.exitCode !== 0) { setError(t('onboarding.env.installFail', { tool: 'git', code: result.exitCode })); return }
      // exit 0 不等于装上了:GUI 进程的 PATH 常常没刷新(本仓已知坑)。复检仍缺就如实说,别让这一屏一动不动。
      const after = await probeGit()
      if (mounted.current && !after?.found) setNote(t('onboarding.env.installedButMissing', { tool: 'git' }))
      onRecheck()
    } catch (e) { if (mounted.current) setError(String((e as Error).message || e)) }
    finally { if (mounted.current) setInstalling(false) }
  }
  return <div className="csu-git-install">
    <p className="csu-hint">{t('studio.history.gitWhy')}</p>
    {!!window.tangu?.envCheck && <>
      {!!probe?.installCommand && <code className="csu-git-cmd">{probe.installCommand}</code>}
      <div className="csu-git-actions">
        {!!probe?.installId && <button className="csu-primary" disabled={installing || checking} onClick={() => void install()}>{installing ? <Loader2 size={14} className="csx-spin" /> : <Play size={14} />}{sudo ? t('onboarding.env.copyCmd') : t('onboarding.env.install')}</button>}
        {/* 「重新检测」两侧都刷:探测行(装没装上)与宿主的 git 判定(面板该不该换形态)。 */}
        <button disabled={installing} onClick={() => { void probeGit(); onRecheck() }}><RefreshCw size={14} className={checking ? 'csx-spin' : ''} />{t('onboarding.env.recheck')}</button>
      </div>
      {!!note && <p className="csu-hint" role="status">{note}</p>}
      {!!error && <p className="csu-error" role="alert">{error}</p>}
    </>}
  </div>
}
/** 版本 = 宿主产生的 git 提交(每轮 AI 改动自动一版 + 用户手动命名版)。AI 自己永远不跑 git。
 *  没装 git → 安装引导;仓不归我们管 → 只读;启用 git 之前的旧快照另开一节,只能恢复不能新增。 */
export function HistoryPanel({ root, running, onRestored, refreshNonce = 0 }: { root: string; running: boolean; onRestored(): void; refreshNonce?: number }) {
  const { t, locale } = useI18n()
  const tag = locale === 'zh' ? 'zh-CN' : 'en-GB'
  const [status, setStatus] = useState<GitPanelStatus | null>(null)
  const [versions, setVersions] = useState<GitVersion[]>([])
  const [legacy, setLegacy] = useState<CodeStudioSnapshotSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirm, setConfirm] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const reload = useCallback(() => setNonce(value => value + 1), [])
  useEffect(() => {
    let live = true
    setLoading(true); setLoadError('')
    const bridge = window.tangu
    void (async () => {
      try {
        const next = bridge?.codeStudioGitStatus ? await bridge.codeStudioGitStatus(root) : null
        // 旧快照单独兜底:绝大多数项目根本没有,它失败不该把整块变成报错屏。
        const old = bridge?.codeStudioVersions ? await bridge.codeStudioVersions(root).catch(() => [] as CodeStudioSnapshotSummary[]) : []
        // 没装 git 就别去读提交:那一定失败,而这一屏该给的是安装引导。
        const list = next?.available && bridge?.codeStudioGitVersions ? await bridge.codeStudioGitVersions(root) : []
        if (!live) return
        setStatus(next); setLegacy(old); setVersions(list)
      } catch (e) { if (live) setLoadError(String((e as Error).message || e)) }
      finally { if (live) setLoading(false) }
    })()
    return () => { live = false }
  }, [root, nonce, refreshNonce])
  const probe = historyMode(status)
  // 桥只有一半的宿主(有 status 没 commit/restore)降级成只读,免得下面的 `!` 断言在运行期炸。
  const hasWriteBridge = !!window.tangu?.codeStudioGitCommit && !!window.tangu?.codeStudioGitRestore
  const mode = probe.mode === 'writable' && !hasWriteBridge ? 'readonly' : probe.mode
  // 降级不是「外来仓」那类业务理由,不能照搬 writable 那条 .git 提示;但也不能一句不说 ——
  // 只读列表 + 没有保存框 + 零解释,是整块面板里唯一一个用户无从得知原因的状态。
  const reasonKey = mode === probe.mode ? probe.reasonKey : 'studio.history.readonlyBridge'
  const allowed = () => {
    const app = useApp.getState()
    return !app.sessions.some(session => normPath(session.project_path || '') === normPath(root) && !!app.runningBySession[session.id]) && !hasUnsavedStudioEditors(root)
  }
  /** 三个写动作共用的前置:先把编辑器草稿落盘,再确认这个项目没在跑、也没有未保存改动。 */
  const guard = async (): Promise<void> => { if (!await flushStudioEditors(root) || !allowed()) throw new Error(t('studio.saveFirst')) }
  const save = async () => {
    if (busy) return
    if (running) { setError(t('studio.saveFirst')); return } // 输入框在运行期仍可回车:静默吞掉=用户以为存上了
    setBusy(true); setError(''); setNotice('')
    try {
      await guard()
      // untitled 是**落盘产物命名**(提交标题写下就不可变),所以在按下保存这一刻按当前界面语言求值。
      const version = await window.tangu!.codeStudioGitCommit!(root, { name: name.trim() || `${projectName(root)} · ${new Date().toLocaleString(tag)}`, auto: false, untitled: t('studio.history.untitled') })
      // null = 与上一版一字不差,不是失败 —— 别让用户以为保存坏了。
      if (!version) { setNotice(t('studio.history.noChanges')); return }
      setName(''); setNotice(t('studio.versionSaved')); reload()
    } catch (e) { setError(String((e as Error).message || e)) } finally { setBusy(false) }
  }
  const restore = async (id: string) => {
    // 上一个写动作还没回来就按了:静默 return 会让按钮看起来坏了,照样要给一句「先处理完再来」。
    if (busy) { setError(t('studio.saveFirst')); return }
    setBusy(true); setError(''); setNotice('')
    try {
      await guard()
      // 备份 / 恢复这两条也会变成永久的提交标题,同样按当前界面语言求值后交给宿主。
      const result = await window.tangu!.codeStudioGitRestore!(root, id, { backup: t('studio.history.backupName'), restorePrefix: t('studio.history.restorePrefix') })
      setConfirm(null)
      setNotice(t(result.backupId ? 'studio.history.restored' : 'studio.history.restoredClean'))
      reload(); onRestored()
    } catch (e) { setError(String((e as Error).message || e)) } finally { setBusy(false) }
  }
  const restoreLegacy = async (id: string) => {
    if (busy) { setError(t('studio.saveFirst')); return }
    setBusy(true); setError(''); setNotice('')
    try {
      await guard()
      const result = await window.tangu!.codeStudioRestore!(root, id)
      setConfirm(null)
      setNotice(t('studio.restored', { restored: result.restored.length, deleted: result.deleted.length }))
      if (result.conflicts.length) setError(t('studio.restoreConflicts', { count: result.conflicts.length }) + '\n' + result.conflicts.join('\n'))
      reload(); onRestored()
    } catch (e) { setError(String((e as Error).message || e)) } finally { setBusy(false) }
  }
  /** git 版本与旧快照共用一种行:恢复前一律先让用户确认(恢复是破坏性的,哪怕它可撤销)。 */
  const row = (version: { id: string; name: string; createdAt: number; files: number; auto?: boolean }, act: (id: string) => Promise<void>, confirmKey: string, canRestore: boolean) =>
    <div className="csu-version" key={version.id}><History size={15} /><div><strong>{version.name}</strong><small>{relativeTime(version.createdAt, tag)} · {t('studio.history.files', { count: version.files })}{version.auto ? <span className="csu-version-auto">{t('studio.history.auto')}</span> : null}</small>
      {confirm === version.id && <div className="csu-restore-confirm"><p>{t(confirmKey)}</p><button className="csu-primary" disabled={busy || running} onClick={() => void act(version.id)}>{t('studio.restore')}</button><button disabled={busy} onClick={() => setConfirm(null)}>{t('studio.cancel')}</button></div>}
    </div>{canRestore && <button disabled={busy || running} aria-label={`${t('studio.restore')} ${version.name}`} onClick={() => setConfirm(version.id)}><Undo2 size={15} /></button>}</div>
  // 首次加载完才挂 data-history-mode:挂早了,仪器会把「还没问到宿主」读成 unsupported(假红)。
  return <div className="csu-panel-body" data-history-mode={loading && !status ? undefined : mode} data-history-reason={reasonKey}>
    {!!loadError && <p className="csu-error" role="alert">{t('studio.loadError', { error: loadError })}<button onClick={reload}>{t('studio.retry')}</button></p>}
    {!!error && <p className="csu-error" role="alert">{error}</p>}{!!notice && <p className="csu-hint" role="status">{notice}</p>}
    {/* unsupported 且连旧快照都没有时,整块会是一个空白面板 —— 用户看不出是「没有版本」还是「面板坏了」,至少说一句。 */}
    {loading && !status ? <Loader2 className="csx-spin" size={18} /> : mode === 'install' ? <GitInstall onRecheck={reload} /> : mode === 'unsupported' ? (legacy.length ? null : <p className="csu-hint">{t('studio.history.empty')}</p>) : <>
      {mode === 'writable' && <div className="csu-version-create"><input aria-label={t('studio.versionName')} placeholder={t('studio.versionName')} maxLength={100} value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && !busy) void save() }} /><button className="csu-primary" disabled={busy || running} onClick={() => void save()}>{busy ? <Loader2 size={14} className="csx-spin" /> : <Save size={14} />}{t('studio.saveVersion')}</button></div>}
      {!!reasonKey && <p className="csu-hint">{t(reasonKey)}</p>}
      {!versions.length ? <p className="csu-hint">{t(mode === 'writable' ? 'studio.noVersions' : 'studio.history.empty')}</p> : <div className="csu-versions">{versions.map(version => row(version, restore, 'studio.history.confirmRestore', mode === 'writable'))}</div>}
      {mode === 'writable' && <p className="csu-hint csu-history-foot">{t('studio.history.autoFooter')}</p>}
    </>}
    {legacy.length > 0 && <details className="csu-legacy"><summary>{t('studio.history.legacy')}</summary>
      <p className="csu-hint">{t('studio.history.legacyHint')}</p>
      <div className="csu-versions">{legacy.map(version => row(version, restoreLegacy, 'studio.confirmRestore', !!window.tangu?.codeStudioRestore))}</div>
    </details>}
  </div>
}
export function PanelHeader({ title, close }: { title: string; close(): void }) { const { t } = useI18n(); return <div className="csu-panel-head"><strong>{title}</strong><button className="icon-btn" aria-label={t('studio.close')} onClick={close}><X size={16} /></button></div> }
