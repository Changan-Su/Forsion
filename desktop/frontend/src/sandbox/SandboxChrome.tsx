/**
 * 沙箱窗口的标识与操作(只在沙箱那份 Forsion 的主窗里挂):右上角浮钮组最前面一格(引擎的 setEdgeAccessory)——
 * 「沙箱 · 插件名」胶囊 + 重置 / 报告问题(只留图标)+ 安装。放进浮钮组的流内,标签头按整宽让位,不再浮在标签上叠字(11-20)。
 * 首次打开时右下角垂一张说明卡,不压插件自己的工具栏。按钮只把意图转给父进程(window.tangu.sandbox.action),决定与确认框都在父进程那边。
 */
import { useEffect, useState } from 'react'
import { Download, Flag, FlaskConical, RotateCcw, X } from 'lucide-react'
import { OverlayAt, setEdgeAccessory } from '@lcl/engine'
import { registerMessages, useI18n } from '../i18n'
import { sandboxSelf } from './sandboxWindow'
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
  const act = (a: 'report' | 'install' | 'reset', n?: string) => void window.tangu?.sandbox?.action(a, n)
  // 标识与按钮进右上角浮钮组(引擎替它在标签头上让位);弹出的「报告问题」框和说明卡留在这里,画在整窗之上。
  useEffect(() => {
    if (!self) return
    const full = `${self.name} ${self.version}`
    setEdgeAccessory(
      <div className="sbx-chrome-row" data-testid="sandbox-chrome">
        <span className="sbx-pill" title={`${full}\n${t('sandbox.note')}`}><FlaskConical size={13} />{t('sandbox.pill')}<span>· {self.name}</span></span>
        <button type="button" className="sbx-ibtn" title={t('sandbox.resetTip')} aria-label={t('sandbox.reset')} onClick={() => act('reset')}><RotateCcw size={14} /></button>
        <button type="button" className={`sbx-ibtn${reporting ? ' is-on' : ''}`} title={t('sandbox.reportTip')} aria-label={t('sandbox.report')} aria-expanded={reporting}
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setAt({ x: r.right, y: r.bottom + 6 }); setReporting((v) => !v) }}><Flag size={14} /></button>
        <button type="button" className="sbx-cbtn primary" title={t('sandbox.install')} onClick={() => act('install')}><Download size={12} />{t('sandbox.installShort')}</button>
      </div>,
    )
  }, [self, t, reporting])
  useEffect(() => () => setEdgeAccessory(null), [])
  if (!self) return null
  const closeNote = () => { setNote(false); try { localStorage.setItem(NOTE_KEY, '1') } catch { /* 下次再提示 */ } }
  const send = () => { act('report', text.trim()); setText(''); setReporting(false) }
  return (
    <>
      {reporting && (
        <OverlayAt x={at.x} y={at.y} alignEnd className="sbx-pop ui-popover">
          <textarea autoFocus value={text} placeholder={t('sandbox.reportPlaceholder')} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); if (e.key === 'Escape') setReporting(false) }} />
          <div className="sbx-pop-actions"><button type="button" className="sbx-cbtn primary" onClick={send}>{t('sandbox.reportSend')}</button></div>
        </OverlayAt>
      )}
      {note && !reporting && (
        <div className="sbx-note" role="status" data-testid="sandbox-note">
          <FlaskConical size={14} /><span>{t('sandbox.note')}</span>
          <button type="button" className="sbx-note-x" aria-label={t('sandbox.noteOk')} title={t('sandbox.noteOk')} onClick={closeNote}><X size={13} /></button>
        </div>
      )}
    </>
  )
}
