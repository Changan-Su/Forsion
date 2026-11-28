/** 「开启云同步」弹窗:递归关联勾选(关联笔记/附件分组、默认全选)+ 云名冲突两路处理
 *  (换名重试 / 显式合并进现有云文件夹)。命令式打开(openCloudSyncDialog),
 *  Host 挂 AmadeusOverlays(askString 同款模式);数据面 = window.amadeusSync.entrySync*。 */
import { usePageStore } from '@amadeus/store/pageStore'
import { isDesktopExtendOff, isFullSync, isLegacySync, refreshSyncMode, syncModeNow } from '../sync/v2/mode'
import { openSyncSettings } from '../sync/v2/openSyncSettings'
import { useEffect, useState, type ReactNode } from 'react'
import { create } from 'zustand'
import { Cloud, FileText, ListTree, Paperclip } from 'lucide-react'
import { useApp } from '../stores/appStore'
import { isExcludedPath, useEntrySync } from '../stores/entrySyncStore'
import { registerMessages, useI18n } from '../i18n'
import { DialogOverlay } from '../amadeus/components/DialogOverlay'
import type { AmadeusHeldChoice, AmadeusHeldFile } from '../types'
import { isResolveHeldFailure } from './heldResolveResult'

registerMessages({
  'csd.title': { zh: '开启云同步', en: 'Turn on cloud sync' },
  'csd.failed': { zh: '开启云同步失败', en: 'Could not turn on cloud sync' },
  'csd.enabled': { zh: '已开启云同步：云端「{name}」', en: 'Cloud sync is on — cloud folder “{name}”' },
  'csd.selectAll': { zh: '全选', en: 'Select all' },
  'csd.selectNone': { zh: '全不选', en: 'Deselect all' },
  'csd.conflictMsg': {
    zh: '云端智库根目录已有「{name}」。可以换一个云端文件夹名，或把本智库的同步内容合并进现有文件夹（换机后重新开启同步时选「合并」）。',
    en: 'The cloud workspace root already has a folder called “{name}”. Pick a different name for the cloud folder, or merge this vault’s synced content into the existing one (choose Merge when you turn sync back on after switching machines).',
  },
  'csd.newNamePlaceholder': { zh: '新的云端文件夹名', en: 'New cloud folder name' },
  'csd.cancel': { zh: '取消', en: 'Cancel' },
  'csd.mergeInto': { zh: '合并进「{name}」', en: 'Merge into “{name}”' },
  'csd.useNewName': { zh: '用新名字开启', en: 'Use new name' },
  'csd.intro': {
    zh: '「{name}」将带完整相对路径同步到云端智库（双向）。子页面与库内关联默认一并纳入，保留智库里的相对位置；取消勾选即不同步：',
    en: '“{name}” will sync to the cloud workspace with its full relative path (two-way). Subpages and in-vault links are included by default and keep their position in the vault; uncheck anything you do not want synced:',
  },
  'csd.analyzing': { zh: '正在分析关联…', en: 'Analyzing links…' },
  'csd.groupSubPages': { zh: '子页面', en: 'Subpages' },
  'csd.groupLinkedPages': { zh: '关联笔记', en: 'Linked notes' },
  'csd.groupAssets': { zh: '附件', en: 'Attachments' },
  'csd.nothingElse': { zh: '没有子页面与库内关联，仅同步此条目。', en: 'No subpages or in-vault links — only this item will sync.' },
  'csd.enabling': { zh: '开启中…', en: 'Turning on…' },
  'csd.enable': { zh: '开启同步', en: 'Turn on sync' },
  'csd.checking': { zh: '正在和云端对一遍…', en: 'Comparing with the cloud…' },
  'csd.done': { zh: '完成', en: 'Done' },
  // 两边不一样、又没有同步记录的文件:先放着,等用户选(引擎不按时间替用户决定)
  'csd.held.title': { zh: '{n} 篇和云端不一样，等你定', en: '{n} files differ from the cloud — your call' },
  'csd.held.hint': {
    zh: '这几篇没有同步记录，判断不了哪边是旧的，所以两边都没动，其余文件照常同步。被换掉的那份会先存到库外，30 天内能找回。',
    en: 'There is no sync record for these files, so Forsion can’t tell which copy is older. Both copies are left as they are and everything else keeps syncing. Whichever copy you replace is saved outside the vault for 30 days.',
  },
  'csd.held.review': { zh: '逐篇看', en: 'Review' },
  'csd.held.hide': { zh: '收起', en: 'Hide' },
  'csd.held.useLocal': { zh: '用这台的', en: 'Keep this device’s' },
  'csd.held.useCloud': { zh: '用云端的', en: 'Keep the cloud’s' },
  'csd.held.keepBoth': { zh: '两份都留', en: 'Keep both' },
  'csd.held.keepNewer': { zh: '都留较新的', en: 'Keep the newer one' },
  'csd.held.keepNewerTip': {
    zh: '按这台电脑上的修改时间和云端的更新时间逐篇选。时间不一定准，被换掉的那份照样能找回。',
    en: 'Picks each file by this computer’s modified time versus the cloud’s update time. Clocks can be off; the replaced copy can still be recovered.',
  },
  'csd.held.keepBothTip': { zh: '这台的那份改名成冲突副本，原名放云端的那份', en: 'Renames this device’s copy as a conflict copy and puts the cloud’s copy under the original name' },
  'csd.held.newerHere': { zh: '这台更新', en: 'Newer here' },
  'csd.held.newerCloud': { zh: '云端更新', en: 'Newer in the cloud' },
  'csd.held.newerUnknown': { zh: '时间不明', en: 'Time unknown' },
  'csd.held.selected': { zh: '已选 {n} 篇', en: '{n} selected' },
  'csd.held.failed': { zh: '没处理成，请稍后再试', en: 'Could not apply this. Try again in a moment.' },
})

