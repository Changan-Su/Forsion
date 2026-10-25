/** 后台进程(run_background 起的)的界面件,数据在 processStore:
 *  - BgRow:摘要栏「后台」卡的一行(点行 = 看输出,地址 = 在 Desk 里预览,悬停露停止)
 *  - ProcessLogView:进程输出视图(type 'process-log',Desk 里开;Desk 不收文件时开标签页)
 *  - BgStrip:窄窗(摘要栏收起)时输入框上方那一行,点开向上弹清单
 *  口径(方案页「我替你定的细节」,用户 10-25 选 A):在跑 = 静止绿点(转圈留给 Agent 在干活);用户点停止直接停、
 *  不走审批(审批只拦 Agent 的 kill_process);进程不在这台电脑上时不给「打开」(engineHere:手机 / 别处的引擎,localhost 不是那台机器)。 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUpRight, ChevronDown, ChevronUp, Copy, Square } from 'lucide-react'
import { getView, useWorkspace, type ViewProps } from '@lcl/engine'
import { registerMessages, useI18n } from '../../i18n'
import { useApp } from '../../stores/appStore'
import { deskAcceptsFiles } from '../../amadeus/plugins/deskCompanion'
import { engineProcessOutput, stopEngineProcess, type EngineProcess } from '../../services/backendService'
import { hostDesktopMode, targetForSession } from '../../services/engine/targets'
import { refreshProcesses, useProcessPolling, useRunningCount, useSessionProcesses } from './processStore'

registerMessages({
  'bg.st.running': { zh: '运行中', en: 'Running' },
  'bg.st.done': { zh: '已结束', en: 'Finished' },
  'bg.st.failed': { zh: '出错退出（{code}）', en: 'Exited with {code}' },
  'bg.st.killed': { zh: '已停止', en: 'Stopped' },
  'bg.origin.remote': { zh: '远程', en: 'Remote' },
  'bg.origin.unattended': { zh: '无人值守', en: 'Unattended' },
  'bg.openLog': { zh: '查看输出', en: 'View output' },
  'bg.openUrl': { zh: '在 Agent Desk 中预览', en: 'Preview in Agent Desk' },
  'bg.stop': { zh: '停止', en: 'Stop' },
  'bg.copy': { zh: '复制输出', en: 'Copy output' },
  'bg.noOutput': { zh: '还没有输出', en: 'No output yet' },
  'bg.gone': { zh: '这个进程已不在（结束超过 30 分钟，或引擎重启过）', en: 'This process is gone (ended over 30 minutes ago, or the engine restarted)' },
  'bg.loadFailed': { zh: '读不到输出，正在重试', en: 'Could not read output, retrying' },
  'bg.view': { zh: '进程输出', en: 'Process output' },
  'bg.strip': { zh: '{n} 个在后台跑', en: '{n} running in background' },
  'bg.stripTitle': { zh: '在后台跑的', en: 'Running in background' },
  'bg.rowMark': { zh: '{n} 个后台进程在跑', en: '{n} background processes running' },
})

/** 与引擎 processRegistry 的每会话上限同值。 */
export const PROCESS_CAP = 10

export type RowState = 'running' | 'done' | 'failed' | 'killed'
export const rowState = (p: Pick<EngineProcess, 'status' | 'exitCode'>): RowState =>
  p.status === 'running' ? 'running' : p.status === 'killed' ? 'killed' : p.exitCode === 0 ? 'done' : 'failed'
const shortUrl = (u: string): string => u.replace(/^https?:\/\//, '').replace(/\/$/, '')
const stLabel = (t: (k: string, v?: Record<string, unknown>) => string, p: Pick<EngineProcess, 'status' | 'exitCode'>): string =>
  t(`bg.st.${rowState(p)}`, { code: p.exitCode ?? '?' })

/** 进程跑在这台电脑上才给「打开」:地址是那台机器的 localhost,在别的电脑上打开会开到不相干的服务(手机、
 *  外部模式连着别处的引擎、经 hub 的「我的电脑」会话都算别处)。外部模式连本机地址(自己起的 dev 引擎)算本机。 */
export function engineHere(sessionId: string): boolean {
  if (window.tangu?.mobile) return false
  const t = targetForSession(sessionId)
  if (t.via !== 'local') return false
  if (hostDesktopMode() === 'managed') return true
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(t.base).hostname) } catch { return false }
}

