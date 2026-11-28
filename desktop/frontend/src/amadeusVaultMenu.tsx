// 左栏底部「智库」按钮 + 菜单(多智库第 1 步):本机用过的库、打开文件夹 / 新建 / 同步设置。
// 只在桌面本地侧出现;云侧和网页仍是 CloudVaultPanel。切库走 pageStore.switchLocalVault(先在旧根落盘再换根)。
import React, { useRef, useState } from 'react'
import { ChevronsUpDown, Folder, FolderOpen, FolderPlus, FolderSearch, FolderX, ListX, RefreshCw } from 'lucide-react'
import type { LocalVaultRow } from '@amadeus-shared/ipc'
import { amadeus } from '@amadeus/api'
import { usePageStore } from '@amadeus/store/pageStore'
import { askString } from '@amadeus/components/askString'
import { emitAmadeusToast } from '@amadeus/unified/writeSafety'
import { ContextMenu, type CtxItem, type CtxMenu } from './components/RightPanel'
import { openPenzorSync, penzorSyncReady } from './services/syncSetup'
import { isFullSync, isLegacySync } from './sync/v2/mode'
import { openSyncSettings } from './sync/v2/openSyncSettings'
import { registerMessages, translate, useI18n } from './i18n'
import { composeVaultSync } from '../../shared/vaultSync'
import { VaultSyncChip } from './sync/VaultSyncChip'
import { feedsOf, useVaultSyncRaw } from './sync/vaultSyncStore'
import { vaultSyncWords } from './sync/vaultSyncText'

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
  const { t } = useI18n()
  const [menu, setMenu] = useState<CtxMenu>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const name = vaultRoot?.split(/[\\/]/).filter(Boolean).pop()

  const rowMenu = (row: LocalVaultRow, at: { x: number; y: number }): void => setMenu({ ...at, items: [
    { label: t(isMac() ? 'vaultMenu.reveal' : 'vaultMenu.revealOther'), icon: <FolderSearch size={14} />, disabled: !row.exists, run: () => void amadeus.revealVault?.(row.root) },
    { label: t('vaultMenu.forget'), icon: <ListX size={14} />, disabled: row.current || row.pinned, run: () => void amadeus.forgetVault?.(row.root) },
  ] })

  const open = async (el: HTMLElement): Promise<void> => {
    const rows = await amadeus?.listVaults?.().catch(() => null)
    if (!rows) return
    // 每个库那一行的同步说法和左栏、面板同一份(状态源合成);没在同步的只写位置
    const feeds = feedsOf(useVaultSyncRaw.getState())
    const now = Date.now()
    const syncWords = (root: string): string | null => {
      const view = composeVaultSync(feeds, { root, side: 'local' }, now)
      return view.state === 'off' ? null : vaultSyncWords(view, now, t).text
    }
    const items: CtxItem[] = rows.map((row) => ({
      label: row.name,
      detail: row.exists ? ((w) => (w ? `${w} · ${row.display}` : row.display))(syncWords(row.root)) : `${t('vaultMenu.missingDetail')} · ${row.display}`,
      icon: row.exists ? <Folder size={15} /> : <FolderX size={15} />,
      // 勾 / 跳过按本窗绑的根判,不按全局 current:别的窗口换过库后,本窗点任一行都要能重新绑上(Codex 评审)
      checked: row.root === vaultRoot,
      run: () => {
        if (row.root === vaultRoot) return
        if (!row.exists) return warn(translate('vaultMenu.missing', { name: row.name }))
        void usePageStore.getState().switchLocalVault(row.root).catch((e) => failed(e, row.name))
      },
      onSecondary: (at) => rowMenu(row, at),
    }))
    items.push(
      { label: t('vaultMenu.openFolder'), icon: <FolderOpen size={15} />, separatorBefore: true, run: () => void usePageStore.getState().openVault() },
      { label: t('vaultMenu.new'), icon: <FolderPlus size={15} />, run: () => void newVault() },
    )
    // 第 2 步完整模式:同步设置在设置 › 同步(定位到当前库那一行);其余照旧去蓬洲云的同步页
    if (isFullSync()) items.push({ label: t('vaultMenu.syncSettings'), icon: <RefreshCw size={15} />, run: () => openSyncSettings(vaultRoot ? { root: vaultRoot } : undefined) })
    else if (isLegacySync() && penzorSyncReady()) items.push({ label: t('vaultMenu.syncSettings'), icon: <RefreshCw size={15} />, run: openPenzorSync })
    const r = el.getBoundingClientRect()
    setMenu({ x: r.left, y: r.bottom, anchorTop: r.top, items })
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
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </>
  )
}