/** 引擎按本机修改时间对云端 updatedAt 给的「哪边更新」只作参考,真正替用户选只在点了「都留较新的」之后。 */
const newerSide = (h: AmadeusHeldFile): 'local' | 'cloud' | null => {
  const at = h.remoteUpdatedAt ? Date.parse(h.remoteUpdatedAt) : NaN
  if (!Number.isFinite(at) || h.localMtimeMs < 0) return null
  return h.localMtimeMs > at ? 'local' : 'cloud'
}

/** 「N 篇和云端不一样,等你定」:侧栏云同步分区、开启同步弹窗、设置页同步那段共用。
 *  binding = 按条目同步的库根(null = 云端镜像);shareKey = 与我共享的库(状态里带来的,原样带回);held 来自该引擎的状态。
 *  勾选决定作用于哪几篇,缺省全选。 */
export function HeldSyncNotice({ binding, shareKey = null, held, open: openInit = false, compact = false }: {
  binding: string | null
  shareKey?: string | null
  held: AmadeusHeldFile[]
  open?: boolean
  compact?: boolean
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(openInit)
  const [off, setOff] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const resolve = window.amadeusSync?.resolveHeld
  if (!held.length) return null
  const chosen = held.filter((h) => !off.has(h.path)).map((h) => h.path)
  const act = async (choice: AmadeusHeldChoice): Promise<void> => {
    if (!resolve || !chosen.length || busy) return
    setBusy(true)
    try {
      const r = await resolve({ binding, ...(shareKey ? { shareKey } : {}), paths: chosen, choice })
      // 成功回的同步状态恒带 error 字段(平时 null),只有不是同步状态的错误回复才算失败
      if (isResolveHeldFailure(r)) useApp.getState().toast(t('csd.held.failed'), true)
    } catch {
      useApp.getState().toast(t('csd.held.failed'), true)
    } finally {
      setBusy(false)
    }
  }
  const name = (h: AmadeusHeldFile): string => (h.local.split('/').pop() ?? h.local).replace(/\.md$/i, '')
  return (
    <div className={`amx-held${compact ? ' is-compact' : ''}`} data-binding={binding ?? ''}>
      <div className="amx-held-head">
        <span className="amx-held-title">{t('csd.held.title', { n: held.length })}</span>
        <button type="button" className="amx-held-link" onClick={() => setOpen((v) => !v)}>
          {open ? t('csd.held.hide') : t('csd.held.review')}
        </button>
      </div>
      {open && (
        <>
          <div className="amx-held-hint">{t('csd.held.hint')}</div>
          <div className="amx-held-list">
            {held.map((h) => {
              const side = newerSide(h)
              return (
                <label key={h.path} className="amx-csd-item" title={h.local}>
                  <input type="checkbox" checked={!off.has(h.path)} onChange={() => setOff((s) => {
                    const n = new Set(s)
                    n.has(h.path) ? n.delete(h.path) : n.add(h.path)
                    return n
                  })} />
                  <span>{name(h)}</span>
                  <span className="amx-csd-path">
                    {side === 'local' ? t('csd.held.newerHere') : side === 'cloud' ? t('csd.held.newerCloud') : t('csd.held.newerUnknown')}
                  </span>
                </label>
              )
            })}
          </div>
          <div className="amx-held-actions">
            {held.length > 1 && <span className="amx-held-count">{t('csd.held.selected', { n: chosen.length })}</span>}
            <button type="button" className="amx-held-btn" disabled={busy || !resolve || !chosen.length} onClick={() => void act('local')}>{t('csd.held.useLocal')}</button>
            <button type="button" className="amx-held-btn" disabled={busy || !resolve || !chosen.length} onClick={() => void act('cloud')}>{t('csd.held.useCloud')}</button>
            <button type="button" className="amx-held-btn" disabled={busy || !resolve || !chosen.length} title={t('csd.held.keepBothTip')} onClick={() => void act('both')}>{t('csd.held.keepBoth')}</button>
            <button type="button" className="amx-held-btn" disabled={busy || !resolve || !chosen.length} title={t('csd.held.keepNewerTip')} onClick={() => void act('newer')}>{t('csd.held.keepNewer')}</button>
          </div>
        </>
      )}
    </div>
  )
}

interface Req {
  path: string
  kind: 'page' | 'folder' | 'asset'
}

const useDialogStore = create<{ req: Req | null; open(r: Req): void; close(): void }>((set) => ({
  req: null,
  open: (req) => set({ req }),
  close: () => set({ req: null }),
}))

export function openCloudSyncDialog(path: string, kind: 'page' | 'folder' | 'asset', asked = false): void {
  // 启动后状态源第一轮还没回来(模式未知)就点了:先问一次再决定去哪,别把完整模式的人送进旧弹窗
  if (!asked && syncModeNow() === 'unknown') { void refreshSyncMode().finally(() => openCloudSyncDialog(path, kind, true)); return }
  // 智库同步第 2 步:完整模式下「同步这个文件夹… / 同步这篇…」都改去设置 › 同步那个库那一行(契约 §3.10),
  // 关联闭包与缺省勾选由设置页照这里原来的算法算(sync/v2/scope.ts closureItems)
  if (isFullSync()) {
    const root = usePageStore.getState().vaultRoot
    openSyncSettings({ ...(root ? { root } : {}), path, kind: kind === 'asset' ? 'file' : kind })
    return
  }
  // 读不出 / 还是问不出来 / 桌面上 Extend 停用:不开旧弹窗写旧注册,去设置 › 同步看原因
  if (!isLegacySync() || isDesktopExtendOff()) { const root = usePageStore.getState().vaultRoot; openSyncSettings(root ? { root } : undefined); return }
  useDialogStore.getState().open({ path, kind })
}

const base = (p: string): string => (p.split(/[\\/]/).pop() ?? p).replace(/\.md$/i, '')

export function CloudSyncDialogHost() {
  const req = useDialogStore((s) => s.req)
  if (!req) return null
  return (
    <div className="am-app tangu-lovable" style={{ display: 'contents' }}>
      <Dialog key={`${req.kind}:${req.path}`} req={req} onClose={() => useDialogStore.getState().close()} />
    </div>
  )
}

function Dialog({ req, onClose }: { req: Req; onClose: () => void }) {
  const { t } = useI18n()
  const [closure, setClosure] = useState<{ pages: string[]; files: string[]; subPages: string[] } | null>(null)
  const [pagesOn, setPagesOn] = useState<Set<string>>(new Set())
  const [filesOn, setFilesOn] = useState<Set<string>>(new Set())
  const [subOn, setSubOn] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState<string | null>(null)
  const [nameDraft, setNameDraft] = useState('')
  /** 开启成功后等这个库第一轮对账:有先放着的文件就留在弹窗里让用户当场定,没有就关。 */
  const [watching, setWatching] = useState<{ root: string; since: number } | null>(null)
  const watched = useEntrySync((s) => (watching ? s.status[watching.root] : undefined))
  const watchedHeld = watched?.held ?? []
  const settled = !!watching && !!watched && watched.state !== 'syncing' && watched.state !== 'starting' && (watched.lastSyncAt ?? 0) >= watching.since
  useEffect(() => {
    if (!watching) return
    if (settled && !watchedHeld.length) onClose()
  }, [watching, settled, watchedHeld.length, onClose])
  useEffect(() => {
    if (!watching) return
    // 对账久不落定(大库、网慢):不拦着用户,先关;先放着的文件侧栏和状态栏照样会挂出来
    const timer = setTimeout(() => { if (!useEntrySync.getState().status[watching.root]?.held?.length) onClose() }, 20_000)
    return () => clearTimeout(timer)
  }, [watching, onClose])

  useEffect(() => {
    let alive = true
    if (req.kind === 'asset') {
      setClosure({ pages: [], files: [], subPages: [] }) // 附件无出链,闭包恒空(entrySyncClosure 只吃 page|folder)
      return
    }
    void window.amadeusSync
      ?.entrySyncClosure?.(req.path, req.kind)
      .then((r) => {
        if (!alive) return
        setClosure({ ...r, subPages: r.subPages ?? [] }) // subPages:旧主进程构建没有 → 当空
        setPagesOn(new Set(r.pages)) // 默认全选:用户要的是「保留相对位置的完整同步」,少勾是例外
        setFilesOn(new Set(r.files))
        // 子页面同样默认全选,但上次剔除过的保持未勾选 —— 否则重开弹窗会显示「全含」而实际仍排除。
        const root = useEntrySync.getState().activeRoot
        setSubOn(new Set((r.subPages ?? []).filter((p) => !isExcludedPath(root, p))))
      })
      .catch(() => alive && setClosure({ pages: [], files: [], subPages: [] }))
    return () => {
      alive = false
    }
  }, [req.path, req.kind])

  const submit = async (opts?: { cloudName?: string; merge?: boolean }): Promise<void> => {
    const api = window.amadeusSync
    if (!api?.entrySyncEnable || busy) return
    setBusy(true)
    const entries = [
      { path: req.path, kind: req.kind },
      ...[...pagesOn].map((p) => ({ path: p, kind: 'page' as const })),
      ...[...filesOn].map((p) => ({ path: p, kind: 'asset' as const })),
    ]
    // 子页面本来就随页进 scope:取消勾选的显式剔除,勾上的显式解除剔除(可能是上次剔的,不送就一直排除着)。
    const subPages = closure?.subPages ?? []
    const exclude = subPages.filter((p) => !subOn.has(p))
    const include = subPages.filter((p) => subOn.has(p))
    type EnableResp = { ok?: boolean; cloudName?: string; conflict?: string; error?: string }
    const r: EnableResp = await api.entrySyncEnable({ entries, exclude, include, ...opts }).catch((e: unknown) => ({ error: String(e) }))
    setBusy(false)
    if (r?.conflict) {
      setConflict(r.conflict)
      setNameDraft(`${r.conflict} 2`)
      return
    }
    if (r?.error || !r?.ok) {
      useApp.getState().toast(r?.error || t('csd.failed'), true)
      return
    }
    useApp.getState().toast(t('csd.enabled', { name: r.cloudName ?? '' }))
    void useEntrySync.getState().refresh()
    const root = useEntrySync.getState().activeRoot
    // 旧 Extend 不报 held:照旧直接关
    if (root && window.amadeusSync?.resolveHeld) setWatching({ root, since: Date.now() })
    else onClose()
  }

  /** `A.fd/B.fd/C.md` 的上级子页面链(近→远:A.fd/B.md、A.md);种子页不在 subPages 里,自然被滤掉。 */
  const subAncestors = (p: string): string[] => {
    const out: string[] = []
    for (let cur = p; ; ) {
      const i = cur.lastIndexOf('.fd/')
      if (i < 0) return out
      cur = `${cur.slice(0, i)}.md`
      out.push(cur)
    }
  }

  /** 子页面勾选级联:exclude 是子树语义 —— 取消勾选连带子树(父级排除了孩子留着勾也没用),
   *  勾上则连带上级(祖先还排除着,单独勾孩子同样不生效)。不级联的话界面会撒谎。 */
  const toggleSub = (p: string): void =>
    setSubOn((s) => {
      const on = !s.has(p)
      const all = closure?.subPages ?? []
      const sub = `${p.replace(/\.md$/i, '')}.fd/`
      const n = new Set(s)
      for (const k of all) {
        if (k !== p && !k.startsWith(sub)) continue
        on ? n.add(k) : n.delete(k)
      }
      if (on) for (const a of subAncestors(p)) if (all.includes(a)) n.add(a)
      return n
    })

  const toggleIn = (set0: Set<string>, p: string): Set<string> => {
    const n = new Set(set0)
    n.has(p) ? n.delete(p) : n.add(p)
    return n
  }

  const group = (
    icon: ReactNode,
    label: string,
    items: string[],
    on: Set<string>,
    flip: (p: string) => void,
    flipAll: (all: boolean) => void,
  ): ReactNode =>
    items.length > 0 && (
      <div className="amx-csd-group">
        <div className="amx-csd-head">
          {icon}
          <span>
            {label}({on.size}/{items.length})
          </span>
          <button className="amx-csd-all" onClick={() => flipAll(on.size < items.length)}>
            {on.size < items.length ? t('csd.selectAll') : t('csd.selectNone')}
          </button>
        </div>
        <div className="amx-csd-list">
          {items.map((p) => (
            <label key={p} className="amx-csd-item" title={p}>
              <input type="checkbox" checked={on.has(p)} onChange={() => flip(p)} />
              <span>{base(p)}</span>
              <span className="amx-csd-path">{p}</span>
            </label>
          ))}
        </div>
      </div>
    )

  return (
    <DialogOverlay onMouseDown={onClose}>
      <div className="dialog amx-csd" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-title">
          <Cloud size={15} style={{ verticalAlign: -2, marginRight: 6 }} />
          {t('csd.title')}
        </div>
        {watching ? (
          <>
            {watchedHeld.length ? (
              <HeldSyncNotice binding={watching.root} held={watchedHeld} open />
            ) : (
              <div className="dialog-msg">{t('csd.checking')}</div>
            )}
            <div className="dialog-actions">
              <button className="dialog-btn" data-primary onClick={onClose}>{t('csd.done')}</button>
            </div>
          </>
        ) : conflict ? (
          <>
            <div className="dialog-msg">{t('csd.conflictMsg', { name: conflict })}</div>
            <input
              className="dialog-input"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              placeholder={t('csd.newNamePlaceholder')}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && nameDraft.trim()) void submit({ cloudName: nameDraft.trim() })
                if (e.key === 'Escape') onClose()
              }}
            />
            <div className="dialog-actions">
              <button className="dialog-btn" onClick={onClose}>{t('csd.cancel')}</button>
              <button className="dialog-btn" disabled={busy} onClick={() => void submit({ cloudName: conflict, merge: true })}>
                {t('csd.mergeInto', { name: conflict })}
              </button>
              <button className="dialog-btn" data-primary disabled={busy || !nameDraft.trim()} onClick={() => void submit({ cloudName: nameDraft.trim() })}>
                {t('csd.useNewName')}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="dialog-msg">{t('csd.intro', { name: base(req.path) })}</div>
            {closure === null ? (
              <div className="dialog-msg">{t('csd.analyzing')}</div>
            ) : (
              <>
                {group(<ListTree size={12} />, t('csd.groupSubPages'), closure.subPages, subOn, toggleSub, (all) => setSubOn(all ? new Set(closure.subPages) : new Set()))}
                {group(<FileText size={12} />, t('csd.groupLinkedPages'), closure.pages, pagesOn, (p) => setPagesOn((s) => toggleIn(s, p)), (all) => setPagesOn(all ? new Set(closure.pages) : new Set()))}
                {group(<Paperclip size={12} />, t('csd.groupAssets'), closure.files, filesOn, (p) => setFilesOn((s) => toggleIn(s, p)), (all) => setFilesOn(all ? new Set(closure.files) : new Set()))}
                {!closure.pages.length && !closure.files.length && !closure.subPages.length && (
                  <div className="dialog-msg" style={{ opacity: 0.6 }}>{t('csd.nothingElse')}</div>
                )}
              </>
            )}
            <div className="dialog-actions">
              <button className="dialog-btn" onClick={onClose}>{t('csd.cancel')}</button>
              <button className="dialog-btn" data-primary disabled={busy || closure === null} onClick={() => void submit()}>
                {busy ? t('csd.enabling') : t('csd.enable')}
              </button>
            </div>
          </>
        )}
      </div>
    </DialogOverlay>
  )
}
