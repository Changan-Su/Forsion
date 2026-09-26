/**
 * 「更新」标签页:顶部按 updater 状态显示「发现新版本 + 下载/安装/去下载」,下方渲染完整更新日志。
 * 检测到新版时由 bootstrap 自动弹出(每版本一次);开发者模式按钮可强制弹出测试。
 */
import { useEffect, useState } from 'react'
import { CHANGELOG, changelogFor } from '../changelog'
import { Markdown } from '../components/Markdown'
import { UpdateActions } from '../components/UpdateActions'
import { useI18n } from '../i18n'
import { useWorkspace } from '@lcl/engine'
import type { UpdaterStatusInfo } from '../types'

/** 打开「更新」标签页(新 tab;singleton 已开则聚焦)。bootstrap 自动弹出与开发者按钮共用。 */
export function openChangelogTab(): void {
  useWorkspace.getState().openView('changelog', {}, 'main', { newTab: true })
}

/** 更新日志各节(关于页 / 引导页 / 更新标签页共用):按界面语言取,英文缺的那一节注明只有中文。 */
export function ChangelogEntries() {
  const { t, locale } = useI18n()
  return (
    <>
      {changelogFor(locale).map((c) => (
        <div key={c.version} className="changelog-entry md-body" lang={c.fallback ? 'zh' : undefined}>
          <div className="changelog-ver">{c.version} <span className="changelog-date">{c.date}</span></div>
          {c.fallback && <div className="hint">{t('changelog.zhOnly')}</div>}
          <Markdown content={c.lines.map((l) => `- ${l}`).join('\n')} />
        </div>
      ))}
    </>
  )
}

/** 新版本那一节的说明:英文界面优先用 CHANGELOG.en.md 那一节(主进程一并拉回来)。 */
export const releaseNotesFor = (upd: UpdaterStatusInfo, locale: string): string | undefined => (locale === 'en' && upd.releaseNotesEn) || upd.releaseNotes

export function ChangelogView() {
  const { t, locale } = useI18n()
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
          <div style={{ fontWeight: 700, fontSize: 'var(--ui-font-heading, 14px)' }}>{t('changelog.newVersion', { version: upd.version || '' })}</div>
          <span style={{ flex: 1 }} />
          <UpdateActions upd={upd} />
        </div>
      )}
      <div className="changelog">
        {/* 新版本那一节:CHANGELOG 是**跟着安装包打包进来的**,装的是 2.7.3 就永远只到 2.7.3 ——
            用户实报「更新 view 没有 2.7.4 的内容」。新版的说明由主进程去仓库 tag 上拉
            desktop/CHANGELOG.md 抠出来(见 electron/updater.ts),这里补在最上面。 */}
        {hasUpdate && releaseNotesFor(upd, locale) && !CHANGELOG.some((c) => c.version === upd.version) && (
          <div className="changelog-entry md-body">
            <div className="changelog-ver">{upd.version} <span className="changelog-date">{t('changelog.newest')}</span></div>
            <Markdown content={releaseNotesFor(upd, locale)!} />
          </div>
        )}
        <ChangelogEntries />
      </div>
    </div>
  )
}
