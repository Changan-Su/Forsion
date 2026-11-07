/**
 * 主页输入框下面那一行:跳过了首启引导、电脑历史又从没动过的人,再问一次要不要开(首启引导第四轮,细节页 §2)。
 * - 谁会看到:本机记号 'pending'(跳过带团队屏的引导时记,computerHistoryAskMark.ts)且电脑历史关着、从没动过。关过的人永远不出。
 * - 「开启…」弹设置页那份同意说明(ComputerHistoryDialog,同一份词条),同意才开;macOS 开成后接着请辅助功能(同引导团队屏)。
 * - ✕ = 不再提醒,记在本机。手机 / 网页 / 设备页没有电脑历史 API(computerHistoryApi() 为空),整行不出。
 */
import React, { useState } from 'react'
import { History, X } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import { agentName } from '../agentName'
import { ComputerHistoryDialog } from './ComputerHistoryDialog'
import { computerHistoryApi, useComputerHistory } from './useComputerHistory'
import { dismissChAsk, historyUntouched, useChAsk } from './computerHistoryAskMark'
import { hasDesktopPermissions } from './DesktopPermissions'
import './computerHistoryAsk.css'

registerMessages({
  'chAsk.title': { zh: '电脑历史还没开', en: 'Computer history is off' },
  'chAsk.body': { zh: '开了它，{muse}才看得到你在 Forsion 之外做的事。记录加密存在这台电脑上，只留 {days} 天。', en: 'With it on, {muse} can see what you do outside Forsion. Records are encrypted on this computer and kept for {days} days.' },
  'chAsk.enable': { zh: '开启…', en: 'Turn on…' },
  'chAsk.dismiss': { zh: '不再提醒', en: 'Don’t remind me' },
})

const MUSE = { name: 'Muse', nameZh: '卜算子', nameEn: 'Muse', slug: 'muse' }

export function ComputerHistoryAsk(): React.ReactNode {
  const mark = useChAsk()
  if (mark !== 'pending' || !computerHistoryApi()) return null
  return <AskRow />
}

function AskRow(): React.ReactNode {
  const { t, locale } = useI18n()
  const history = useComputerHistory()
  const [open, setOpen] = useState(false)
  const view = history.view
  const state = view?.state
  if (!view || !state || history.unsupported || state.enabled || !historyUntouched(state)) return null
  const close = (): void => { setOpen(false); history.setConfirmEnable(false); history.setActionError(null) }
  const enabled = (): void => {
    setOpen(false)
    dismissChAsk()
    if (state.platform === 'darwin' && hasDesktopPermissions()) {
      void window.tangu?.desktopPermissionRequest?.('computerAccessibility', { locale, mode: document.documentElement.classList.contains('dark') ? 'dark' : 'light' } as never).catch(() => {})
    }
  }
  return <div className="ch-ask" data-ch-ask="" role="group" aria-label={t('chAsk.title')}>
    <span className="ch-ask-ico"><History size={16} aria-hidden="true" /></span>
    <div><strong>{t('chAsk.title')}</strong><small>{t('chAsk.body', { muse: agentName(MUSE, locale), days: view.keepDays })}</small></div>
    <button type="button" className="btn primary sm" data-ch-ask-enable="" onClick={() => { history.setConfirmEnable(true); setOpen(true) }}>{t('chAsk.enable')}</button>
    <button type="button" className="ch-ask-x" data-ch-ask-dismiss="" aria-label={t('chAsk.dismiss')} title={t('chAsk.dismiss')} onClick={dismissChAsk}><X size={14} aria-hidden="true" /></button>
    <ComputerHistoryDialog history={history} consent open={open} onClose={close} onEnabled={enabled} />
  </div>
}
