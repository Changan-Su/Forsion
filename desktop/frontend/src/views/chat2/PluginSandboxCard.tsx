/**
 * 对话里的沙箱卡(任务卡一族):plugin_sandbox start / reset 成功后替掉那一行工具调用。
 * 历史形状来自工具结果末尾嵌的 <sandbox-status>;桌面上再订主进程的实时状态(同一个插件还在跑就用实时的)。
 * 手机 / 网页没有沙箱控制面:只读结果,提示到电脑上打开。插件说的话(名字、报错、视图名)一律当纯文本渲染。
 */
import { useEffect, useState } from 'react'
import { AppWindow, CircleAlert, CircleCheck, Download, FlaskConical, Loader2, Play, RotateCcw, TriangleAlert } from 'lucide-react'
import type { ToolEvent } from '../../../../../tangu-agent/src/contracts/clientTypes'
import { registerMessages, useI18n } from '../../i18n'
import { extractSandboxStatus, type SandboxStatus } from '../../../../../tangu-agent/src/contracts/pluginSandbox'
import './pluginSandboxCard.css'

registerMessages({
  'sandbox.card.title': { zh: '沙箱：{name} {version}', en: 'Sandbox: {name} {version}' },
  'sandbox.card.isolated': { zh: '隔离数据 · 未登录', en: 'Isolated data · signed out' },
  'sandbox.card.starting': { zh: '启动中', en: 'Starting' },
  'sandbox.card.running': { zh: '运行中', en: 'Running' },
  'sandbox.card.failed': { zh: '启动失败', en: 'Failed to load' },
  'sandbox.card.blocked': { zh: '被宿主拦下', en: 'Blocked by the host' },
  'sandbox.card.stopped': { zh: '已停止', en: 'Stopped' },
  'sandbox.card.views': { zh: '加载正常，注册了视图 {list}', en: 'Loaded; registered views {list}' },
  'sandbox.card.noViews': { zh: '加载没报错，但一个视图也没注册', en: 'Loaded without an error, but registered no views' },
  'sandbox.card.hidden': { zh: 'Space {slug} 没有显示', en: 'Space {slug} is hidden' },
  'sandbox.card.console': { zh: '控制台 {errors} 条错误、{warns} 条警告', en: 'Console: {errors} errors, {warns} warnings' },
  'sandbox.card.about': {
    zh: '这份 Forsion 是独立的：自己的空智库、未登录，不碰你的笔记。可以打开窗口亲手试，有问题点窗口里的「报告问题」。',
    en: 'This Forsion is separate: its own empty vault, signed out, and it never touches your notes. Open the window to try it yourself; use Report a problem there if something is off.',
  },
  'sandbox.card.elsewhere': { zh: '沙箱跑在你的电脑上。要上手试，请到电脑上打开沙箱窗口。', en: 'The sandbox runs on your computer. To try it yourself, open the sandbox window there.' },
  'sandbox.card.open': { zh: '打开沙箱窗口', en: 'Open sandbox window' },
  'sandbox.card.reset': { zh: '重置数据', en: 'Reset data' },
  'sandbox.card.install': { zh: '安装到我的 Forsion', en: 'Install in my Forsion' },
  'sandbox.card.installed': { zh: '已安装到你的 Forsion', en: 'Installed in your Forsion' },
  'sandbox.card.restart': { zh: '重新启动', en: 'Start again' },
})

/** 沙箱控制面的实时状态(形状跟着全局 window.tangu 的声明走,不为一个类型跨 tangu-boundary 引宿主的 types.ts)。 */
type LiveSandbox = Awaited<ReturnType<NonNullable<NonNullable<Window['tangu']>['pluginSandbox']>['state']>>

export const isSandboxCardTool = (ev: ToolEvent): boolean =>
  ev.name === 'plugin_sandbox' && ev.done && !ev.isError && !!extractSandboxStatus(ev.result)

/** 用户那份桌面 Forsion 的沙箱实时状态(其余端 = null)。
 * ponytail: Coding Studio 的 SandboxPanel 里有同样的一份 —— 卡片在 Tangu 界面这边,共用一份就得跨 tangu-boundary 加依赖,十行不值得。 */
function useLiveSandbox(): LiveSandbox | null {
  const api = window.tangu?.pluginSandbox
  const [live, setLive] = useState<LiveSandbox | null>(null)
  useEffect(() => {
    if (!api) return
    let alive = true
    void api.state().then((s) => { if (alive) setLive(s) }, () => {})
    const off = api.onChanged((s) => setLive(s))
    return () => { alive = false; off() }
  }, [api])
  return live
}

