/**
 * 首登同步卡片(2026-10-20 云同步开启方案 A + B 的卡片,docs/ToBeImproved/云同步开启方案_2026-10-20):
 * 登录了 Forsion、这个账号在这台电脑上还没对同步点过头(引导「连接」那步的勾就算点过),主窗弹一次:
 * 三行默认勾上,「开始同步」按勾的开,「稍后」什么都不开、以后不再弹(蓬洲云左栏「同步」挂点等着)。
 * 点了开始之后第一次同步时主窗底部一条进度,传完自己收走。只在桌面主窗、引导走完之后;手机 / 网页没有本地库远程同步。
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Bot, NotebookPen, Puzzle, RefreshCw, UserRound } from 'lucide-react'
import { PenzorIcon } from '../amadeus/components/icons'
import { setActiveSpace, useSpaceStore } from '@lcl/engine'
import { registerMessages, useI18n } from '../i18n'
import { windowKind } from '../windowKind'
import { ONBOARDING_DISMISS_KEY } from './OnboardingWizard'
import { applySyncChoices, getSync, markSyncDecided, openPenzorSync, setSync, startSyncSetup, subscribeSync, wantsSyncCard, type SyncKind, type SyncSnapshot } from '../services/syncSetup'
import { notifyApp } from '../stores/notificationStore'
import { POPUP_PRIORITY, usePopupTurn } from '../stores/popupQueue'
import { watchAccountName } from '../services/accountName'
import './syncSetup.css'

registerMessages({
  'syncSetup.storageEnforced': { zh: '我的云盘 {used} / {max} · 统一额度已启用，超额时暂停增长写入', en: 'My drive {used} / {max} · unified quota active; growing writes pause over quota' },
  'syncSetup.storage': { zh: '我的云盘 {used} / {max} · 提醒阶段，不新增同步拦截', en: 'My drive {used} / {max} · notice phase, no new sync restrictions' },
  'syncSetup.storageUnknown': { zh: '我的云盘统一用量暂不可用，请在蓬洲云查看容量状态', en: 'Unified drive usage is unavailable. Check storage status in Penzor Cloud' },
  'syncSetup.title': { zh: '把这台电脑同步到蓬洲云', en: 'Sync this computer to Penzor Cloud' },
  'syncSetup.lead': { zh: '已登录「{name}」。勾着的会和你的其他设备保持一致，以后随时可以在蓬洲云 › 同步里关。', en: 'Signed in as {name}. Checked items stay in sync with your other devices. You can turn them off anytime in Penzor Cloud › Sync.' },
  'syncSetup.notes': { zh: '智库「{name}」', en: 'Notes vault "{name}"' },
  'syncSetup.notesAny': { zh: '这台电脑的智库', en: 'Notes vault on this computer' },
  'syncSetup.notesSize': { zh: '{size} · 占原设备同步限制 {max} 的 {pct}%', en: '{size} · {pct}% of the existing {max} device sync limit' },
  'syncSetup.notesOver': { zh: '{size}，超过设备同步的 {max}：放不下的先留在这台电脑，不会删除', en: "{size}, more than your {max} device sync storage. What doesn't fit stays on this computer. Nothing is deleted." },
  'syncSetup.notesHint': { zh: '整个本机智库，和你的其他电脑保持一致', en: 'Your whole local vault, kept the same on your other computers' },
  'syncSetup.agents': { zh: 'Agents 与记忆', en: 'Agents & memory' },
  'syncSetup.agentsHint': { zh: 'Agents 的记忆、日志、技能和协作说明', en: "Your agents' memory, logs, skills and collaboration notes" },
  'syncSetup.plugins': { zh: '插件数据', en: 'Plugin data' },
  'syncSetup.pluginsHint': { zh: '插件自己存的设置和数据', en: 'Settings and data your plugins save' },
  'syncSetup.footHint': { zh: '另一台电脑登录同一账号，就会自动出现', en: 'Sign in on another computer and it appears there too' },
  'syncSetup.later': { zh: '稍后', en: 'Later' },
  'syncSetup.chooseScope': {zh:'选择同步范围',en:'Choose sync scope'},
  'syncSetup.scopeLead': {zh:'先在蓬洲云选择目录与云端位置，再预览和确认。',en:'Choose folders and cloud destinations in Penzor Cloud, then preview and confirm.'},
  'syncSetup.start': { zh: '开始同步', en: 'Start syncing' },
  'syncSetup.progress': { zh: '正在同步到蓬洲云 · 智库 {done} / {total} 个文件', en: 'Syncing to Penzor Cloud · notes {done} / {total} files' },
  'syncSetup.view': { zh: '查看', en: 'View' },
  'syncSetup.decide': { zh: '云端已经有一份智库，去蓬洲云 › 同步里选怎么合并。', en: 'Penzor Cloud already has a notes vault. Choose how to combine them in Penzor Cloud › Sync.' },
  'syncSetup.failed': { zh: '有一项没开成：{error}', en: "One item couldn't be turned on: {error}" },
  // 新同步(Extend 内容同步)那版卡片,2026-10-23 蓬洲云同步简化方案:四类带勾,直接开始
  'syncSetup.c.lead': { zh: '登录同一账号的电脑、网页版会共用下面这些内容。', en: 'Computers and the web signed in to this account share what is checked below.' },
  'syncSetup.c.notes': { zh: '笔记', en: 'Notes' },
  'syncSetup.c.notesNamed': { zh: '「{name}」{n} 个文件 · {size}', en: '“{name}” · {n} files · {size}' },
  'syncSetup.c.notesHint': { zh: 'Amadeus 里的智库', en: 'Your Amadeus vault' },
  'syncSetup.c.agentsN': { zh: '{n} 个 Agent 的设置、记忆和日志', en: 'Settings, memory and logs of {n} agents' },
  'syncSetup.c.agentsHint': { zh: '每个 Agent 的设置、记忆和日志', en: 'Each agent’s settings, memory and logs' },
  'syncSetup.c.profile': { zh: '我的资料', en: 'About me' },
  'syncSetup.c.profileHint': { zh: '你的资料和默认日历', en: 'Your profile and default calendar' },
  'syncSetup.c.plugins': { zh: '插件', en: 'Plugins' },
  'syncSetup.c.pluginsHint': { zh: '插件的文件夹和设置', en: 'Plugin folders and settings' },
  'syncSetup.c.counts': { zh: '将上传 {up} 个文件（{size}）、下载 {down} 个；云端已有的不会被覆盖或删除。', en: 'Uploads {up} files ({size}) and downloads {down}. Nothing already in the cloud is overwritten or deleted.' },
  'syncSetup.c.countsPlain': { zh: '将上传 {up} 个文件、下载 {down} 个；云端已有的不会被覆盖或删除。', en: 'Uploads {up} files and downloads {down}. Nothing already in the cloud is overwritten or deleted.' },
  'syncSetup.c.counting': { zh: '正在算要传多少…', en: 'Working out what will move…' },
  'syncSetup.c.recount': { zh: '文件刚有变化，已经重新算过，请再点一次「开始同步」。', en: 'Files just changed, so this was recalculated. Press Start syncing again.' },
  'syncSetup.c.tune': { zh: '以后在「蓬洲云 › 同步」里细调', en: 'Fine-tune later in Penzor Cloud › Sync' },
})

type Cat = 'notes' | 'agents' | 'profile' | 'plugins'
interface SetupPreview { token: string; upload: number; download: number; bytes: number }
interface ContentLite { sources?: Array<{ path: string; size: number; files?: number }> }
interface ContentSetup { preview: SetupPreview | null; legacy?: boolean; error?: string; recount?: boolean; notes?: { files: number; size: number }; agents?: number }
/** Extend 的内容同步通道;回 ok:false 抛错(错误串原样,好认出老 Extend 的「not a Forsion Extend channel」)。 */
async function invokeContent<T>(channel: string, ...args: unknown[]): Promise<T> {
  const r = await window.tangu?.cloudInvoke?.(channel, ...args) as { ok?: boolean; value?: T; error?: string } | undefined
  if (!r?.ok) throw new Error(r?.error ?? 'content_sync_unavailable')
  return r.value as T
}

