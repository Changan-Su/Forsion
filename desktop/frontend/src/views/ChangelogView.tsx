/**
 * 「更新」标签页:顶部按 updater 状态显示「发现新版本 + 下载/安装/去下载」,下方渲染完整更新日志。
 * 检测到新版时由 bootstrap 自动弹出(每版本一次);开发者模式按钮可强制弹出测试。
 */
import { useEffect, useState } from 'react'
import { CHANGELOG } from '../changelog'
import { Markdown } from '../components/Markdown'
import { UpdateActions } from '../components/UpdateActions'
import { useI18n } from '../i18n'
import { useWorkspace } from '@lcl/engine'
import type { UpdaterStatusInfo } from '../types'

/** 打开「更新」标签页(新 tab;singleton 已开则聚焦)。bootstrap 自动弹出与开发者按钮共用。 */
export function openChangelogTab(): void {
  useWorkspace.getState().openView('changelog', {}, 'main', { newTab: true })
}

export function ChangelogView() {
  const { t } = useI18n()
  const [upd, setUpd] = useState<UpdaterStatusInfo>({ phase: 'idle' })
  useEffect(() => {
    const off = window.tangu?.onUpdaterStatus?.((st) => setUpd(st))
    void window.tangu?.checkForUpdates?.() // 打开即刷新:状态是一次性广播,重查以填充顶部「新版本」区
    return () => off?.()
  }, [])
  const hasUpdate = upd.phase === 'available' || upd.phase === 'downloaded'
  return (
    <div className="changelog-view md-body" style={{ height: '100%', overflow: 'auto', padding: 24 }}>
      {hasUpdate && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, paddingBottom: 16, borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontWeight: 700, fontSize: 17 }}>{t('changelog.newVersion', { version: upd.version || '' })}</div>
          <span style={{ flex: 1 }} />
          <UpdateActions upd={upd} />
        </div>
      )}
      <div className="changelog">
        {CHANGELOG.map((c) => (
          <div key={c.version} className="changelog-entry md-body">
            <div className="changelog-ver">{c.version} <span className="changelog-date">{c.date}</span></div>
            <Markdown content={c.lines.map((l) => `- ${l}`).join('\n')} />
          </div>
        ))}
      </div>
    </div>
  )
}
