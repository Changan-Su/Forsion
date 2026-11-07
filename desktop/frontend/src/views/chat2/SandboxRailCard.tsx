/**
 * 摘要栏(右栏)的沙箱卡:只在发起沙箱的那个对话里出现。最近一张截图当缩略图(点图 = 打开沙箱窗口),
 * 下面一行事实 + 最近一步 + 动作。停了变灰给「重新启动」,装载失败给报错 + 打开窗口 / 重置数据。
 * 状态是主进程的实时那份(pluginSandbox:state / changed);图另向 lastShot 要,shotAt 变了才取一次。
 * 插件说的话(名字、报错、视图名)一律当纯文本渲染。
 */
import { useEffect, useState } from 'react'
import { AppWindow, Camera, CircleAlert, CircleCheck, Download, FlaskConical, Loader2, Play, RotateCcw, TriangleAlert } from 'lucide-react'
import { registerMessages, useI18n } from '../../i18n'
import { SummaryCard } from './TaskSummary'
import type { PluginSandboxState } from '../../types'
import './pluginSandboxCard.css'

registerMessages({
  'sandbox.rail.title': { zh: '沙箱', en: 'Sandbox' },
  'sandbox.rail.facts': { zh: '{views} 个视图 · 控制台 {errors} 错', en: '{views} views · {errors} console errors' },
  'sandbox.rail.factsSpace': { zh: '{views} 个视图 · Space「{space}」· 控制台 {errors} 错', en: '{views} views · Space "{space}" · {errors} console errors' },
  'sandbox.rail.last': { zh: '最近一步：{op}', en: 'Last step: {op}' },
  'sandbox.rail.minutes': { zh: '{n} 分钟前', en: '{n} min ago' },
  'sandbox.rail.hours': { zh: '{n} 小时前', en: '{n} h ago' },
  'sandbox.rail.stopped.idle': { zh: '闲置 15 分钟已停', en: 'Stopped after 15 idle minutes' },
  'sandbox.rail.stopped.exited': { zh: '窗口已关闭', en: 'Window closed' },
  'sandbox.rail.stopped.stopped': { zh: '已停止', en: 'Stopped' },
  'sandbox.rail.op.start': { zh: '启动', en: 'start' },
  'sandbox.rail.op.reset': { zh: '重置', en: 'reset' },
  'sandbox.rail.op.screenshot': { zh: '截图', en: 'screenshot' },
  'sandbox.rail.op.command': { zh: '运行命令', en: 'run a command' },
  'sandbox.rail.op.read': { zh: '读页面', en: 'read the page' },
  'sandbox.rail.op.click': { zh: '点击', en: 'click' },
  'sandbox.rail.op.type': { zh: '输入', en: 'type' },
  'sandbox.rail.op.press': { zh: '按键', en: 'press keys' },
  'sandbox.rail.op.scroll': { zh: '滚动', en: 'scroll' },
  'sandbox.rail.op.space': { zh: '切换 Space', en: 'switch Space' },
  'sandbox.rail.op.files': { zh: '备好文件', en: 'prepare files' },
})

const OPS = new Set(['start', 'reset', 'screenshot', 'command', 'read', 'click', 'type', 'press', 'scroll', 'space', 'files'])

/** 这个对话的沙箱(在跑的,或上一个由它发起、已经停了的);别的对话 / 没有沙箱控制面 = null。 */
export function useSandboxRail(sessionId: string | null | undefined): PluginSandboxState | null {
  const api = window.tangu?.pluginSandbox
  const [live, setLive] = useState<PluginSandboxState | null>(null)
  useEffect(() => {
    if (!api) return
    let alive = true
    void api.state().then((s) => { if (alive) setLive(s) }, () => {})
    const off = api.onChanged((s) => setLive(s))
    return () => { alive = false; off() }
  }, [api])
  if (!sessionId || !live) return null
  return (live.running ? live.sessionId : live.last?.sessionId) === sessionId ? live : null
}

function useLastShot(sessionId: string, shotAt: number | undefined): string | null {
  const [img, setImg] = useState<{ at: number; image: string } | null>(null)
  useEffect(() => {
    const api = window.tangu?.pluginSandbox
    if (!api?.lastShot || !shotAt || img?.at === shotAt) return
    let alive = true
    void api.lastShot(sessionId).then((r) => { if (alive && r) setImg(r) }, () => {})
    return () => { alive = false }
  }, [sessionId, shotAt, img?.at])
  return img?.image ?? null
}

