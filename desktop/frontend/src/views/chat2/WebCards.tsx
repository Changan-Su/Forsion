/**
 * 宿主原生的本地网页卡 / 服务卡(网页卡片方案第二轮选 1,10-28):各自跟着产生它的那次工具出,卡身是 components/WebCard。
 *  - 本地网页卡:这一回合 write_file / edit_file / multi_edit / apply_patch 写出的 .html(多个只给入口:index.html 优先,否则第一个写的),
 *    挂在对它的最后一次写上;所在项目有 package.json 不出(Vite 这类的 index.html 直接开是空白,等跑起来出服务卡)。
 *    display_file 一个 .html 也画这张,代替文件名小卡。
 *  - 服务卡:run_background 回的进程 id 对上 /agent/processes 里同一条(和「后台」卡同一份数据),认出本机地址才出。
 * 要模型做的按钮(发布… / 让 Tangu 重新运行… / 让 Tangu 看看…)= 往对话发一句话,卡上不直接执行。
 * ponytail: 只画引擎在这台电脑上的会话(engineHere);云沙箱 / 别的电脑上的会话照旧是工具行 + 文件小卡。
 */
import { useEffect, useMemo, useState } from 'react'
import { PanelRight } from 'lucide-react'
import type { ToolEvent } from '../../types'
import { WebCard, type WebCardAction, type WebCardProps } from '../../components/WebCard'
import { registerMessages, useI18n } from '../../i18n'
import { formatTime } from '../../format/time'
import { useApp } from '../../stores/appStore'
import { agentWriteTargets, resolveDeskPath } from '../../stores/deskPlan'
import { openPluginContextMenu, type PluginMenuEntry } from '../../amadeus/plugins/contextMenuSurface'
import { engineHere, openProcessLog, openProcessUrl, rowState, stopProcess } from './BackgroundProcs'
import { useProcessPolling, useSessionProcesses } from './processStore'
import '../../components/PluginToolCard.css'

registerMessages({
  'webcard.local.title': { zh: '网页', en: 'Web page' },
  'webcard.service.title': { zh: '本地服务', en: 'Local server' },
  'webcard.local.pill': { zh: '本地', en: 'Local' },
  'webcard.local.note': { zh: '只在这台电脑上，还没发布', en: 'Only on this computer, not published' },
  'webcard.local.published': { zh: '已发布', en: 'Published' },
  'webcard.local.publishedNote': { zh: '已经发布成网页：{url}', en: 'Published as a web page: {url}' },
  'webcard.local.gone': { zh: '文件不在了', en: 'File is gone' },
  'webcard.service.note': { zh: '{command} · 只在这台电脑上能打开', en: '{command} · Opens only on this computer' },
  'webcard.service.remoteNote': { zh: '{command} · 在别的设备上跑，这台设备打不开它的 localhost', en: '{command} · Running on another device, so its localhost does not open here' },
  'webcard.preview': { zh: '预览', en: 'Preview' },
  'webcard.openInDesk': { zh: '在 Desk 打开', en: 'Open in Desk' },
  'webcard.openBrowser': { zh: '在浏览器打开', en: 'Open in browser' },
  'webcard.publish': { zh: '发布…', en: 'Publish…' },
  'webcard.seeLive': { zh: '去看线上版', en: 'Go to the live page' },
  'webcard.output': { zh: '输出', en: 'Output' },
  'webcard.rerun': { zh: '让 Tangu 重新运行…', en: 'Ask Tangu to run it again…' },
  'webcard.lookAt': { zh: '让 Tangu 看看…', en: 'Ask Tangu to take a look…' },
  'webcard.buildPublish': { zh: '构建后发布…', en: 'Build and publish…' },
  'webcard.copyPath': { zh: '复制路径', en: 'Copy path' },
  'webcard.copyUrl': { zh: '复制地址', en: 'Copy address' },
  'webcard.reveal': { zh: '在访达中显示', en: 'Show in Finder' },
  'webcard.revealWin': { zh: '在文件资源管理器中显示', en: 'Show in File Explorer' },
  'webcard.ask.publish': { zh: '把 {path} 发布成网页', en: 'Publish {path} as a web page' },
  'webcard.ask.rerun': { zh: '重新运行 `{command}`', en: 'Run `{command}` again' },
  'webcard.ask.look': { zh: '`{command}` 出错退出了（{code}），帮我看看', en: '`{command}` exited with {code}. Can you take a look?' },
  'webcard.ask.buildPublish': { zh: '先构建这个项目（现在用 `{command}` 跑着），再把构建产物发布成网页', en: 'Build this project (it is running with `{command}`), then publish the build output as a web page' },
})