const PENZOR_SPACE = 'forsion-penzor'
const GB = 1024 ** 3
export const fmtBytes = (n: number): string => n >= GB ? `${(n / GB).toFixed(n >= 10 * GB ? 0 : 1)} GB` : n >= 1024 ** 2 ? `${Math.round(n / 1024 ** 2)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`

const useSync = (): SyncSnapshot | null => useSyncExternalStore(subscribeSync, getSync)

function openPenzor(): void {
  if (useSpaceStore.getState().spaces.some((x) => x.id === PENZOR_SPACE)) setActiveSpace(PENZOR_SPACE)
}

export function SyncSetupHost(): React.JSX.Element | null {
  const { t } = useI18n()
  const [name, setName] = useState('')
  useEffect(() => watchAccountName(setName), [])
  const s = useSync()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [picked, setPicked] = useState<Record<SyncKind, boolean>>({ notes: true, agents: true, plugins: true })
  const [watching, setWatching] = useState(false)
  // 新同步那版:四类勾选 → Extend 按勾选算建议配置并给预览(换算只在 Extend 一处),开始 = 拿预览凭据确认
  const [cpicked, setCpicked] = useState<Record<Cat, boolean>>({ notes: true, agents: true, profile: true, plugins: true })
  const [setup, setSetup] = useState<ContentSetup | null>(null)
  const [nonce, setNonce] = useState(0)
  const main = windowKind() === 'main'
  // 自动弹出的卡片排进宿主的弹窗队列(协议更新、What's new 在前;引导开着时不出)
  const turn = usePopupTurn('syncSetup', open, POPUP_PRIORITY.syncSetup)

  useEffect(() => { if (main && window.remoteSync) startSyncSetup() }, [main])
  const contentMode = !!s?.contentRules
  const picks = JSON.stringify(cpicked)
  useEffect(() => {
    if (!turn || !contentMode) return
    let live = true
    setSetup((x) => ({ ...x, preview: null, error: undefined }))
    void (async () => {
      try {
        const [snap, preview] = await Promise.all([invokeContent<ContentLite>('penzor:sync:get'), invokeContent<SetupPreview | null>('penzor:sync:setup', JSON.parse(picks))])
        if (!live) return
        if (preview === null) { markSyncDecided(); setOpen(false); return } // 这台已经开过新同步:不按卡片覆盖
        const src = snap.sources ?? [], notes = src.find((x) => x.path === 'Amadeus')
        setSetup((x) => ({ recount: x?.recount, preview, notes: notes ? { files: notes.files ?? 0, size: notes.size } : undefined, agents: src.filter((x) => /^agents\/[^/]+$/.test(x.path)).length }))
      } catch (e) {
        if (!live) return
        const m = String((e as Error)?.message ?? e)
        // 老 Extend 没有 setup 通道:退回原来的「插件数据 + 选择同步范围」
        setSetup(/not a Forsion Extend channel/i.test(m) ? { preview: null, legacy: true } : { preview: null, error: m })
      }
    })()
    return () => { live = false }
  }, [turn, contentMode, picks, nonce])
  let obDone = false
  try { obDone = localStorage.getItem(ONBOARDING_DISMISS_KEY) === '1' } catch { /* 读不到当没走完:不弹 */ }
  // 依赖只放这两个布尔:快照每次同步进度 / 插件变动都换新对象,拿它当依赖计时器会一直被重置、永远弹不出来
  const eligible = main && wantsSyncCard(s, obDone)
  const want = eligible && !open
  const allOn = main && !!s && s.signedIn && !s.decided && obDone && s.notes.available && !want && !open
  useEffect(() => { if (allOn) markSyncDecided() }, [allOn])
  useEffect(() => {
    if (!want) return
    // 启动后先让主界面站稳,再弹(别和更新弹窗、引导收尾抢同一帧)
    const timer = setTimeout(() => setOpen(true), 2500)
    return () => clearTimeout(timer)
  }, [want])
  // 排队等着时退出登录(条款卡「不同意并退出登录」)/ 别处已拍板:撤掉,别等轮到了再弹(Codex 评审 P2)。开始同步那几秒自己会把三项打开,不算
  useEffect(() => { if (open && !eligible && !busy) setOpen(false) }, [open, eligible, busy])

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
    else if (picked.notes&&!s.contentRules) setWatching(true)
  }
  const later = (): void => { markSyncDecided(); setOpen(false) }
  const startContent = async (): Promise<void> => {
    if (!setup?.preview) return
    setBusy(true)
    try { await invokeContent('penzor:sync:apply', setup.preview.token) }
    catch (e) {
      setBusy(false)
      const m = String((e as Error)?.message ?? e)
      if (/preview_(changed|expired)/.test(m)) { setSetup({ ...setup, preview: null, recount: true }); setNonce((n) => n + 1); return }
      notifyApp({ text: t('syncSetup.failed', { error: m }), level: 'warning' }); return
    }
    await setSync('plugins', cpicked.plugins) // 插件一行管两样:Plugins 文件夹 + 插件自己存的设置(插件数据通道)
    markSyncDecided(); setBusy(false); setOpen(false)
  }
  const fresh = contentMode && !setup?.legacy

  const notesSub = (() => {
    const { localBytes: size, maxBytes: max } = s.notes
    if (size == null || !max) return t('syncSetup.notesHint')
    if (size > max) return t('syncSetup.notesOver', { size: fmtBytes(size), max: fmtBytes(max) })
    return t('syncSetup.notesSize', { size: fmtBytes(size), max: fmtBytes(max), pct: String(Math.max(1, Math.round(size / max * 100))) })
  })()
  const crows: Array<[Cat, React.JSX.Element, string, string]> = [
    ['notes', <NotebookPen size={15} />, t('syncSetup.c.notes'), s.notes.rootName && setup?.notes ? t('syncSetup.c.notesNamed', { name: s.notes.rootName, n: String(setup.notes.files), size: fmtBytes(setup.notes.size) }) : t('syncSetup.c.notesHint')],
    ['agents', <Bot size={15} />, t('syncSetup.agents'), setup?.agents ? t('syncSetup.c.agentsN', { n: String(setup.agents) }) : t('syncSetup.c.agentsHint')],
    ['profile', <UserRound size={15} />, t('syncSetup.c.profile'), t('syncSetup.c.profileHint')],
    ['plugins', <Puzzle size={15} />, t('syncSetup.c.plugins'), t('syncSetup.c.pluginsHint')],
  ]
  const pv = setup?.preview
  const counts = setup?.error ? t('syncSetup.failed', { error: setup.error }) : !pv ? t('syncSetup.c.counting')
    : (setup?.recount ? t('syncSetup.c.recount') + ' ' : '') + (pv.bytes > 0 ? t('syncSetup.c.counts', { up: String(pv.upload), down: String(pv.download), size: fmtBytes(pv.bytes) }) : t('syncSetup.c.countsPlain', { up: String(pv.upload), down: String(pv.download) }))
  const rows: Array<[SyncKind, React.JSX.Element, string, string]> = [
    ['notes', <NotebookPen size={15} />, s.notes.rootName ? t('syncSetup.notes', { name: s.notes.rootName }) : t('syncSetup.notesAny'), notesSub],
    ['agents', <Bot size={15} />, t('syncSetup.agents'), t('syncSetup.agentsHint')],
    ['plugins', <Puzzle size={15} />, t('syncSetup.plugins'), t('syncSetup.pluginsHint')],
  ]

  return (
    <>
      {turn && (
        <div className="u-backdrop sync-setup-backdrop">
          <div className="modal modal-sm sync-setup" role="dialog" aria-modal="true" aria-label={t('syncSetup.title')}>
            <div className="modal-head"><PenzorIcon width={16} height={16} /><span className="sync-setup-title">{t('syncSetup.title')}</span></div>
            {fresh ? <div className="sync-setup-body">
              <p className="sync-setup-lead">{t('syncSetup.c.lead')}</p>
              {crows.map(([k, icon, title, sub]) => (
                <label key={k} className="sync-setup-row">
                  <input type="checkbox" checked={cpicked[k]} disabled={busy} onChange={(e) => { setCpicked({ ...cpicked, [k]: e.target.checked }); setSetup((x) => x && { ...x, recount: false }) }} />
                  <span className="sync-setup-tile">{icon}</span>
                  <span className="sync-setup-copy"><b>{title}</b><small>{sub}</small></span>
                </label>
              ))}
              <p className="sync-setup-hint">{counts}</p>
            </div> : <div className="sync-setup-body">
              <p className="sync-setup-lead">{s.contentRules?t('syncSetup.scopeLead'):t('syncSetup.lead', { name })}</p>
              <p className="sync-setup-hint">{s.storage?.complete && s.storage.usedBytes != null ? t(s.storage.enforcement ? 'syncSetup.storageEnforced' : 'syncSetup.storage', { used: fmtBytes(s.storage.usedBytes), max: fmtBytes(s.storage.limitBytes) }) : t('syncSetup.storageUnknown')}</p>
              {rows.filter(([k])=>!s.contentRules||k==='plugins').map(([k, icon, title, sub]) => (
                <label key={k} className="sync-setup-row">
                  <input type="checkbox" checked={picked[k]} disabled={busy} onChange={(e) => setPicked({ ...picked, [k]: e.target.checked })} />
                  <span className="sync-setup-tile">{icon}</span>
                  <span className="sync-setup-copy"><b>{title}</b><small>{sub}</small></span>
                </label>
              ))}
            </div>}
            <div className="sync-setup-foot">
              {fresh ? <button type="button" className="sync-setup-link sync-setup-hint" onClick={() => { later(); openPenzorSync() }}>{t('syncSetup.c.tune')}</button> : <span className="sync-setup-hint">{t('syncSetup.footHint')}</span>}
              <span className="sync-setup-acts">
                <button className="btn" disabled={busy} onClick={later}>{t('syncSetup.later')}</button>
                {fresh
                  ? <button className="btn primary" disabled={busy || !pv || !Object.values(cpicked).some(Boolean)} onClick={() => void startContent()}>{t('syncSetup.start')}</button>
                  : <button className="btn primary" disabled={busy} onClick={() => void start()}>{t(s.contentRules?'syncSetup.chooseScope':'syncSetup.start')}</button>}
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
          <button type="button" className="sync-setup-link" onClick={openPenzorSync}>{t('syncSetup.view')}</button>
        </div>
      )}
    </>
  )
}