/** 这个会话的 Desk 收文件、而且真挂在 DOM 上(判据同 ChatWikiLink 的 openWebCitation)。 */
const deskHere = (sessionId: string): boolean =>
  deskAcceptsFiles(!!useApp.getState().desktopConfig?.agentDeskEnabled)
  && !!document.querySelector(`[data-desk-session="${CSS.escape(sessionId)}"]`)

/** 预览地址:内置浏览器在、Desk 收文件 → Desk 里的浏览器视图(和聊天里点网页引用同一条路);否则交给系统浏览器。 */
export function openProcessUrl(sessionId: string, url: string): void {
  if (getView('browser') && deskHere(sessionId)) {
    useApp.getState().deskShowFile(sessionId, url, { type: 'browser', params: { url, path: url } }, shortUrl(url))
    return
  }
  void import('../../builtins').then((m) => m.routeExternalUrl(url))
}

export function openProcessLog(sessionId: string, p: EngineProcess): void {
  const params = { sessionId, pid: p.id, command: p.command, path: `process:${sessionId}:${p.id}` }
  if (deskHere(sessionId)) {
    useApp.getState().deskShowFile(sessionId, params.path, { type: 'process-log', params }, p.command.length > 40 ? `${p.command.slice(0, 40)}…` : p.command)
    return
  }
  useWorkspace.getState().openView('process-log', params, 'main', { newTab: true })
}

export async function stopProcess(sessionId: string, pid: string): Promise<void> {
  await stopEngineProcess(targetForSession(sessionId), sessionId, pid).catch(() => {})
  await refreshProcesses()
}

export function BgRow({ p, sessionId, onOpen }: { p: EngineProcess; sessionId: string; onOpen?: () => void }) {
  const { t } = useI18n()
  const st = rowState(p)
  const tag = p.origin === 'unattended' ? t('bg.origin.unattended') : p.origin === 'remote' || p.origin === 'channel' ? t('bg.origin.remote') : null
  const canOpen = engineHere(sessionId)
  return (
    <div className="t2-tsum-row t2-bg-row" data-st={st}>
      <button type="button" className="t2-bg-main" title={`${p.command}\n${t('bg.openLog')}`} aria-label={`${p.command} — ${stLabel(t, p)}`}
        onClick={() => { onOpen?.(); openProcessLog(sessionId, p) }}>
        <span className="t2-bg-dot" data-st={st} aria-hidden />
        <span className="t2-tsum-row-tx t2-bg-cmd">{p.command}</span>
      </button>
      {tag && <span className="t2-bg-tag">{tag}</span>}
      {p.url ? (canOpen
        ? <button type="button" className="t2-bg-url" title={t('bg.openUrl')} onClick={() => { onOpen?.(); openProcessUrl(sessionId, p.url!) }}>{shortUrl(p.url)}<ArrowUpRight size={12} /></button>
        : <span className="t2-bg-url">{shortUrl(p.url)}</span>)
        : p.last ? <span className="t2-tsum-hits t2-bg-last" title={p.last}>{p.last}</span> : null}
      {st === 'running' && (
        <button type="button" className="t2-bg-stop" title={t('bg.stop')} aria-label={`${t('bg.stop')}: ${p.command}`} onClick={() => void stopProcess(sessionId, p.id)}>
          <Square size={9} />
        </button>
      )}
    </div>
  )
}

type LogData = EngineProcess & { output: string; truncated: boolean }