export type WebCardSpec = { kind: 'local'; path: string } | { kind: 'service'; processId: string; command: string }

const HTML_RE = /\.html?$/i
const START_RE = /^started background process (\S+)/
const succeeded = (ev: ToolEvent): boolean => ev.done && !ev.isError && !ev.parked && !/^Error[:\s]/i.test(ev.result || '')
const argsOf = (ev: ToolEvent): Record<string, unknown> => { try { const v = JSON.parse(ev.arguments || '{}'); return v && typeof v === 'object' ? v : {} } catch { return {} } }

/** 一条消息里哪些工具调用后面跟网页卡(调用 id → 卡)。 */
export function planWebCards(events: ToolEvent[] | undefined, cwd?: string): Map<string, WebCardSpec> {
  const out = new Map<string, WebCardSpec>()
  const lastWrite = new Map<string, string>() // 路径 → 最后写它的调用;Map 保留第一次写的先后
  let pkg = false
  for (const ev of events ?? []) {
    if (!succeeded(ev)) continue
    if (ev.name === 'run_background') {
      const m = START_RE.exec(ev.result || '')
      if (m) out.set(ev.id, { kind: 'service', processId: m[1], command: String(argsOf(ev).command ?? '') })
      continue
    }
    for (const p of agentWriteTargets(ev.name, ev.arguments, cwd)) {
      if (/(^|[\\/])package\.json$/.test(p)) pkg = true
      if (HTML_RE.test(p)) lastWrite.set(p, ev.id)
    }
  }
  if (!pkg && lastWrite.size) {
    const paths = [...lastWrite.keys()]
    const entry = paths.find((p) => /(^|[\\/])index\.html?$/i.test(p)) ?? paths[0]
    out.set(lastWrite.get(entry)!, { kind: 'local', path: entry })
  }
  return out
}

export const isHtmlFile = (path: string | undefined): boolean => !!path && HTML_RE.test(path)

const sessionCwd = (sid: string): string | undefined => {
  const s = useApp.getState()
  return s.configBySession[sid]?.cwd || s.sessions.find((x) => x.id === sid)?.project_path || undefined
}
export const useSessionCwd = (sid: string | undefined): string | undefined =>
  useApp((s) => (sid ? s.configBySession[sid]?.cwd || s.sessions.find((x) => x.id === sid)?.project_path || undefined : undefined))

const dirOf = (p: string): string => p.replace(/[\\/][^\\/]*$/, '')
const tilde = (p: string): string => p.replace(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=[\\/])/, '~')
const shortUrl = (u: string): string => u.replace(/^https?:\/\//, '').replace(/\/$/, '')
const IS_MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)

const served = new Map<string, Promise<string | null>>()
/** 本地文件 → 本机令牌根地址(同一路径只要一次)。 */
function servePath(path: string): Promise<string | null> {
  let p = served.get(path)
  if (!p) {
    const serve = window.tangu?.codePreviewServePath
    p = serve ? serve(path).then((r) => r.url, () => null) : Promise.resolve(null)
    served.set(path, p)
  }
  return p
}

/** 文件在不在、所在项目(往上到 cwd,最多 4 层)有没有 package.json。statPath 读不了 = 当作在、没有。 */
function useLocalFile(path: string, cwd: string | undefined): { state: 'loading' | 'ok' | 'gone' | 'project'; mtime: number } {
  const [v, setV] = useState<{ state: 'loading' | 'ok' | 'gone' | 'project'; mtime: number }>({ state: 'loading', mtime: 0 })
  useEffect(() => {
    const stat = window.tangu?.statPath
    if (!stat) { setV({ state: 'ok', mtime: 0 }); return }
    let live = true
    void (async () => {
      const st = await stat(path).catch(() => null)
      if (!st) { if (live) setV({ state: 'gone', mtime: 0 }); return }
      const stop = cwd ? cwd.replace(/[\\/]+$/, '') : ''
      let dir = dirOf(path)
      for (let i = 0; i < 4 && dir; i++) {
        if (await stat(`${dir}/package.json`).catch(() => null)) { if (live) setV({ state: 'project', mtime: st.mtimeMs }); return }
        if (dir === stop) break
        const up = dirOf(dir)
        if (up === dir) break
        dir = up
      }
      if (live) setV({ state: 'ok', mtime: st.mtimeMs })
    })()
    return () => { live = false }
  }, [path, cwd])
  return v
}