export function PluginSandboxCard({ event }: { event: ToolEvent }) {
  const { t } = useI18n()
  const api = window.tangu?.pluginSandbox
  const live = useLiveSandbox()
  const [busy, setBusy] = useState<'reset' | 'install' | 'start' | null>(null)
  const [note, setNote] = useState('')
  const saved = extractSandboxStatus(event.result)
  if (!saved) return null
  const mine = !!live?.running && live.pluginId === saved.pluginId && live.dir === saved.dir
  const st: SandboxStatus = (mine && live?.status) || saved
  const state = api && live && !mine ? 'stopped' : st.state
  const tag = { starting: t('sandbox.card.starting'), running: t('sandbox.card.running'), failed: t('sandbox.card.failed'), blocked: t('sandbox.card.blocked'), stopped: t('sandbox.card.stopped') }[state]
  const run = async (what: 'reset' | 'install' | 'start') => {
    if (!api || busy) return
    setBusy(what); setNote('')
    try {
      if (what === 'install') {
        const r = await api.install()
        if (r.ok) setNote(t('sandbox.card.installed'))
        else if (!r.cancelled && r.error) setNote(r.error)
      } else {
        // 不带主题键:主进程用上次带来的那份(工具调用每次都带)
        const r = what === 'reset' ? await api.reset() : await api.exec('start', { dir: saved.dir }, {})
        if (!r.ok && r.error) setNote(r.error)
      }
    } finally { setBusy(null) }
  }
  const facts: Array<{ kind: 'ok' | 'warn' | 'bad'; text: string }> = []
  if (st.blocked) facts.push({ kind: 'bad', text: st.blocked })
  if (st.setupError) facts.push({ kind: 'bad', text: st.setupError })
  for (const m of st.mountErrors.slice(0, 2)) facts.push({ kind: 'bad', text: `${m.view}: ${m.message}` })
  if (!st.blocked && !st.setupError && state !== 'starting') {
    facts.push(st.views.length ? { kind: 'ok', text: t('sandbox.card.views', { list: st.views.join(', ') }) } : { kind: 'warn', text: t('sandbox.card.noViews') })
  }
  for (const h of st.hiddenSpaces.slice(0, 2)) facts.push({ kind: 'warn', text: t('sandbox.card.hidden', { slug: h.slug }) })
  if (st.errorCount || st.warnCount) facts.push({ kind: st.errorCount ? 'bad' : 'warn', text: t('sandbox.card.console', { errors: st.errorCount, warns: st.warnCount }) })
  const Icon = { ok: CircleCheck, warn: TriangleAlert, bad: CircleAlert }
  return (
    <div className="t2-tasks" data-sandbox-card={event.id}>
      <div className="t2-taskcard sbx-card">
        <div className="t2-taskcard-head">
          <FlaskConical size={14} />
          <b>{t('sandbox.card.title', { name: st.name, version: st.version })}</b>
          <span className={`t2-taskcard-tag sbx-tag-${state === 'running' ? 'run' : state === 'starting' ? 'run' : state === 'stopped' ? 'off' : 'bad'}`}>{tag}</span>
          <span className="t2-taskcard-expire">{t('sandbox.card.isolated')}</span>
        </div>
        {!!facts.length && (
          <div className="sbx-facts">
            {facts.map((f, i) => { const I = Icon[f.kind]; return <div key={i} className={`sbx-fact ${f.kind}`}><I size={13} /><span>{f.text}</span></div> })}
          </div>
        )}
        <div className="t2-taskcard-tldr">{api ? t('sandbox.card.about') : t('sandbox.card.elsewhere')}</div>
        {!!note && <div className="t2-taskcard-note">{note}</div>}
        {api && (
          <div className="t2-taskcard-actions">
            {state === 'stopped'
              ? <button type="button" className="primary" disabled={!!busy} onClick={() => void run('start')}>{busy === 'start' ? <Loader2 size={13} className="spin" /> : <Play size={13} />}{t('sandbox.card.restart')}</button>
              : <>
                <button type="button" className="primary" onClick={() => void api.show()}><AppWindow size={13} />{t('sandbox.card.open')}</button>
                <button type="button" disabled={!!busy} onClick={() => void run('reset')}>{busy === 'reset' ? <Loader2 size={13} className="spin" /> : <RotateCcw size={13} />}{t('sandbox.card.reset')}</button>
                <button type="button" disabled={!!busy} onClick={() => void run('install')}>{busy === 'install' ? <Loader2 size={13} className="spin" /> : <Download size={13} />}{t('sandbox.card.install')}</button>
              </>}
          </div>
        )}
      </div>
    </div>
  )
}