/** 进程输出:在跑时窗口可见 1s 一拉(不可见 5s),结束了拉最后一次就停;贴底时新输出跟着滚,往上翻了就不打扰。 */
export function ProcessLogView({ params }: ViewProps) {
  const { t } = useI18n()
  const sessionId = String(params?.sessionId ?? '')
  const pid = String(params?.pid ?? '')
  const [data, setData] = useState<LogData | null>(null)
  const [err, setErr] = useState<'gone' | 'retry' | null>(null)
  const pre = useRef<HTMLPreElement>(null)
  const stick = useRef(true)
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = (): void => {
      engineProcessOutput(targetForSession(sessionId), sessionId, pid).then((r) => {
        if (!alive) return
        setData(r)
        setErr(null)
        if (r.status === 'running') timer = setTimeout(load, document.visibilityState === 'visible' ? 1000 : 5000)
      }, (e: { status?: number }) => {
        if (!alive) return
        if (e?.status === 404) { setErr('gone'); return }
        setErr('retry')
        timer = setTimeout(load, 5000)
      })
    }
    load()
    return () => { alive = false; clearTimeout(timer) }
  }, [sessionId, pid])
  useLayoutEffect(() => { if (stick.current && pre.current) pre.current.scrollTop = pre.current.scrollHeight }, [data?.output])
  const command = data?.command ?? String(params?.command ?? '')
  const st = data ? rowState(data) : null
  return (
    <div className="t2-proclog">
      <div className="t2-proclog-bar">
        {st && <span className="t2-bg-dot" data-st={st} aria-hidden />}
        <span className="t2-proclog-cmd" title={command}>{command}</span>
        {data && <span className="t2-proclog-meta">{data.url && data.status === 'running' ? shortUrl(data.url) : stLabel(t, data)}</span>}
        <button type="button" className="icon-btn" title={t('bg.copy')} aria-label={t('bg.copy')} disabled={!data?.output}
          onClick={() => void navigator.clipboard?.writeText(data?.output ?? '')}>
          <Copy size={13} />
        </button>
        {data?.status === 'running' && (
          <button type="button" className="icon-btn" title={t('bg.stop')} aria-label={t('bg.stop')}
            onClick={() => void stopProcess(sessionId, pid).then(() => engineProcessOutput(targetForSession(sessionId), sessionId, pid).then(setData, () => {}))}>
            <Square size={12} />
          </button>
        )}
      </div>
      {err === 'gone' && !data ? <div className="t2-proclog-note">{t('bg.gone')}</div> : (
        <pre ref={pre} className="t2-proclog-out"
          onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8 }}>
          {data?.truncated ? '…\n' : ''}{data ? data.output || t('bg.noOutput') : ''}
        </pre>
      )}
      {err === 'retry' && <div className="t2-proclog-note">{t('bg.loadFailed')}</div>}
    </div>
  )
}

/** 窄窗那一行:只有在跑的才出现,摘要栏在场时由 CSS 藏掉(chat2.css .t2-bgstrip 的容器查询)。 */
export function BgStrip({ sessionId }: { sessionId: string }) {
  const { t } = useI18n()
  const procs = useSessionProcesses(sessionId)
  const running = procs.filter((p) => p.status === 'running')
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const [at, setAt] = useState<{ x: number; bottom: number } | null>(null)
  useEffect(() => { setOpen(false) }, [sessionId])
  useEffect(() => {
    if (!open) return
    const r = btn.current?.getBoundingClientRect()
    const z = (btn.current as (HTMLElement & { currentCSSZoom?: number }) | null)?.currentCSSZoom || 1
    if (r) setAt({ x: r.left / z, bottom: (window.innerHeight - r.top) / z + 6 })
    const close = (e: Event): void => { if (!(e.target as Element)?.closest?.('.t2-bgpop, .t2-bgstrip')) setOpen(false) }
    const esc = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('pointerdown', close, true); window.removeEventListener('keydown', esc) }
  }, [open])
  if (!running.length) return null
  const url = running.find((p) => p.url)?.url
  return (
    <>
      <div className="t2-bgstrip">
        <button ref={btn} type="button" className="t2-bgstrip-main" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span className="t2-bg-dot" data-st="running" aria-hidden />
          <span>{t('bg.strip', { n: running.length })}</span>
          {open ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
        </button>
        {url && engineHere(sessionId) && (
          <button type="button" className="t2-bg-url" title={t('bg.openUrl')} onClick={() => openProcessUrl(sessionId, url)}>
            {shortUrl(url)}<ArrowUpRight size={12} />
          </button>
        )}
      </div>
      {open && at && createPortal(
        <div className="t2-bgpop" role="dialog" aria-label={t('bg.stripTitle')} style={{ left: at.x, bottom: at.bottom }}>
          <div className="t2-bgpop-title">{t('bg.stripTitle')}</div>
          {running.map((p) => <BgRow key={p.id} p={p} sessionId={sessionId} onOpen={() => setOpen(false)} />)}
        </div>,
        document.body,
      )}
    </>
  )
}

/** 左栏会话行尾:这条会话还有进程在后台跑 → 绿点 + 个数(没有就不画)。 */
export function SessionBgMark({ sessionId }: { sessionId: string }) {
  const { t } = useI18n()
  useProcessPolling()
  const n = useRunningCount(sessionId)
  if (!n) return null
  return <span className="t2s-bg" title={t('bg.rowMark', { n })} aria-label={t('bg.rowMark', { n })}><i aria-hidden />{n}</span>
}