/** 这条会话里之后有没有把这个文件(或它所在的目录)发布出去:有就回线上地址。 */
function usePublishedUrl(sid: string, path: string): string | null {
  return useApp((s) => {
    const cwd = sessionCwd(sid)
    for (const m of s.messagesBySession[sid] ?? []) {
      for (const ev of m.toolEvents ?? []) {
        if (ev.name !== 'publish_web_page' || !succeeded(ev)) continue
        const a = argsOf(ev)
        if (a.action === 'unpublish' || typeof a.path !== 'string') continue
        const target = resolveDeskPath(a.path, cwd)
        if (target !== path && target !== dirOf(path)) continue
        const url = /\bat (https?:\/\/\S+?)[\s)]/.exec(ev.result || '')?.[1]
        if (url) return url
      }
    }
    return null
  })
}

function CardShell({ title, onDesk, children }: { title: string; onDesk?: () => void; children: React.ReactNode }) {
  const { t } = useI18n()
  return (
    <div className="sketch-card plugin-tool-card web-card-host" data-web-card-host="">
      <div className="sketch-card-head">
        <span className="sketch-card-title">{title}</span>
        {onDesk && !window.tangu?.mobile && (
          <button type="button" className="t2-iconbtn" data-act="web-card-desk" title={t('webcard.openInDesk')} aria-label={t('webcard.openInDesk')} onClick={onDesk}>
            <PanelRight size={14} />
          </button>
        )}
      </div>
      <div className="plugin-tool-card-body inline">{children}</div>
    </div>
  )
}

const menuAt = (anchor: HTMLElement, items: PluginMenuEntry[]): void => { openPluginContextMenu({ anchor, align: 'end' }, items, (run) => run()) }
const copy = (text: string): void => { void navigator.clipboard?.writeText(text).catch(() => {}) }

export function LocalWebCard({ sessionId, path, onAsk }: { sessionId: string; path: string; onAsk?: (text: string) => void }) {
  const { t } = useI18n()
  const cwd = useSessionCwd(sessionId)
  const file = useLocalFile(path, cwd)
  const live = usePublishedUrl(sessionId, path)
  const [url, setUrl] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  useEffect(() => { let on = true; void servePath(path).then((u) => { if (on) setUrl(u) }); return () => { on = false } }, [path])
  if (file.state === 'loading' || file.state === 'project') return null
  const gone = file.state === 'gone'
  const fileName = path.split(/[\\/]/).pop() || path
  const preview = (): void => { if (url) openProcessUrl(sessionId, url) }
  const menu: PluginMenuEntry[] = [
    ...(window.tangu?.revealHostPath && !gone ? [{ kind: 'item' as const, label: t(IS_MAC ? 'webcard.reveal' : 'webcard.revealWin'), icon: 'folder', run: () => { void window.tangu!.revealHostPath!(path) } }] : []),
    { kind: 'item', label: t('webcard.copyPath'), icon: 'copy', run: () => copy(path) },
  ]
  const actions: WebCardAction[] = gone ? [] : [
    { key: 'preview', label: t('webcard.preview'), onClick: preview, disabled: !url },
    ...(live ? [] : [{ key: 'browser', label: t('webcard.openBrowser'), onClick: () => { if (url) void window.tangu?.openExternal?.(url) }, disabled: !url }]),
  ]
  const trailing: WebCardAction[] = gone ? [] : live
    ? [{ key: 'live', label: t('webcard.seeLive'), onClick: () => openProcessUrl(sessionId, live) }]
    : onAsk ? [{ key: 'publish', label: t('webcard.publish'), onClick: () => onAsk(t('webcard.ask.publish', { path })) }] : []
  const props: WebCardProps = {
    name: title || fileName,
    status: gone ? { label: t('webcard.local.gone'), tone: 'muted' } : live ? { label: t('webcard.local.published'), tone: 'ok' } : { label: t('webcard.local.pill'), tone: 'muted' },
    address: { text: tilde(path), icon: 'file', struck: gone },
    note: gone ? undefined : live ? t('webcard.local.publishedNote', { url: shortUrl(live) }) : t('webcard.local.note'),
    thumbnail: !gone && url ? { url, version: String(file.mtime) } : null,
    actions, trailing, onMore: (a) => menuAt(a, menu), onTitle: setTitle,
  }
  return <CardShell title={t('webcard.local.title')} onDesk={gone || !url ? undefined : preview}><WebCard {...props} /></CardShell>
}

