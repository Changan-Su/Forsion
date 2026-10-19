/** 更新操作按钮(按 updater 阶段渲染)。About tab 与更新标签页共用,避免两处分叉。 */
import { Loader2, Download, RefreshCw, Check } from 'lucide-react'
import { useCorePluginUpdates } from './CorePluginUpdates'
import { useI18n } from '../i18n'
import type { UpdaterStatusInfo } from '../types'
import './whatsNew.css'

const RELEASES_URL = 'https://github.com/Changan-Su/Forsion/releases/latest'

export function UpdateActions({ upd }: { upd: UpdaterStatusInfo }) {
  const { t } = useI18n()
  const core = useCorePluginUpdates()
  const isMac = window.tangu?.platform === 'darwin'
  // 无 IPC(浏览器/旧 preload)→ 回退打开站点(保持原行为)。
  const check = (): void => {
    if (window.tangu?.checkForUpdates) void window.tangu.checkForUpdates()
    else window.open('https://forsion.net', '_blank')
  }
  // mac 没签名不能自装:在浏览器里直接开这一版 .dmg(主进程按下载来源挑官网 / GitHub);老主进程退回 Releases 页。
  const openInstaller = (): void => {
    if (window.tangu?.openUpdateInstaller) void window.tangu.openUpdateInstaller()
    else window.open(RELEASES_URL, '_blank')
  }
  if (core.checking && ['idle', 'not-available', 'error'].includes(upd.phase)) return <button className="btn ghost sm" disabled><Loader2 size={12} className="spin" /> {t('about.update.checking')}</button>
  switch (upd.phase) {
    case 'checking':
      return <button className="btn ghost sm" disabled><Loader2 size={12} className="spin" /> {t('about.update.checking')}</button>
    case 'available':
      return isMac
        ? <button className="btn primary sm" onClick={openInstaller}><Download size={12} /> {t('about.update.downloadInstaller')}</button>
        : <button className="btn primary sm" onClick={() => window.tangu?.downloadUpdate?.()}><Download size={12} /> {t('about.update.download')}</button>
    case 'downloading':
      return <button className="btn ghost sm" disabled><Loader2 size={12} className="spin" /> {t('about.update.downloading', { percent: upd.percent ?? 0 })}</button>
    case 'downloaded':
      return <button className="btn primary sm" onClick={() => window.tangu?.installUpdate?.()}><RefreshCw size={12} /> {t('about.update.install')}</button>
    case 'not-available':
      return <button className="btn ghost sm" onClick={check}><Check size={12} /> {t(core.items.some((item) => item.phase !== 'current') ? 'about.update.check' : 'about.update.upToDate')}</button>
    case 'unsupported':
      return <span className="hint">{t('about.update.unsupported')}</span>
    default:
      return <button className="btn ghost sm" onClick={check}><RefreshCw size={12} /> {t('about.update.check')}</button>
  }
}

const mb = (bytes: number): string => `${Math.round(bytes / 1048576)} MB`

/** 按钮旁的一行小字:这次从哪儿下、多大 / 下到哪了(带「换 GitHub / 换官网」)/ 自动换过源 / 从哪边下完 / mac 下一步怎么装。 */
export function UpdateSourceNote({ upd }: { upd: UpdaterStatusInfo }) {
  const { t } = useI18n()
  if (upd.opened && upd.phase === 'available') return <span className="upd-src">{t('about.update.macOpened')}</span>
  if (!upd.source) return null
  const host = upd.source === 'website' ? 'forsion.net' : 'GitHub'
  if (upd.phase === 'available') {
    return <span className="upd-src">{upd.size ? t('about.update.fromSize', { host, size: mb(upd.size) }) : t('about.update.from', { host })}</span>
  }
  if (upd.phase === 'downloaded') return <span className="upd-src">{t('about.update.downloadedFrom', { host })}</span>
  if (upd.phase !== 'downloading') return null
  const progress = upd.total ? `${mb(upd.transferred ?? 0)} / ${mb(upd.total)}` : ''
  const text = upd.fallbackFrom
    ? [t(upd.source === 'github' ? 'about.update.fellBackToGithub' : 'about.update.fellBackToWebsite'), progress].filter(Boolean).join(' · ')
    : progress ? t('about.update.fromProgress', { host, done: mb(upd.transferred ?? 0), total: mb(upd.total!) }) : t('about.update.from', { host })
  return (
    <span className="upd-src">
      {text}
      {upd.canSwitch && window.tangu?.switchUpdateSource && (
        <button type="button" className="upd-src-switch" onClick={() => void window.tangu?.switchUpdateSource?.()}>
          {t(upd.source === 'website' ? 'about.update.useGithub' : 'about.update.useWebsite')}
        </button>
      )}
    </span>
  )
}
