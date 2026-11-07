/**
 * 项目文件夹搬走后重新指向(借鉴 magpie 第二轮 9)。左栏项目名变淡 + 「文件夹不在原处」小标,项目菜单第一项「重新指向文件夹…」。
 * 判失效:进 Tangu 和窗口重新获得焦点时问一次本机引擎(它按会话库里的项目路径 stat),不轮询;外接盘 / 网络盘没挂上也算
 * 不在原处,所以只标记、不自动改。只在桌面(有本机目录选择框):手机上的项目来自桌面,入口只放桌面。
 * 三处一起改、失败回滚都在引擎(services/projectRelink.ts),这里发一次请求,成功后刷新会话、把本地缓存里的旧路径换掉。
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { CircleAlert, X } from 'lucide-react'
import { registerMessages, useI18n } from '../../i18n'
import { getMissingProjects, getRelinkInfo, relinkProject } from '../../services/backendService'
import { homeTarget } from '../../services/engine/targets'
import { currentPlatform } from '../../services/platform'
import { useApp } from '../../stores/appStore'
import type { ProjectSettings, RelinkInfo, WorkspaceDescriptor } from '../../../../../tangu-agent/src/contracts/clientTypes'
import './projectRelink.css'

registerMessages({
  'relink.missing': { zh: '文件夹不在原处', en: 'Folder moved or missing' },
  'relink.missingTip': { zh: '找不到 {path}。挪了位置或改了名，用「重新指向文件夹…」指到新位置；外接盘或网络盘没挂上时，挂上就好。', en: "Can't find {path}. If you moved or renamed it, use Point to new folder…; if it is on an external or network drive, connect the drive." },
  'relink.action': { zh: '重新指向文件夹…', en: 'Point to new folder…' },
  'relink.title': { zh: '「{name}」的文件夹不在原处了', en: 'The folder for "{name}" has moved' },
  'relink.was': { zh: '原来在', en: 'It was at' },
  'relink.loading': { zh: '正在找同名文件夹…', en: 'Looking for a folder with the same name…' },
  'relink.found': { zh: '在 {path} 找到同名文件夹', en: 'Folder with the same name at {path}' },
  'relink.remoteSame': { zh: 'git 远端相同：{remote}', en: 'Same git remote: {remote}' },
  'relink.remoteOther': { zh: 'git 远端：{remote}', en: 'Git remote: {remote}' },
  'relink.isProject': { zh: '已经是项目「{name}」', en: 'Already the project "{name}"' },
  'relink.other': { zh: '选择别的文件夹…', en: 'Choose another folder…' },
  'relink.choose': { zh: '选择文件夹…', en: 'Choose folder…' },
  'relink.changes': { zh: '会一起改', en: 'This also updates' },
  'relink.chSessions': { zh: '{n} 个会话的工作目录', en: 'Working folder of {n} chat(s)' },
  'relink.chMemory': { zh: '项目记忆（{n} 条）', en: 'Project memory ({n} entries)' },
  'relink.chSettings': { zh: '项目默认项：{list}', en: 'Project defaults: {list}' },
  'relink.listSep': { zh: '、', en: ', ' },
  'relink.s.defaultAgent': { zh: '默认 Agent', en: 'default agent' },
  'relink.s.defaultTeam': { zh: '默认 Team', en: 'default team' },
  'relink.s.model': { zh: '模型', en: 'model' },
  'relink.s.thinkingLevel': { zh: '思考档', en: 'thinking level' },
  'relink.s.approvalMode': { zh: '审批档', en: 'approval mode' },
  'relink.s.icon': { zh: '图标', en: 'icon' },
  'relink.note': { zh: '只改记录，不搬文件；会话正文里出现过的旧路径不改。', en: 'Only records change and no files are moved. Old paths inside chat messages stay as they are.' },
  'relink.cancel': { zh: '取消', en: 'Cancel' },
  'relink.submit': { zh: '重新指向', en: 'Point to folder' },
  'relink.conflict': { zh: '这个文件夹已经是项目「{name}」', en: 'This folder is already the project "{name}"' },
  'relink.mergeHint': { zh: '合并后，「{from}」的会话并到「{name}」里，两份项目记忆合并去重，「{name}」的默认项保留。', en: 'Merging moves the chats of "{from}" into "{name}" and combines both project memories without duplicates. The defaults of "{name}" are kept.' },
  'relink.merge': { zh: '合并', en: 'Merge' },
  'relink.fail': { zh: '没能重新指向，什么都没改：{e}', en: "Couldn't point to the folder. Nothing was changed: {e}" },
  'relink.loadFail': { zh: '读不到这个项目的信息：{e}', en: "Couldn't read this project: {e}" },
  'relink.done': { zh: '「{name}」已指向新文件夹', en: '"{name}" now points to the new folder' },
  'relink.merged': { zh: '已合并到「{name}」', en: 'Merged into "{name}"' },
})

const enabled = (): boolean => currentPlatform() === 'desktop' && !!window.tangu?.pickDirectory

const useMissing = create<{ paths: ReadonlySet<string> }>(() => ({ paths: new Set() }))
let inflight = false
let again = false
let wired = false
/** 问一次引擎哪些项目不在原处。同时只发一个;在途时又要问 → 等它回来再问一次(不丢)。 */
export function refreshMissingProjects(): void {
  if (!enabled()) return
  if (inflight) { again = true; return }
  inflight = true
  void getMissingProjects(homeTarget())
    .then((list) => useMissing.setState({ paths: new Set(list) }), () => { /* 老引擎 / 云端引擎没有这个端点:不标 */ })
    .finally(() => { inflight = false; if (again) { again = false; refreshMissingProjects() } })
}
/** 不在原处的项目路径(= 左栏本地项目的分组键)。挂上时问一次(= 进 Tangu),之后窗口每次重新获得焦点再问一次。
 *  projectKeys = 左栏现有的本地项目:它变了(会话从引擎拉回来了 / 加了项目)也再问一次 —— 刚启动挂上那一下,
 *  桌面配置可能还没读到,请求发去了缺省地址(真 Electron 台架里实测),只靠焦点的话要等用户切走再切回来才标得出。 */