const knownUrl = new Map<string, string>() // ponytail: 进程结束后引擎不再给 url,记在内存里;重开应用后已结束的服务卡不再出

export function ServiceWebCard({ sessionId, processId, command, onAsk }: { sessionId: string; processId: string; command: string; onAsk?: (text: string) => void }) {
  const { t } = useI18n()
  useProcessPolling()
  const list = useSessionProcesses(sessionId)
  const p = useMemo(() => list.find((x) => x.id === processId), [list, processId])
  const [title, setTitle] = useState('')
  if (p?.url) knownUrl.set(`${sessionId}:${processId}`, p.url)
  const url = p?.url || knownUrl.get(`${sessionId}:${processId}`)
  if (!p || !url) return null
  const here = engineHere(sessionId)
  const st = rowState(p)
  const cmd = p.command || command
  const running = st === 'running'
  const menu: PluginMenuEntry[] = [
    { kind: 'item', label: t('webcard.copyUrl'), icon: 'copy', run: () => copy(url) },
    ...(onAsk ? [{ kind: 'item' as const, label: t('webcard.buildPublish'), icon: 'globe', run: () => onAsk(t('webcard.ask.buildPublish', { command: cmd })) }] : []),
  ]
  const output: WebCardAction = { key: 'output', label: t('webcard.output'), onClick: () => openProcessLog(sessionId, p) }
  const actions: WebCardAction[] = running && here
    ? [
        { key: 'preview', label: t('webcard.preview'), onClick: () => openProcessUrl(sessionId, url) },
        { key: 'browser', label: t('webcard.openBrowser'), onClick: () => { void window.tangu?.openExternal?.(url) } },
        output,
      ]
    : [output]
  const trailing: WebCardAction[] = running
    ? [{ key: 'stop', label: t('bg.stop'), onClick: () => { void stopProcess(sessionId, p.id) } }]
    : !onAsk ? []
    : st === 'failed' ? [{ key: 'look', label: t('webcard.lookAt'), onClick: () => onAsk(t('webcard.ask.look', { command: cmd, code: p.exitCode ?? '?' })) }]
    : [{ key: 'rerun', label: t('webcard.rerun'), onClick: () => onAsk(t('webcard.ask.rerun', { command: cmd })) }]
  const ended = p.endedAt ? ` – ${formatTime(p.endedAt)}` : ''
  const props: WebCardProps = {
    name: title || cmd,
    status: {
      label: t(`bg.st.${st}`, { code: p.exitCode ?? '?' }),
      tone: st === 'failed' ? 'danger' : running ? 'neutral' : 'muted',
      dot: running ? 'running' : st === 'failed' ? 'failed' : 'stopped',
    },
    address: { text: shortUrl(url), icon: 'globe', struck: !running, muted: running && !here },
    note: st === 'failed' && p.last ? p.last
      : running && !here ? t('webcard.service.remoteNote', { command: cmd })
      : running ? t('webcard.service.note', { command: cmd })
      : `${cmd} · ${formatTime(p.startedAt)}${ended}`,
    thumbnail: running && here ? { url, version: String(p.startedAt) } : null,
    actions, trailing, onMore: (a) => menuAt(a, menu), onTitle: setTitle,
  }
  return <CardShell title={t('webcard.service.title')} onDesk={running && here ? () => openProcessUrl(sessionId, url) : undefined}><WebCard {...props} /></CardShell>
}

export function HostWebCard({ spec, sessionId, onAsk }: { spec: WebCardSpec; sessionId?: string; onAsk?: (text: string) => void }) {
  if (!sessionId || !engineHere(sessionId)) return null
  return spec.kind === 'local'
    ? <LocalWebCard sessionId={sessionId} path={spec.path} onAsk={onAsk} />
    : <ServiceWebCard sessionId={sessionId} processId={spec.processId} command={spec.command} onAsk={onAsk} />
}
