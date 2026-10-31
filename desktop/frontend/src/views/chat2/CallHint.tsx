/**
 * 通话键的一次性气泡:默认开启后,用户第一次看到发送键变成通话键时说明它和扣费。
 * 只出现一次:点过任一按钮或打过一通就不再出现。
 */
import { useEffect, useState } from 'react'
import { useApp } from '../../stores/appStore'
import { registerMessages, useI18n } from '../../i18n'

registerMessages({
  'callhint.title': { zh: '可以直接和 Tangu 通话了', en: 'You can now talk to Tangu' },
  'callhint.body': { zh: '输入框空着时，点这里开始。通话用量从额度里扣。', en: 'Click here while the input is empty to start. Calls use your quota.' },
  'callhint.voice': { zh: '换个音色', en: 'Change voice' },
  'callhint.ok': { zh: '知道了', en: 'Got it' },
})

const SEEN_KEY = 'forsion_call_hint_seen'
const SHOW_DELAY_MS = 1200

const seen = (): boolean => { try { return !!localStorage.getItem(SEEN_KEY) } catch { return true } }
export const markCallHintSeen = (): void => { try { localStorage.setItem(SEEN_KEY, '1') } catch { /* 存不下就下次再提示 */ } }

export function CallHint({ ready }: { ready: boolean }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!ready) { setOpen(false); return }
    if (seen()) return
    const timer = setTimeout(() => { if (!seen()) setOpen(true) }, SHOW_DELAY_MS)
    return () => clearTimeout(timer)
  }, [ready])
  if (!open) return null
  const close = () => { markCallHintSeen(); setOpen(false) }
  return (
    <div className="t2c-callhint" role="status">
      <b>{t('callhint.title')}</b>
      <span>{t('callhint.body')}</span>
      <div className="t2c-callhint-actions">
        <button type="button" className="btn ghost sm" onClick={() => { close(); useApp.getState().openSettings('model/m-voice') }}>{t('callhint.voice')}</button>
        <button type="button" className="btn primary sm" onClick={close}>{t('callhint.ok')}</button>
      </div>
    </div>
  )
}