export function SandboxRailCard({ live, sessionId, open, onToggle, bodyCap, squeezed }: {
  live: PluginSandboxState
  sessionId: string
  open: boolean
  onToggle: (open: boolean) => void
  bodyCap?: number
  squeezed?: boolean
}) {
  const { t } = useI18n()
  const api = window.tangu?.pluginSandbox
  const [busy, setBusy] = useState<'reset' | 'install' | 'start' | null>(null)
  const [note, setNote] = useState('')
  const shot = useLastShot(sessionId, live.running ? live.shotAt : undefined)
  // 停了以后图留着(变灰):shotAt 不再有,用上一次取到的
  const st = live.running ? live.status : null
  const state = !live.running ? 'stopped' : st?.state ?? 'starting'
  const name = live.running ? live.name : live.last?.name
  const version = live.running ? live.version : live.last?.version
  const dir = live.running ? live.dir : live.last?.dir
  const bad = state === 'failed' || state === 'blocked'
  const tag = state === 'running' ? t('sandbox.card.running') : state === 'starting' ? t('sandbox.card.starting')
    : state === 'failed' ? t('sandbox.card.failed') : state === 'blocked' ? t('sandbox.card.blocked') : t('sandbox.card.stopped')
  const ago = (at: number): string => {
    const m = Math.floor((Date.now() - at) / 60_000)
    return m < 1 ? t('time.justNow') : m < 60 ? t('sandbox.rail.minutes', { n: m }) : t('sandbox.rail.hours', { n: Math.floor(m / 60) })
  }
  const run = async (what: 'reset' | 'install' | 'start') => {
    if (!api || busy) return
    setBusy(what); setNote('')
    try {
      if (what === 'install') {
        const r = await api.install()
        if (r.ok) setNote(t('sandbox.card.installed'))
        else if (!r.cancelled && r.error) setNote(r.error)
      } else {
        const r = what === 'reset' ? await api.reset() : await api.exec('start', { dir }, { sessionId, reveal: true })
        if (!r.ok && r.error) setNote(r.error)
      }
    } finally { setBusy(null) }
  }
  const spin = (w: typeof busy, icon: React.ReactNode) => (busy === w ? <Loader2 size={14} className="spin" /> : icon)
  const row = (key: string, icon: React.ReactNode, text: string, end: string, onClick?: () => void, disabled = false) => onClick
    ? <button key={key} type="button" className="t2-tsum-row act" disabled={disabled} onClick={onClick}>{icon}<span className="t2-tsum-row-tx">{text}</span>{end && <span className="t2-tsum-hits">{end}</span>}</button>
    : <div key={key} className="t2-tsum-row">{icon}<span className="t2-tsum-row-tx">{text}</span>{end && <span className="t2-tsum-hits">{end}</span>}</div>
  const errorText = st?.blocked || st?.setupError || st?.mountErrors[0]?.message || ''
  const op = live.running && live.lastOp && OPS.has(live.lastOp.op) ? live.lastOp : null

  return (
    <SummaryCard id="sandbox" className="sbx-rail" open={open} onToggle={onToggle} bodyCap={bodyCap} squeezed={squeezed}
      head={<span className="sbx-rail-head"><FlaskConical size={13} /><span>{t('sandbox.rail.title')}</span>{name && <span className="t2-card-hint">{name} {version}</span>}</span>}
      actions={<span className={`t2-taskcard-tag${state === 'running' || state === 'starting' ? ' sbx-tag-run' : bad ? ' sbx-tag-bad' : ''}`}>{tag}</span>}>
      {bad && !!errorText && <div className="sbx-fact bad sbx-rail-fact"><CircleAlert size={13} /><span>{errorText}</span></div>}
      {!bad && shot && (
        <button type="button" className="sbx-rail-shot" data-off={state === 'stopped' || undefined} title={t('sandbox.card.open')} aria-label={t('sandbox.card.open')}
          disabled={state === 'stopped'} onClick={() => void api?.show()}>
          <img src={shot} alt="" />
        </button>
      )}
      {state === 'running' && st && (
        <div className={`sbx-fact ${st.errorCount ? 'bad' : st.views.length ? 'ok' : 'warn'} sbx-rail-fact`}>
          {st.errorCount ? <CircleAlert size={13} /> : st.views.length ? <CircleCheck size={13} /> : <TriangleAlert size={13} />}
          <span>{st.spaces[0]
            ? t('sandbox.rail.factsSpace', { views: st.views.length, space: st.spaces[0], errors: st.errorCount })
            : t('sandbox.rail.facts', { views: st.views.length, errors: st.errorCount })}</span>
        </div>
      )}
      {op && row('last', <Camera size={14} />, t('sandbox.rail.last', { op: t(`sandbox.rail.op.${op.op}`) }), ago(op.at))}
      {state === 'stopped' && row('restart', spin('start', <Play size={14} />), t('sandbox.card.restart'), t(`sandbox.rail.stopped.${live.last?.reason ?? 'stopped'}`), () => void run('start'), !!busy || !dir)}
      {bad && row('open', <AppWindow size={14} />, t('sandbox.card.open'), st?.errorCount ? String(st.errorCount) : '', () => void api?.show())}
      {bad && row('reset', spin('reset', <RotateCcw size={14} />), t('sandbox.card.reset'), '', () => void run('reset'), !!busy)}
      {state === 'running' && row('install', spin('install', <Download size={14} />), t('sandbox.card.install'), '', () => void run('install'), !!busy)}
      {!!note && <div className="sbx-rail-note">{note}</div>}
    </SummaryCard>
  )
}
