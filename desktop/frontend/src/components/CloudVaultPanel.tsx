/**
 * 网页 / 手机的在线智库入口，以及桌面镜像侧沿用的切库面板。
 * 共享和发布的管理都在「共享与发布」总览页,每页的成员和链接在分享卡片(ShareCard)里。
 */
import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { X, FolderOpen, Check, Cloud, CloudCheck, Info } from 'lucide-react'
import { useNativeChromeClaim, type NativeChromeClaim } from '@lcl/engine/nativeChrome'
import { registerMessages, useI18n } from '../i18n'
import { useMobileBackClose } from '../amadeus/lib/mobileBack'
import { cloudLibraryRoot } from '../amadeus/lib/cloudLibraryRoot'
import { flushAllScopes, usePageStore } from '../amadeus/store/pageStore'
import { emitAmadeusToast } from '../amadeus/unified/writeSafety'
import type { CloudLibraryRow } from '../types'
import { ContextMenu } from './RightPanel'
import { cloudVaultDetail, cloudVaultMenuItems, vaultMenuAt, VaultMenuTrigger } from './VaultMenu'
import { MobileSheet } from './MobileSheet'
import './syncSettingsMessages'
import './vaultLandingMessages'
import './cloudVaultPanel.css'

const DEFAULT_VAULT_NAME = 'My Vault'
export const isDefaultVault = (v: { name: string; isDefault?: unknown }): boolean =>
  typeof v.isDefault === 'boolean' ? v.isDefault : v.name === DEFAULT_VAULT_NAME

registerMessages({
  'cloudvault.title': { zh: '云端智库', en: 'Cloud vaults' },
  'cloudvault.myVaults': { zh: '我的库', en: 'My vaults' },
  'cloudvault.switchTitle': { zh: '智库', en: 'Vault' },
  'cloudvault.webHint': { zh: '网页上都是在线打开；要落盘，在电脑上的 Forsion 里点', en: 'On the web, vaults always open online. To download one, use Forsion on your computer' },
  'cloudvault.phoneHint': { zh: '手机上都是在线打开，改动直接存到云端。', en: 'On your phone, vaults always open online. Changes are saved directly to the cloud.' },
  'cloudvault.saved': { zh: '已保存', en: 'Saved' },
  'cloudvault.withStatus': { zh: '{name} · {status}', en: '{name} · {status}' },
  'cloudvault.switchFailed': { zh: '没能切换智库，请重试。', en: 'Couldn’t switch vaults. Please try again.' },
})

const wideWebQuery = '(min-width: 768px)'
function subscribeWideWeb(change: () => void): () => void {
  const media = window.matchMedia(wideWebQuery)
  media.addEventListener('change', change)
  return () => media.removeEventListener('change', change)
}
const isWideWeb = () => window.matchMedia(wideWebQuery).matches
const hiddenChrome: NativeChromeClaim = { mode: 'hidden' }

type Collab = Pick<NonNullable<Window['amadeusCollab']>, 'listLibraries' | 'listVaults' | 'switchLibrary' | 'switchVault'>
type LibraryRead = { collab: Collab; vaultRoot: string | null; open: boolean; rows: CloudLibraryRow[] | null }

