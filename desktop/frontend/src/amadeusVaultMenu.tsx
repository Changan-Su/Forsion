// 左栏底部「智库」按钮 + 菜单(多智库第 1 步):本机用过的库、打开文件夹 / 新建 / 同步设置。
// 只在桌面本地侧出现;云侧和网页仍是 CloudVaultPanel。切库走 pageStore.switchLocalVault(先在旧根落盘再换根)。
import React, { useRef, useState } from 'react'
import { ChevronsUpDown, Cloud, CloudOff, Download, Folder, FolderOpen, FolderPlus, FolderSearch, FolderX, ListX, RefreshCw } from 'lucide-react'
import type { LocalVaultRow } from '@amadeus-shared/ipc'
import { amadeus } from '@amadeus/api'
import { usePageStore } from '@amadeus/store/pageStore'
import { askString } from '@amadeus/components/askString'
import { emitAmadeusToast } from '@amadeus/unified/writeSafety'
import { ContextMenu, type CtxItem, type CtxMenu } from './components/RightPanel'
import { openPenzorSync, penzorSyncReady } from './services/syncSetup'
import { isDesktopExtendOff, isFullSync, isLegacySync, modeFrom, setSyncMode } from './sync/v2/mode'
import { downloadPreviewFocus, openSyncSettings } from './sync/v2/openSyncSettings'
import { registerMessages, translate, useI18n } from './i18n'
import { composeVaultSync } from '../../shared/vaultSync'
import { VaultSyncChip } from './sync/VaultSyncChip'
import { feedsOf, useVaultSync, useVaultSyncRaw } from './sync/vaultSyncStore'
import { vaultSyncWords } from './sync/vaultSyncText'
import { vaultSync } from './sync/v2/client'
import { cloudOnlyRows, folderHost, type CloudRow } from './sync/v2/vaultSurfaces'
import { uploadOption, type CreateVaultRun } from './sync/v2/createVault'
import type { DownloadLibrary } from './sync/v2/download'
import type { BindingView } from './sync/v2/types'
import { canViewPenzorLibrary, openPenzorLibrary } from './sync/v2/openPenzorLibrary'
import { stopLocalPlan } from './sync/v2/finishStopLanding'
import { VaultSyncPanel, bytesText } from './sync/VaultSyncPanel'
import { DownloadVaultDialog } from './components/DownloadVaultDialog'
import { NewVaultDialog } from './components/NewVaultDialog'
import { StopDownloadCard } from './components/StopDownloadCard'
import { windowKind } from './windowKind'
import { landingError } from './components/vaultLandingMessages'

registerMessages({
  'vaultMenu.missingDetail': { zh: '找不到文件夹', en: 'Folder not found' },
  'vaultMenu.openFolder': { zh: '打开文件夹作为智库…', en: 'Open folder as vault…' },
  'vaultMenu.new': { zh: '新建智库…', en: 'New vault…' },
  'vaultMenu.syncSettings': { zh: '同步设置…', en: 'Sync settings…' },
  'vaultMenu.reveal': { zh: '在访达中显示', en: 'Show in Finder' },
  'vaultMenu.revealOther': { zh: '在文件夹中显示', en: 'Show in folder' },
  'vaultMenu.forget': { zh: '从清单移除', en: 'Remove from list' },
  'vaultMenu.newTitle': { zh: '新建智库', en: 'New vault' },
  'vaultMenu.newLabel': { zh: '名字（会在 Forsion/Vaults 下建同名文件夹）', en: 'Name (a folder with this name is created in Forsion/Vaults)' },
  'vaultMenu.create': { zh: '新建', en: 'Create' },
  'vaultMenu.missing': { zh: '找不到「{name}」的文件夹，可能被移动或删除了。右键可从清单移除。', en: 'The folder for “{name}” is missing. It may have been moved or deleted. Right-click to remove it from the list.' },
  'vaultMenu.exists': { zh: 'Forsion/Vaults 里已经有「{name}」文件夹了，换个名字，或用「打开文件夹作为智库」打开它。', en: 'Forsion/Vaults already has a folder named “{name}”. Pick another name, or open it with “Open folder as vault”.' },
  'vaultMenu.badName': { zh: '名字不能为空、不能以点开头，也不能带 / \\ : * ? " < > |', en: 'The name can’t be empty, start with a dot, or contain / \\ : * ? " < > |' },
  'vaultMenu.failed': { zh: '没能打开智库：{e}', en: 'Couldn’t open the vault: {e}' },
})

