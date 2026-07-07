/** 更新操作按钮(按 updater 阶段渲染)。About tab 与更新标签页共用,避免两处分叉。 */
import { Loader2, ExternalLink, Download, RefreshCw, Check } from 'lucide-react'
import { useI18n } from '../i18n'
import type { UpdaterStatusInfo } from '../types'

const RELEASES_URL = 'https://github.com/Changan-Su/Forsion/releases/latest'

export function UpdateActions({ upd }: { upd: UpdaterStatusInfo }) {
  const { t } = useI18n()
  const isMac = window.tangu?.platform === 'darwin'
  // 无 IPC(浏览器/旧 preload)→ 回退打开站点(保持原行为)。
  const check = (): void => {
    if (window.tangu?.checkForUpdates) void window.tangu.checkForUpdates()
    else window.open('https://forsion.net', '_blank')
  }
  switch (upd.phase) {
    case 'checking':
      return <button className="btn ghost sm" disabled><Loader2 size={12} className="spin" /> {t('about.update.checking')}</button>
    case 'available':
      return isMac
        ? <button className="btn primary sm" onClick={() => window.open(RELEASES_URL, '_blank')}><ExternalLink size={12} /> {t('about.update.goToDownload')}</button>
        : <button className="btn primary sm" onClick={() => window.tangu?.downloadUpdate?.()}><Download size={12} /> {t('about.update.download')}</button>
    case 'downloading':
      return <button className="btn ghost sm" disabled><Loader2 size={12} className="spin" /> {t('about.update.downloading', { percent: upd.percent ?? 0 })}</button>
    case 'downloaded':
      return <button className="btn primary sm" onClick={() => window.tangu?.installUpdate?.()}><RefreshCw size={12} /> {t('about.update.install')}</button>
    case 'not-available':
      return <button className="btn ghost sm" onClick={check}><Check size={12} /> {t('about.update.upToDate')}</button>
    case 'unsupported':
      return <span className="hint">{t('about.update.unsupported')}</span>
    default:
      return <button className="btn ghost sm" onClick={check}><RefreshCw size={12} /> {t('about.update.check')}</button>
  }
}
