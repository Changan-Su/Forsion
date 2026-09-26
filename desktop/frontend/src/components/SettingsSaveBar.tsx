/**
 * 设置页吸底保存栏:「有未保存的更改 · 放弃 · 保存并重启」。
 * 复用 SpecialAgentsTab 的 `.special-save`(吸底 + 顶线 + 卡面底色),不另起一套样式;
 * 放在它所管的那张面板**里面**,sticky 只在该面板可见时吸住,不会压到别的面板上。
 */
import { Check, Loader2 } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import './specialAgents.css'

registerMessages({
  'settingsmodal.saveBar.dirty': { zh: '有未保存的更改', en: 'You have unsaved changes' },
  'settingsmodal.saveBar.discard': { zh: '放弃', en: 'Discard' },
})

export function SettingsSaveBar(props: {
  /** 主按钮文案(如「保存并重启后端」「切换到托管并启动」)。 */
  saveLabel: string
  onSave: () => void
  onDiscard: () => void
  busy?: boolean
  /** 左侧状态句;缺省「有未保存的更改」。 */
  message?: string
  error?: string
}) {
  const { t } = useI18n()
  return (
    <footer className="special-save settings-save-bar">
      <div role="status">
        {props.error
          ? <p className="special-error" role="alert">{props.error}</p>
          : <span>{props.message || t('settingsmodal.saveBar.dirty')}</span>}
      </div>
      <button type="button" className="btn" disabled={props.busy} onClick={props.onDiscard}>{t('settingsmodal.saveBar.discard')}</button>
      <button type="button" className="btn primary" disabled={props.busy} onClick={props.onSave}>
        {props.busy ? <Loader2 size={14} className="spin" /> : <Check size={14} />}{props.saveLabel}
      </button>
    </footer>
  )
}