const isMac = (): boolean => window.tangu?.platform === 'darwin'

function warn(text: string): void { emitAmadeusToast({ level: 'warning', text, dedupeKey: 'vault-menu' }) }

function failed(e: unknown, name = ''): void {
  const msg = e instanceof Error ? e.message : String(e)
  if (msg.includes('EEXIST')) warn(translate('vaultMenu.exists', { name }))
  else if (msg.includes('invalid-name')) warn(translate('vaultMenu.badName'))
  else if (msg.includes('vault-missing')) warn(translate('vaultMenu.missing', { name }))
  else warn(translate('vaultMenu.failed', { e: msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }))
}

async function newVault(): Promise<void> {
  const name = await askString(translate('vaultMenu.newTitle'), '', { label: translate('vaultMenu.newLabel'), confirmLabel: translate('vaultMenu.create') })
  if (name) await usePageStore.getState().createLocalVault(name).catch((e) => failed(e, name))
}

/** 底部按钮:点开智库菜单。宿主没有 listVaults(老主进程)时调用方别渲染它。 */
export function LocalVaultButton({ vaultRoot }: { vaultRoot: string | null }) {
  const { t, locale } = useI18n()
  const [menu, setMenu] = useState<CtxMenu>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const name = vaultRoot?.split(/[\\/]/).filter(Boolean).pop()

  const [download, setDownload] = useState<DownloadLibrary | null>(null)
  const [creating, setCreating] = useState<{ option: React.ComponentProps<typeof NewVaultDialog>['option'] } | null>(null)
  const [stopping, setStopping] = useState<{ binding: BindingView; blocked: boolean } | null>(null)
  const [review, setReview] = useState<BindingView | null>(null)
  const reviewView = useVaultSync({ root: review?.root ?? null, side: 'local' })
  const [failedUploads, setFailedUploads] = useState<Set<string>>(() => new Set())
  const menuRequest = useRef(0)
  const closeMenu = () => { ++menuRequest.current; setMenu(null) }
  const notify = (key: string, vars: Record<string, unknown>, error = false) =>
    emitAmadeusToast({ level: error ? 'warning' : 'info', text: t(key, vars), dedupeKey: 'vault-menu' })
  const created = (result: Extract<CreateVaultRun, { kind: 'created' }>, vaultName: string) => {
    if (result.upload === 'failed') {
      setFailedUploads((roots) => new Set(roots).add(result.root))
      notify('landing.uploadFailed', { name: vaultName, reason: landingError(t, result.reason, vaultName) }, true)
    }
    if (!result.opened) notify('landing.openFailed', { name: vaultName }, true)
  }

  const open = async (el: HTMLElement): Promise<void> => {
    const request = ++menuRequest.current
    const [rows, synced, auth] = await Promise.all([
      amadeus?.listVaults?.().catch(() => null),
      vaultSync.get(locale === 'zh' ? 'zh' : 'en'),
      window.tangu?.authStatus?.().catch(() => null),
    ])
    if (!rows || request !== menuRequest.current) return
    const mode = modeFrom(synced)
    setSyncMode(mode)
    const full = synced.ok && synced.value?.mode === 'full' ? synced.value : null
    const listed = full && auth?.loggedIn === true ? await vaultSync.libraries() : null
    if (request !== menuRequest.current || !el.isConnected) return
    const freshness = listed?.ok ? (listed.value.stale ? 'offline' : 'fresh') : (listed?.error === 'offline' || (listed?.error === 'not_fetched' && navigator.onLine === false)) ? 'offline'
      : listed?.error === 'libraries_cache_unreadable' ? 'unreadable' : 'hidden'
    const grouped = freshness !== 'hidden'
    const actions = amadeus.vaultSyncActions?.()
    const canManageLocal = windowKind() === 'main' && !!folderHost(amadeus)
    const canDownload = !!actions?.download && canManageLocal
    const cloudRows = full && listed?.ok ? cloudOnlyRows(full, listed.value.list.libraries) : []
    const feeds = feedsOf(useVaultSyncRaw.getState())
    const now = Date.now()
    const syncWords = (root: string): string | null => {
      const view = composeVaultSync(feeds, { root, side: 'local' }, now)
      return view.state === 'off' ? null : vaultSyncWords(view, now, t).text
    }
    const viewCloud = canViewPenzorLibrary()
    const cloudName = (row: CloudRow) => row.kind === 'default' ? t('amadeus.default.cloudNotes') : row.name
    const rowMenu = (row: LocalVaultRow, binding: BindingView | undefined, at: { x: number; y: number }) => setMenu({ ...at, items: [
      { label: t(isMac() ? 'vaultMenu.reveal' : 'vaultMenu.revealOther'), icon: <FolderSearch size={14} />, disabled: !row.exists, run: () => void amadeus.revealVault?.(row.root) },
      { label: t('vaultMenu.forget'), icon: <ListX size={14} />, disabled: row.current || row.pinned, run: () => void amadeus.forgetVault?.(row.root) },
      ...(full && auth?.loggedIn === true && actions?.unbind && canManageLocal && amadeus.moveSyncVaultPin && binding?.target.kind === 'penzor' ? [
        { label: t('landing.stop'), icon: <FolderX size={14} />, run: () => setStopping({ binding, blocked: stopLocalPlan(rows, row.root, vaultRoot).blocked }) },
      ] : []),
      ...(full && actions?.create && !binding && row.exists && auth?.loggedIn === true ? [
        { label: t('landing.uploadMenu'), icon: <Cloud size={14} />, run: () => openSyncSettings({ root: row.root, intent: 'start' }) },
      ] : []),
    ] })
    const items: CtxItem[] = []
    if (grouped && rows.length) items.push({ kind: 'head', label: t('landing.onComputer'), run: () => {} })
    for (const row of rows) {
      const binding = full?.bindings.find((b) => b.root === row.root && b.role === 'primary') ?? full?.bindings.find((b) => b.root === row.root)
      const matchedId = full?.localVaults.find((v) => v.root === row.root)?.libraryId
      const sameName = row.exists && !binding && !!matchedId && !!listed?.ok
        && listed.value.list.libraries.some((lib) => lib.id === matchedId && !lib.deleted)
      const words = syncWords(row.root)
      items.push({
        label: row.name,
        detail: !row.exists ? `${t('vaultMenu.missingDetail')} · ${row.display}`
          : sameName ? t('landing.sameName') : grouped || !words ? row.display : `${words} · ${row.display}`,
        title: row.display,
        status: !sameName && (grouped || failedUploads.has(row.root)) ? words ?? t('landing.localOnly') : undefined,
        action: sameName || (full && !binding && failedUploads.has(row.root)) ? {
          label: t(sameName ? 'landing.sync' : 'landing.uploadMenu'),
          run: () => openSyncSettings({ root: row.root, intent: 'start' }),
        } : undefined,
        icon: row.exists ? <Folder size={15} /> : <FolderX size={15} />,
        checked: row.root === vaultRoot,
        run: () => {
          if (row.root === vaultRoot) return
          if (!row.exists) return warn(translate('vaultMenu.missing', { name: row.name }))
          void usePageStore.getState().switchLocalVault(row.root).catch((e) => failed(e, row.name))
        },
        onSecondary: (at) => rowMenu(row, binding, at),
      })
    }
    if (grouped && (cloudRows.length || freshness !== 'fresh')) {
      items.push({ kind: 'head', label: t('landing.inCloud'), separatorBefore: !!items.length, run: () => {} })
      for (const row of cloudRows) {
        const { devices, deviceNames, files, bytes } = row
        const detail = devices === 1 && deviceNames?.[0] ? t('landing.oneDevice', { device: deviceNames[0] }) :
          devices > 0 ? t('ssync.cloudDeviceCount', { n: devices }) : typeof files === 'number' ? t('ssync.cloudFiles', { n: files }) : t('ssync.cloudNoDevice')
        items.push({
          label: cloudName(row), icon: <Cloud size={15} />, detail: `${t('landing.online')} · ${detail}`,
          disabled: freshness !== 'fresh', dimmed: freshness === 'fresh',
          run: () => notify('landing.onlineUnavailable', {}),
          onSecondary: freshness !== 'fresh' ? undefined : (at) => setMenu({ ...at, items: [
            ...(canDownload ? [{
              label: t('landing.download'), icon: <Download size={14} />, disabled: row.kind === 'default',
              detail: row.kind === 'default' ? t('landing.err.default_unsupported') :
                typeof files === 'number' && typeof bytes === 'number' ? t('landing.amountSchedule', { amount: t('landing.amount', { n: files, size: bytesText(bytes) }) }) : undefined,
              run: () => setDownload(row),
            }] : []),
            {
              label: t('landing.viewCloud'), detail: viewCloud ? undefined : t('landing.viewUnavailable'), icon: <Cloud size={14} />,
              disabled: !viewCloud, run: () => {
                void openPenzorLibrary(row.id, cloudName(row)).then((opened) => {
                  if (!opened) warn(t('landing.viewUnavailable'))
                }, () => warn(t('landing.viewUnavailable')))
              },
            },
          ] }),
        })
      }
      items.push({ kind: 'note', icon: <CloudOff size={15} />, run: () => {}, label: t(
        freshness === 'offline' ? 'landing.err.offline' : freshness === 'unreadable' ? 'landing.cloudUnreadable' :
          canDownload ? 'landing.onlineGroupHint' : 'landing.onlineUnavailable',
      ) })
    }

    items.push(
      { label: t('vaultMenu.openFolder'), icon: <FolderOpen size={15} />, separatorBefore: true, run: () => void usePageStore.getState().openVault() },
      { label: t('vaultMenu.new'), icon: <FolderPlus size={15} />, run: () => {
        if (!canManageLocal) { void newVault(); return }
        const option = !actions?.create ? null : freshness === 'offline'
          ? { available: false as const, defaultChecked: false as const, reason: 'offline' as const }
          : auth?.loggedIn === false ? { available: false as const, defaultChecked: false as const, reason: 'not_signed_in' as const }
          : uploadOption({ mode: mode.mode, signedIn: auth?.loggedIn ?? null, get: full })
        setCreating({ option })
      } },
    )
    if (isFullSync()) items.push({ label: t('vaultMenu.syncSettings'), icon: <RefreshCw size={15} />, run: () => openSyncSettings(vaultRoot ? { root: vaultRoot } : undefined) })
    else if (isLegacySync() && !isDesktopExtendOff() && penzorSyncReady()) items.push({ label: t('vaultMenu.syncSettings'), icon: <RefreshCw size={15} />, run: openPenzorSync })
    const r = el.getBoundingClientRect()
    setMenu({ x: r.left, y: r.bottom, anchorTop: r.top, className: grouped ? 'ctx-vault-menu' : undefined, items })
  }

  // 名字和箭头开智库菜单,中间的状态小字开同步面板(VaultSyncChip;这个库没在同步时它不占地方)
  return (
    <>
      <div className="t2s-special amx-vault-row" ref={rowRef}>
        <button type="button" className="amx-vault-name" onClick={() => rowRef.current && void open(rowRef.current)} title={vaultRoot || undefined} aria-haspopup="menu" aria-expanded={!!menu}>
          <span className="t2s-special-ic"><FolderOpen /></span>
          <span className="t2s-special-title">{name ? t('amxv.vaultNamed', { name }) : t('amxv.openVault')}</span>
        </button>
        {vaultRoot && name && <VaultSyncChip vault={{ root: vaultRoot, side: 'local' }} name={name} rowRef={rowRef} />}
        <button type="button" className="t2s-special-go" tabIndex={-1} aria-hidden="true" onClick={() => rowRef.current && void open(rowRef.current)}><ChevronsUpDown size={13} /></button>
      </div>
      {menu && <ContextMenu menu={menu} onClose={closeMenu} autoFocus />}
      {download && <DownloadVaultDialog key={download.id} library={download} onClose={() => setDownload(null)}
        onPreview={(preview) => openSyncSettings(downloadPreviewFocus(preview))} />}
      {creating && <NewVaultDialog option={creating.option} onClose={() => setCreating(null)}
        onDownload={(lib) => { setCreating(null); setDownload(lib) }} onCreated={created} />}
      {stopping && <StopDownloadCard binding={stopping.binding} blocked={stopping.blocked} onClose={() => setStopping(null)}
        onReview={() => setReview(stopping.binding)}
        onStopped={(forgot) => notify(forgot ? 'landing.stopped' : 'landing.forgetFailed', { name: stopping.binding.name }, !forgot)} />}
      {review && <VaultSyncPanel vault={{ root: review.root, side: 'local' }} name={review.name}
        view={reviewView}
        anchorRef={rowRef} onClose={() => setReview(null)} />}
    </>
  )
}