export function OnlineVaultSwitcher({ collab, vaultRoot, fallbackName, mobile, open, onOpenChange }: {
  collab: Collab
  vaultRoot: string | null
  fallbackName?: string | null
  mobile: boolean
  open: boolean
  onOpenChange(open: boolean): void
}) {
  const { t } = useI18n()
  const wideWeb = useSyncExternalStore(subscribeWideWeb, isWideWeb) && !mobile
  const rowRef = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null)
  const [read, setRead] = useState<LibraryRead | null>(null)
  const switching = useRef(false)
  const [busy, setBusy] = useState(false)
  const close = () => onOpenChange(false)
  useMobileBackClose(open && !wideWeb, close)
  useNativeChromeClaim(open && !wideWeb ? hiddenChrome : null)
  useLayoutEffect(() => { setAnchor(wideWeb && open ? rowRef.current : null) }, [wideWeb, open])

  useEffect(() => {
    let live = true
    // Read for the footer, then refresh when the picker opens.
    void Promise.resolve().then(async () => {
      if (collab.listLibraries) return collab.listLibraries()
      return (await collab.listVaults()).map((vault): CloudLibraryRow => {
        const isDefault = isDefaultVault(vault)
        return { ...vault, vaultId: vault.id, isDefault, kind: isDefault ? 'default' : 'own' }
      })
    }).then(
      (rows) => { if (live) setRead({ collab, vaultRoot, open, rows }) },
      () => { if (live) setRead({ collab, vaultRoot, open, rows: null }) },
    )
    return () => { live = false }
  }, [collab, vaultRoot, open])

  const result = read?.collab === collab && read.vaultRoot === vaultRoot ? read : null
  const menuResult = result?.open === open ? result : null
  const rows = menuResult?.rows ?? []
  const nameOf = (row: CloudLibraryRow) => row.isDefault ? t('amadeus.default.cloudNotes') : row.name
  const current = result?.rows?.find((row) => cloudLibraryRoot(row.vaultId, row.id) === vaultRoot)
  const name = current ? nameOf(current) : fallbackName ?? t('cloudvault.switchTitle')
  const saved = current ? t('cloudvault.saved') : null
  const pick = async (row: CloudLibraryRow): Promise<void> => {
    if (switching.current || row.id === current?.id) return
    if (row.kind === 'legacy' && !collab.switchLibrary) return
    switching.current = true
    setBusy(true)
    try {
      await flushAllScopes(true)
      const state = usePageStore.getState()
      if (window.amadeusCollab !== collab || state.vaultSide !== 'cloud' || state.vaultRoot !== vaultRoot) return
      if (collab.switchLibrary) collab.switchLibrary(row.id)
      else collab.switchVault(row.id)
      close()
    } catch {
      emitAmadeusToast({ level: 'warning', text: t('cloudvault.switchFailed'), dedupeKey: 'cloud-vault-switch' })
    } finally {
      switching.current = false
      setBusy(false)
    }
  }
  const title = t('cloudvault.switchTitle')
  const group = t('landing.inCloud')
  const hint = menuResult?.rows === null
    ? t('landing.cloudUnreadable')
    : t(wideWeb ? 'cloudvault.webHint' : 'cloudvault.phoneHint')
  const detailOf = (row: CloudLibraryRow) =>
    cloudVaultDetail(t, row.deviceNames?.length ?? 0, row.deviceNames?.[0], row.files)
  const disabled = (row: CloudLibraryRow) => busy || (row.kind === 'legacy' && !collab.switchLibrary)

  if (wideWeb) {
    const items = open ? cloudVaultMenuItems(group, rows.map((row) => {
      const detail = detailOf(row)
      return {
        label: nameOf(row), detail: detail ? `${t('landing.online')} · ${detail}` : t('landing.online'),
        checked: current?.id === row.id, disabled: disabled(row), run: () => void pick(row),
      }
    }), { kind: 'note', icon: <Info size={15} />, label: hint, run: () => {} }) : []
    return (
      <>
        <VaultMenuTrigger rowRef={rowRef} onOpen={() => onOpenChange(true)} expanded={open}
          cloud label={current || fallbackName ? t('amxv.vaultNamed', { name }) : title}>
          {saved && <span className="cloud-vault-saved">{saved}</span>}
        </VaultMenuTrigger>
        {open && anchor && <ContextMenu menu={vaultMenuAt(anchor, items, true)} onClose={close} autoFocus={rows.length > 0} />}
      </>
    )
  }
  return (
    <>
      <button type="button" className="t2s-special" aria-haspopup="dialog" aria-expanded={open}
        aria-label={saved ? t('cloudvault.withStatus', { name, status: saved }) : name} onClick={() => onOpenChange(true)}>
        <span className="t2s-special-ic"><FolderOpen /></span>
        <span className="t2s-special-title">{name}</span>
        {saved && <span className="cloud-vault-saved"><CloudCheck size={15} />{saved}</span>}
      </button>
      {open && createPortal(
        <MobileSheet title={title} onClose={close} className="cloud-vault-sheet" focusClose
          footer={<div className="cloud-vault-sheet-hint">{hint}</div>}>
          <section className="us-section">
            <div className="us-section-title">{group}</div>
            {rows.map((row) => {
              const detail = detailOf(row)
              const selected = row.id === current?.id
              return (
                <button key={row.id} type="button" className="mb-sheet-row us-row" aria-pressed={selected}
                  disabled={disabled(row)} onClick={() => selected ? close() : void pick(row)}>
                  <span className="us-row-icon"><Cloud size={18} /></span>
                  <span className="us-row-main">
                    <span className="us-row-title"><span className="us-row-name">{nameOf(row)}</span></span>
                    {detail && <span className="us-row-sub">{detail}</span>}
                  </span>
                  {selected && <span className="us-row-end"><Check size={16} /></span>}
                </button>
              )
            })}
          </section>
        </MobileSheet>, document.body)}
    </>
  )
}

/** 桌面在线打开在后续批次，镜像侧沿用这张面板。 */
export function CloudVaultPanel({ onClose }: { onClose: () => void }): React.ReactElement | null {
  const { t } = useI18n()
  const collab = window.amadeusCollab
  const [vaults, setVaults] = useState<Array<{ id: string; name: string; isDefault: boolean }>>([])
  const [activeId, setActiveId] = useState('')
  // 手机上系统返回先关这张卡,不越过它去关它底下的笔记列表(桌面上这个事件从不派发)
  useMobileBackClose(true, onClose)

  useEffect(() => {
    if (!collab) return
    // 数据来源(智库同步第 3 步 E1):有 listLibraries 就读库清单(原位置库也是一项,id = libraryId),
    // 没有(老的 collab 实现)照旧 listVaults。默认库(服务端的 My Vault)叫「云端笔记」;老服务端不带 isDefault 就按名字认
    if (collab.listLibraries && collab.activeLibraryId) {
      void collab.listLibraries().then((v) => setVaults(v.map((x) => ({ id: x.id, name: x.name, isDefault: x.isDefault })))).catch(() => {})
      void collab.activeLibraryId().then(setActiveId).catch(() => {})
      return
    }
    void collab.listVaults().then((v) => setVaults(v.map((x) => ({ id: x.id, name: x.name, isDefault: isDefaultVault(x) })))).catch(() => {})
    void collab.activeVaultId().then(setActiveId).catch(() => {})
  }, [collab])

  if (!collab) return null

  return (
    <div className="amxc-overlay" onClick={onClose}>
      <div className="amxc-panel" onClick={(e) => e.stopPropagation()}>
        <div className="amxc-head">
          <span><FolderOpen size={14} /> {t('cloudvault.title')}</span>
          <button className="amxc-x" onClick={onClose}><X size={14} /></button>
        </div>

        <div className="amxc-sec">{t('cloudvault.myVaults')}</div>
        {vaults.map((v) => (
          <button key={v.id} className={`amxc-row${v.id === activeId ? ' on' : ''}`}
            onClick={() => { if (v.id !== activeId) (collab.switchLibrary ?? collab.switchVault)(v.id) }}>
            <span className="amxc-row-name">{v.isDefault ? t('ssync.cloudNotes') : v.name}</span>
            {v.id === activeId && <Check size={13} />}
          </button>
        ))}
      </div>
    </div>
  )
}
