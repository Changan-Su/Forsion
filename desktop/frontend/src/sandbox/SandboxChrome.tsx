/**
 * 沙箱窗口的标识与操作(只在沙箱那份 Forsion 的主窗里挂):右上角浮钮组最前面一格(引擎的 setEdgeAccessory)——
 * 「沙箱 · 插件名」胶囊 + 重置 / 报告问题(只留图标)+ 安装。放进浮钮组的流内,标签头按整宽让位,不再浮在标签上叠字(11-20)。
 * 安装(11-28 方案 A):确认框由父进程交给本进程挂在这扇窗上弹;装没装由父进程比对后推过来 —— 按钮在「安装 / 更新 / 已安装」间换,
 * 从这里点的那次装完在按钮下垂回执卡(在我的 Forsion 打开 / 关闭沙箱),装不上垂说明。
 * 首次打开时右下角垂一张说明卡;agent 点的目标被它压着时自动收起(sandboxWindow 的 clearNote,同通知),人点「知道了」也收。按钮只把意图转给父进程(window.tangu.sandbox.action),决定与确认框都在父进程那边。
 */
import { useEffect, useRef, useState } from 'react'
import { Check, CircleAlert, CircleCheck, Download, Flag, FlaskConical, RefreshCw, RotateCcw, Settings, SquareArrowOutUpRight, X } from 'lucide-react'
import type { SandboxInstalled } from '../../../../tangu-agent/src/contracts/pluginSandbox'
import type { PluginSandboxInstallResult } from '../types'
import { installButton, installErrorText } from '../views/chat2/sandboxInstall'
import { OverlayAt, UI_MODE, setEdgeAccessory } from '@lcl/engine'
import { registerMessages, useI18n } from '../i18n'
import { SANDBOX_NOTE_COLLAPSE, sandboxSelf } from './sandboxWindow'
import './sandbox.css'

registerMessages({
  'sandbox.pill': { zh: '沙箱', en: 'Sandbox' },
  'sandbox.reset': { zh: '重置', en: 'Reset' },
  'sandbox.resetTip': { zh: '清空沙箱里的数据，重新加载插件', en: 'Wipe the sandbox data and load the plugin again' },
  'sandbox.report': { zh: '报告问题', en: 'Report a problem' },
  'sandbox.reportTip': { zh: '把问题发回发起这个沙箱的对话', en: 'Send the problem back to the chat that started this sandbox' },
  'sandbox.reportPlaceholder': { zh: '哪里不对？比如：点「记一笔」没反应', en: 'What went wrong? For example: nothing happens when I click Save' },
  'sandbox.reportSend': { zh: '发回对话', en: 'Send to chat' },
  'sandbox.install': { zh: '安装到我的 Forsion', en: 'Install in my Forsion' },
  'sandbox.installShort': { zh: '安装', en: 'Install' },
  'sandbox.note': {
    zh: '这是沙箱。数据独立、未登录，你在这里做的任何事都不会碰到你自己的 Forsion。关掉窗口就停。',
    en: 'This is a sandbox. It has its own data and is signed out, so nothing you do here touches your own Forsion. Closing the window stops it.',
  },
  'sandbox.noteOk': { zh: '知道了', en: 'Got it' },
})

const NOTE_KEY = 'forsion_sandbox_note_seen'

