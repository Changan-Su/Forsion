/**
 * 沙箱窗口的标识与操作(只在沙箱那份 Forsion 的主窗里挂):标题栏右侧一颗「沙箱 · 插件名 版本」胶囊 + 重置 / 报告问题 / 安装到我的 Forsion,
 * 首次打开时下面垂一条说明。按钮只把意图转给父进程(window.tangu.sandbox.action),决定与确认框都在父进程那边。
 */
import { useState } from 'react'
import { Download, Flag, FlaskConical, RotateCcw, X } from 'lucide-react'
import { OverlayAt } from '@lcl/engine'
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
  if (!self) return null
  const act = (a: 'report' | 'install' | 'reset', n?: string) => void window.tangu?.sandbox?.action(a, n)
  const closeNote = () => { setNote(false); try { localStorage.setItem(NOTE_KEY, '1') } catch { /* 下次再提示 */ } }
  const send = () => { act('report', text.trim()); setText(''); setReporting(false) }
  return (
    <div className="sbx-chrome" data-testid="sandbox-chrome">
      <div className="sbx-chrome-row">
        <span className="sbx-pill"><FlaskConical size={13} />{t('sandbox.pill')}<span>· {self.name} {self.version}</span></span>
        <button type="button" className="sbx-cbtn" title={t('sandbox.resetTip')} onClick={() => act('reset')}><RotateCcw size={12} />{t('sandbox.reset')}</button>
        <button type="button" className="sbx-cbtn" title={t('sandbox.reportTip')} aria-expanded={reporting} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setAt({ x: r.right - 320, y: r.bottom + 6 }); setReporting((v) => !v) }}><Flag size={12} />{t('sandbox.report')}</button>
        <button type="button" className="sbx-cbtn primary" onClick={() => act('install')}><Download size={12} />{t('sandbox.install')}</button>
      </div>
      {reporting && (
        <OverlayAt x={at.x} y={at.y} className="sbx-pop ui-popover">
          <textarea autoFocus value={text} placeholder={t('sandbox.reportPlaceholder')} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); if (e.key === 'Escape') setReporting(false) }} />
          <div className="sbx-pop-actions"><button type="button" className="sbx-cbtn primary" onClick={send}>{t('sandbox.reportSend')}</button></div>
        </OverlayAt>
      )}
      {note && !reporting && (
        <div className="sbx-note">
          <FlaskConical size={14} /><span>{t('sandbox.note')}</span>
          <button type="button" className="sbx-note-x" aria-label={t('sandbox.noteOk')} title={t('sandbox.noteOk')} onClick={closeNote}><X size={13} /></button>
        </div>
      )}
    </div>
  )
}