export function useMissingProjects(projectKeys: string): ReadonlySet<string> {
  useEffect(() => {
    if (!wired && enabled()) { wired = true; window.addEventListener('focus', refreshMissingProjects) }
  }, [])
  useEffect(() => { if (projectKeys) refreshMissingProjects() }, [projectKeys])
  return useMissing((s) => s.paths)
}

const RELINKED = 'forsion:project-relinked'
/** 重新指向成功后,左栏顺序 / 收起状态 / 置顶这类按分组键存的本地偏好跟着换键。 */
export function onProjectRelinked(fn: (from: string, to: string) => void): () => void {
  const on = (e: Event): void => { const d = (e as CustomEvent<{ from: string; to: string }>).detail; if (d) fn(d.from, d.to) }
  window.addEventListener(RELINKED, on)
  return () => window.removeEventListener(RELINKED, on)
}
/** 列表里的旧键换成新键(合并时新键可能已经在里面:去重)。 */
export const swapKey = (list: readonly string[], from: string, to: string): string[] => [...new Set(list.map((k) => (k === from ? to : k)))]

const tilde = (p: string): string => {
  const home = useApp.getState().homeDir
  return home && (p === home || p.startsWith(home + '/')) ? '~' + p.slice(home.length) : p
}

/** 「重新指向文件夹…」对话框。sessionId = 这个项目里的任一会话(引擎只认会话行上的旧路径)。 */
export function ProjectRelinkDialog({ ws, sessionId, onClose }: { ws: WorkspaceDescriptor; sessionId: string; onClose: () => void }) {
  const { t } = useI18n()
  const [info, setInfo] = useState<RelinkInfo | null>(null)
  const [choice, setChoice] = useState<string | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [conflict, setConflict] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    getRelinkInfo(homeTarget(), sessionId).then((r) => {
      if (!live) return
      setInfo(r)
      setChoice(r.candidates.find((c) => c.remoteMatch)?.path ?? null) // 远端对上了才预选
    }, (e) => live && setError(t('relink.loadFail', { e: e?.message || e })))
    return () => { live = false }
  }, [sessionId])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const pick = async (): Promise<void> => {
    const dir = await window.tangu?.pickDirectory?.({ purpose: 'project' })
    if (dir) { setPicked(dir); setChoice(dir); setConflict(null) }
  }
  const submit = async (merge: boolean): Promise<void> => {
    if (!choice || busy) return
    setBusy(true); setError(null)
    try {
      const r = await relinkProject(homeTarget(), sessionId, choice, merge)
      if (!r.ok) { setConflict(r.name); return }
      const from = ws.key
      const to = r.path
      // 本地会话配置是 local-wins(loadHistory 拿它盖服务端的值):不换成引擎改好的值,下一条消息又把旧目录发回引擎。
      // 库里没存 cwd 的会话,缓存里那份是打开时按旧 project_path 补的,引擎不会回它 —— 照旧路径换(Codex 评审)。
      useApp.setState((s) => {
        const configBySession = { ...s.configBySession }
        for (const id of r.sessionIds) {
          const c = configBySession[id]
          if (!c) continue
          const next = r.configs?.[id]
          configBySession[id] = next ? { ...c, ...next } : c.cwd === from ? { ...c, cwd: to } : c
        }
        // 新对话正选着这个项目:换成新位置,不然发出去又建一个落在旧目录的会话(Codex 评审)
        const draft = s.newChatWs?.key === from ? { ...s.newChatWs, key: to, path: to, name: r.name ?? s.newChatWs.name } : s.newChatWs
        return { configBySession, newChatWs: draft, activeWorkspaceKey: s.activeWorkspaceKey === from ? to : s.activeWorkspaceKey, openWorkspaceKeys: swapKey(s.openWorkspaceKeys, from, to) }
      })
      window.dispatchEvent(new CustomEvent(RELINKED, { detail: { from, to } }))
      const app = useApp.getState()
      await app.refreshSessions(app.cfg).catch(() => {})
      refreshMissingProjects()
      app.toast(r.name ? t('relink.merged', { name: r.name }) : t('relink.done', { name: ws.name }))
      onClose()
    } catch (e: any) {
      setError(t('relink.fail', { e: e?.message || e }))
    } finally { setBusy(false) }
  }

  const settingsList = (keys: Array<keyof ProjectSettings>): string => keys.map((k) => t(`relink.s.${k}`)).join(t('relink.listSep'))
  const option = (path: string, title: string, sub: string[]) => (
    <label key={path} className="relink-opt">
      <input type="radio" name="relink-target" checked={choice === path} disabled={busy} onChange={() => { setChoice(path); setConflict(null) }} />
      <span className="relink-opt-copy">{title}{sub.map((x) => <small key={x}>{x}</small>)}</span>
    </label>
  )

  return createPortal(
    <div className="u-backdrop relink-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="modal modal-sm relink-dialog" role="dialog" aria-modal="true" aria-label={t('relink.title', { name: ws.name })}>
        <div className="modal-head">{t('relink.title', { name: ws.name })}<span className="grow" /><button type="button" className="relink-x" aria-label={t('relink.cancel')} disabled={busy} onClick={onClose}><X size={16} /></button></div>
        {conflict ? (
          <div className="modal-body relink-body">
            <p className="relink-conflict"><CircleAlert size={14} />{t('relink.conflict', { name: conflict })}</p>
            <p className="relink-note">{t('relink.mergeHint', { from: ws.name, name: conflict })}</p>
            {error && <p className="relink-err">{error}</p>}
          </div>
        ) : (
          <div className="modal-body relink-body">
            <div className="relink-note">{t('relink.was')} <code>{tilde(ws.key)}</code></div>
            {!info ? (error ? null : <p className="relink-note">{t('relink.loading')}</p>) : (
              <>
                {info.candidates.length > 0 ? (
                  <div className="relink-opts">
                    {info.candidates.map((c) => option(c.path, t('relink.found', { path: tilde(c.path) }), [
                      ...(c.remote ? [t(c.remoteMatch ? 'relink.remoteSame' : 'relink.remoteOther', { remote: c.remote })] : []),
                      ...(c.project ? [t('relink.isProject', { name: c.project })] : []),
                    ]))}
                    <label className="relink-opt">
                      <input type="radio" name="relink-target" checked={!!picked && choice === picked} disabled={busy} onChange={() => { if (picked) { setChoice(picked); setConflict(null) } }} onClick={() => { if (!picked || choice === picked) void pick() }} />
                      <span className="relink-opt-copy">{t('relink.other')}{picked && <small><code>{tilde(picked)}</code></small>}</span>
                    </label>
                  </div>
                ) : (
                  <div className="relink-pick">
                    <button type="button" className="btn" disabled={busy} onClick={() => void pick()}>{t('relink.choose')}</button>
                    {picked && <code>{tilde(picked)}</code>}
                  </div>
                )}
                <div className="relink-head">{t('relink.changes')}</div>
                <ul className="relink-list">
                  <li>{t('relink.chSessions', { n: String(info.sessions) })}</li>
                  {info.memoryEntries > 0 && <li>{t('relink.chMemory', { n: String(info.memoryEntries) })}</li>}
                  {info.settings.length > 0 && <li>{t('relink.chSettings', { list: settingsList(info.settings) })}</li>}
                </ul>
                <p className="relink-note">{t('relink.note')}</p>
              </>
            )}
            {error && <p className="relink-err">{error}</p>}
          </div>
        )}
        <div className="relink-foot">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>{t('relink.cancel')}</button>
          {conflict
            ? <button type="button" className="btn primary" disabled={busy} onClick={() => void submit(true)}>{t('relink.merge')}</button>
            : <button type="button" className="btn primary" disabled={busy || !choice} onClick={() => void submit(false)}>{t('relink.submit')}</button>}
        </div>
      </div>
    </div>,
    document.body,
  )
}