export function SandboxChrome() {
  const { t } = useI18n()
  const self = sandboxSelf()
  const [note, setNote] = useState(() => { try { return !localStorage.getItem(NOTE_KEY) } catch { return true } })
  const [reporting, setReporting] = useState(false)
  const [at, setAt] = useState({ x: 0, y: 0 })
  const [text, setText] = useState('')
  const act = (a: 'report' | 'install' | 'reset' | 'openHost' | 'close', n?: string) => void window.tangu?.sandbox?.action(a, n)
  // 用户那份 Forsion 里装没装这一份(父进程推);回执卡:done = 刚装好 / 点了「已安装」,fail = 没装上
  const [inst, setInst] = useState<SandboxInstalled | null>(null)
  const [pop, setPop] = useState<null | { kind: 'done'; again: boolean } | { kind: 'fail'; text: string; store: boolean }>(null)
  const [popAt, setPopAt] = useState({ x: 0, y: 0 })
  const installRef = useRef<HTMLButtonElement | null>(null)
  const popRef = useRef<HTMLDivElement | null>(null)
  const anchorPop = (): void => { const r = installRef.current?.getBoundingClientRect(); if (r) setPopAt({ x: r.right, y: r.bottom + 6 }) }
  useEffect(() => {
    const sbx = window.tangu?.sandbox
    if (!sbx?.installed) return
    let alive = true
    void sbx.installed().then((v) => { if (alive) setInst(v ?? null) }, () => {})
    const off1 = sbx.onInstalled?.((v) => setInst(v ?? null))
    const off2 = sbx.onInstallResult?.((r: PluginSandboxInstallResult & { origin: 'sandbox' | 'host' }) => {
      if (r.installed !== undefined) setInst(r.installed ?? null)
      // 只有从这扇窗点的那次垂卡;卡片 / Coding Studio 点的,按钮跟着变就够了
      if (r.origin !== 'sandbox' || r.cancelled) return
      anchorPop()
      if (r.ok || r.code === 'same') setPop({ kind: 'done', again: r.code === 'same' })
      else setPop({ kind: 'fail', text: installErrorText(r, t), store: r.code === 'store' })
    })
    return () => { alive = false; off1?.(); off2?.() }
  }, [t])
  // 回执卡:点外面 / Esc 收起
  useEffect(() => {
    if (!pop) return
    const down = (e: PointerEvent): void => {
      const n = e.target as Node
      if (popRef.current?.contains(n) || installRef.current?.contains(n)) return
      setPop(null)
    }
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') setPop(null) }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key)
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key) }
  }, [pop])
  const btn = installButton(inst)
  const onInstall = (): void => {
    if (btn === 'done') { anchorPop(); setPop((p) => (p ? null : { kind: 'done', again: true })); return }
    // 另装着一份:不用问父进程也知道装不了,直接说怎么办
    if (btn === 'blocked') { anchorPop(); setPop({ kind: 'fail', text: t('sandbox.inst.err.store'), store: true }); return }
    setPop(null)
    act('install')
  }
  // 标识与按钮进右上角浮钮组(引擎替它在标签头上让位);弹出的「报告问题」框和说明卡留在这里,画在整窗之上。
  // 手机界面预览(UI_MODE 'mobile',整窗重载才切)走单列壳、没有浮钮组 → 照旧自己浮在右上角。
  // data-sbx-host:这几块是给人的,agent 的 read / 找目标都跳过它们(sandboxWindow.ts 的 HOST_ONLY),免得点到宿主的「重置」清掉数据。
  const docked = UI_MODE !== 'mobile'
  const row = !self ? null : (
    <div className="sbx-chrome-row" data-sbx-host="" data-testid="sandbox-chrome">
      <span className="sbx-pill" title={`${self.name} ${self.version}\n${t('sandbox.note')}`}><FlaskConical size={13} />{t('sandbox.pill')}<span>· {self.name}</span></span>
      <button type="button" className="sbx-ibtn" title={t('sandbox.resetTip')} aria-label={t('sandbox.reset')} onClick={() => act('reset')}><RotateCcw size={14} /></button>
      <button type="button" className={`sbx-ibtn${reporting ? ' is-on' : ''}`} title={t('sandbox.reportTip')} aria-label={t('sandbox.report')} aria-expanded={reporting}
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setAt({ x: r.right, y: r.bottom + 6 }); setReporting((v) => !v) }}><Flag size={14} /></button>
      {btn === 'done'
        ? <button ref={installRef} type="button" className={`sbx-cbtn${pop ? ' is-on' : ''}`} title={t('sandbox.inst.installedTip')} aria-expanded={!!pop} onClick={onInstall}><Check size={12} />{t('sandbox.inst.installedShort')}</button>
        : <button ref={installRef} type="button" className="sbx-cbtn primary" title={t(btn === 'update' ? 'sandbox.inst.update' : 'sandbox.install')} onClick={onInstall}>
          {btn === 'update' ? <RefreshCw size={12} /> : <Download size={12} />}{t(btn === 'update' ? 'sandbox.inst.updateShort' : 'sandbox.installShort')}
        </button>}
    </div>
  )
  useEffect(() => { if (docked) setEdgeAccessory(row) }, [self, t, reporting, btn, !!pop]) // eslint-disable-line react-hooks/exhaustive-deps -- row 由这几样决定
  useEffect(() => () => setEdgeAccessory(null), [])
  const closeNote = () => { setNote(false); try { localStorage.setItem(NOTE_KEY, '1') } catch { /* 下次再提示 */ } }
  // agent 在沙箱里点的东西正好压在说明条底下 → sandboxWindow 先让它收起再点(同通知;11-23)
  useEffect(() => {
    if (!note) return
    window.addEventListener(SANDBOX_NOTE_COLLAPSE, closeNote)
    return () => window.removeEventListener(SANDBOX_NOTE_COLLAPSE, closeNote)
  }, [note])
  if (!self) return null
  const send = () => { act('report', text.trim()); setText(''); setReporting(false) }
  return (
    <>
      {!docked && <div className="sbx-float">{row}</div>}
      {reporting && (
        <OverlayAt x={at.x} y={at.y} alignEnd className="sbx-pop ui-popover" data-sbx-host="">
          <textarea autoFocus value={text} placeholder={t('sandbox.reportPlaceholder')} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); if (e.key === 'Escape') setReporting(false) }} />
          <div className="sbx-pop-actions"><button type="button" className="sbx-cbtn primary" onClick={send}>{t('sandbox.reportSend')}</button></div>
        </OverlayAt>
      )}
      {pop && (
        <OverlayAt x={popAt.x} y={popAt.y} alignEnd className="sbx-pop sbx-rcpt ui-popover" data-sbx-host="" data-testid="sandbox-install-receipt" innerRef={(el: HTMLDivElement | null) => { popRef.current = el }}>
          {pop.kind === 'done' ? <>
            <div className="sbx-rcpt-head"><CircleCheck size={15} className="ok" />{t('sandbox.rcpt.doneTitle')}</div>
            <div className="sbx-rcpt-body">{t('sandbox.rcpt.doneBody', { name: self.name, version: inst?.version || self.version })}</div>
            <div className="sbx-pop-actions">
              {pop.again && <button type="button" className="sbx-linkbtn" onClick={() => { setPop(null); act('install', 'force') }}>{t('sandbox.rcpt.reinstall')}</button>}
              <button type="button" className="sbx-cbtn" onClick={() => { setPop(null); act('close') }}>{t('sandbox.inst.close')}</button>
              <button type="button" className="sbx-cbtn primary" onClick={() => { setPop(null); act('openHost') }}><SquareArrowOutUpRight size={12} />{t('sandbox.inst.open')}</button>
            </div>
          </> : <>
            <div className="sbx-rcpt-head"><CircleAlert size={15} className="bad" />{t('sandbox.rcpt.failTitle')}</div>
            <div className="sbx-rcpt-body">{pop.text}</div>
            <div className="sbx-pop-actions">
              <button type="button" className="sbx-cbtn" onClick={() => setPop(null)}>{t('sandbox.rcpt.ok')}</button>
              {pop.store && <button type="button" className="sbx-cbtn primary" onClick={() => { setPop(null); act('openHost', 'settings') }}><Settings size={12} />{t('sandbox.inst.openSettings')}</button>}
            </div>
          </>}
        </OverlayAt>
      )}
      {note && !reporting && (
        <div className="sbx-note" role="status" data-sbx-host="" data-testid="sandbox-note">
          <FlaskConical size={14} /><span>{t('sandbox.note')}</span>
          <button type="button" className="sbx-note-x" aria-label={t('sandbox.noteOk')} title={t('sandbox.noteOk')} onClick={closeNote}><X size={13} /></button>
        </div>
      )}
    </>
  )
}
