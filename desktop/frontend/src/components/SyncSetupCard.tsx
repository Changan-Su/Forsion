/**
 * 首登同步卡片(2026-10-20 云同步开启方案 A + B 的卡片,docs/ToBeImproved/云同步开启方案_2026-10-20):
 * 登录了 Forsion、这个账号在这台电脑上还没对同步点过头(引导「连接」那步的勾就算点过),主窗弹一次:
 * 三行默认勾上,「开始同步」按勾的开,「稍后」什么都不开、以后不再弹(蓬洲云左栏「同步」挂点等着)。
 * 点了开始之后第一次同步时主窗底部一条进度,传完自己收走。只在桌面主窗、引导走完之后;手机 / 网页没有本地库远程同步。
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Bot, Cloud, NotebookPen, Puzzle, RefreshCw } from 'lucide-react'
import { setActiveSpace, useSpaceStore } from '@lcl/engine'
import { registerMessages, useI18n } from '../i18n'
import { windowKind } from '../windowKind'
import { ONBOARDING_DISMISS_KEY } from './OnboardingWizard'
import { applySyncChoices, getSync, markSyncDecided, startSyncSetup, subscribeSync, wantsSyncCard, type SyncKind, type SyncSnapshot } from '../services/syncSetup'
import { notifyApp } from '../stores/notificationStore'
import { watchAccountName } from '../services/accountName'
import './syncSetup.css'

registerMessages({
  'syncSetup.title': { zh: '把这台电脑同步到蓬洲云', en: 'Sync this computer to Penzor Cloud' },
  'syncSetup.lead': { zh: '已登录「{name}」。勾着的会和你的其他设备保持一致，以后随时可以在蓬洲云 › 同步里关。', en: 'Signed in as {name}. Checked items stay in sync with your other devices. You can turn them off anytime in Penzor Cloud › Sync.' },
  'syncSetup.notes': { zh: '智库「{name}」', en: 'Notes vault "{name}"' },
  'syncSetup.notesAny': { zh: '这台电脑的智库', en: 'Notes vault on this computer' },
  'syncSetup.notesSize': { zh: '{size} · 用掉设备同步 {max} 里的 {pct}%', en: '{size} · {pct}% of your {max} device sync storage' },
  'syncSetup.notesOver': { zh: '{size}，超过设备同步的 {max}：放不下的先留在这台电脑，不会删除', en: "{size}, more than your {max} device sync storage. What doesn't fit stays on this computer. Nothing is deleted." },
  'syncSetup.notesHint': { zh: '整个本机智库，和你的其他电脑保持一致', en: 'Your whole local vault, kept the same on your other computers' },
  'syncSetup.agents': { zh: 'Agents 与记忆', en: 'Agents & memory' },
  'syncSetup.agentsHint': { zh: 'Agents 的记忆、日志、技能和协作说明', en: "Your agents' memory, logs, skills and collaboration notes" },
  'syncSetup.plugins': { zh: '插件数据', en: 'Plugin data' },
  'syncSetup.pluginsHint': { zh: '插件自己存的设置和数据', en: 'Settings and data your plugins save' },
  'syncSetup.footHint': { zh: '另一台电脑登录同一账号，就会自动出现', en: 'Sign in on another computer and it appears there too' },
  'syncSetup.later': { zh: '稍后', en: 'Later' },
  'syncSetup.start': { zh: '开始同步', en: 'Start syncing' },
  'syncSetup.progress': { zh: '正在同步到蓬洲云 · 智库 {done} / {total} 个文件', en: 'Syncing to Penzor Cloud · notes {done} / {total} files' },
  'syncSetup.view': { zh: '查看', en: 'View' },
  'syncSetup.decide': { zh: '云端已经有一份智库，去蓬洲云 › 同步里选怎么合并。', en: 'Penzor Cloud already has a notes vault. Choose how to combine them in Penzor Cloud › Sync.' },
  'syncSetup.failed': { zh: '有一项没开成：{error}', en: "One item couldn't be turned on: {error}" },
})

const PENZOR_SPACE = 'forsion-penzor'
const GB = 1024 ** 3
export const fmtBytes = (n: number): string => n >= GB ? `${(n / GB).toFixed(n >= 10 * GB ? 0 : 1)} GB` : n >= 1024 ** 2 ? `${Math.round(n / 1024 ** 2)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`

const useSync = (): SyncSnapshot | null => useSyncExternalStore(subscribeSync, getSync)

function openPenzor(): void {
  if (useSpaceStore.getState().spaces.some((x) => x.id === PENZOR_SPACE)) setActiveSpace(PENZOR_SPACE)
}

export function SyncSetupHost(): JSX.Element | null {
  const { t } = useI18n()
  const [name, setName] = useState('')
  useEffect(() => watchAccountName(setName), [])
  const s = useSync()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [picked, setPicked] = useState<Record<SyncKind, boolean>>({ notes: true, agents: true, plugins: true })
  const [watching, setWatching] = useState(false)
  const main = windowKind() === 'main'

  useEffect(() => { if (main && window.remoteSync) startSyncSetup() }, [main])
  let obDone = false
  try { obDone = localStorage.getItem(ONBOARDING_DISMISS_KEY) === '1' } catch { /* 读不到当没走完:不弹 */ }
  // 依赖只放这两个布尔:快照每次同步进度 / 插件变动都换新对象,拿它当依赖计时器会一直被重置、永远弹不出来
  const want = main && !open && wantsSyncCard(s, obDone)
  const allOn = main && !!s && s.signedIn && !s.decided && obDone && s.notes.available && !want && !open
  useEffect(() => { if (allOn) markSyncDecided() }, [allOn])
  useEffect(() => {
    if (!want) return
    // 启动后先让主界面站稳,再弹(别和更新弹窗、引导收尾抢同一帧)
    const timer = setTimeout(() => setOpen(true), 2500)
    return () => clearTimeout(timer)
  }, [want])

  // 第一次同步的底部进度:跑完(或没在跑)就收
  const prog = s?.notes.progress
  useEffect(() => { if (watching && s && !s.notes.running && s.notes.last) { const tm = setTimeout(() => setWatching(false), 1500); return () => clearTimeout(tm) } }, [watching, s])

  if (!main || !s) return null
  const start = async (): Promise<void> => {
    setBusy(true)
    const results = await applySyncChoices(picked)
    setBusy(false); setOpen(false)
    const bad = results.find((r) => !r.ok)
    if (bad) notifyApp({ text: t('syncSetup.failed', { error: bad.error ?? '' }), level: 'warning' })
    const now = getSync()
    if (now?.notes.pending) { notifyApp({ text: t('syncSetup.decide'), level: 'info' }); openPenzor() }
    else if (picked.notes) setWatching(true)
  }
  const later = (): void => { markSyncDecided(); setOpen(false) }

  const notesSub = (() => {
    const { localBytes: size, maxBytes: max } = s.notes
    if (size == null || !max) return t('syncSetup.notesHint')
    if (size > max) return t('syncSetup.notesOver', { size: fmtBytes(size), max: fmtBytes(max) })
    return t('syncSetup.notesSize', { size: fmtBytes(size), max: fmtBytes(max), pct: String(Math.max(1, Math.round(size / max * 100))) })
  })()
  const rows: Array<[SyncKind, JSX.Element, string, string]> = [
    ['notes', <NotebookPen size={15} />, s.notes.rootName ? t('syncSetup.notes', { name: s.notes.rootName }) : t('syncSetup.notesAny'), notesSub],
    ['agents', <Bot size={15} />, t('syncSetup.agents'), t('syncSetup.agentsHint')],
    ['plugins', <Puzzle size={15} />, t('syncSetup.plugins'), t('syncSetup.pluginsHint')],
  ]

  return (
    <>
      {open && (
        <div className="u-backdrop sync-setup-backdrop">
          <div className="modal modal-sm sync-setup" role="dialog" aria-modal="true" aria-label={t('syncSetup.title')}>
            <div className="modal-head"><Cloud size={16} /><span className="sync-setup-title">{t('syncSetup.title')}</span></div>
            <div className="sync-setup-body">
              <p className="sync-setup-lead">{t('syncSetup.lead', { name })}</p>
              {rows.map(([k, icon, title, sub]) => (
                <label key={k} className="sync-setup-row">
                  <input type="checkbox" checked={picked[k]} disabled={busy} onChange={(e) => setPicked({ ...picked, [k]: e.target.checked })} />
                  <span className="sync-setup-tile">{icon}</span>
                  <span className="sync-setup-copy"><b>{title}</b><small>{sub}</small></span>
                </label>
              ))}
            </div>
            <div className="sync-setup-foot">
              <span className="sync-setup-hint">{t('syncSetup.footHint')}</span>
              <span className="sync-setup-acts">
                <button className="btn" disabled={busy} onClick={later}>{t('syncSetup.later')}</button>
                <button className="btn primary" disabled={busy} onClick={() => void start()}>{t('syncSetup.start')}</button>
              </span>
            </div>
          </div>
        </div>
      )}
      {watching && s.notes.running && prog && prog.total > 0 && (
        <div className="sync-setup-progress" role="status">
          <RefreshCw size={14} className="spin" />
          <span>{t('syncSetup.progress', { done: String(prog.done), total: String(prog.total) })}</span>
          <span className="sync-setup-bar"><i style={{ width: `${Math.round(prog.done / prog.total * 100)}%` }} /></span>
          <button type="button" className="sync-setup-link" onClick={openPenzor}>{t('syncSetup.view')}</button>
        </div>
      )}
    </>
  )
}
