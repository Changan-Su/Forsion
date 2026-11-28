import React from 'react'
import { ChevronsUpDown, Cloud, FolderOpen } from 'lucide-react'
import type { CtxItem, CtxMenu } from './RightPanel'
import { useI18n } from '../i18n'
import './vaultLanding.css'

type CloudMenuRow = Omit<CtxItem, 'icon' | 'kind'>

export function cloudVaultMenuItems(
  label: string, rows: CloudMenuRow[], note?: CtxItem, separatorBefore = false,
): CtxItem[] {
  return [
    { kind: 'head', label, separatorBefore, run: () => {} },
    ...rows.map((row) => ({ ...row, icon: <Cloud size={15} /> })),
    ...(note ? [note] : []),
  ]
}

export function vaultMenuAt(el: HTMLElement, items: CtxItem[], grouped: boolean): NonNullable<CtxMenu> {
  const r = el.getBoundingClientRect()
  return { x: r.left, y: r.bottom, anchorTop: r.top, className: grouped ? 'ctx-vault-menu' : undefined, items }
}

export function cloudVaultDetail(
  t: ReturnType<typeof useI18n>['t'], devices: number, deviceName?: string, files?: number | null,
): string | undefined {
  if (devices === 1 && deviceName) return t('landing.oneDevice', { device: deviceName })
  if (devices > 0) return t('ssync.cloudDeviceCount', { n: devices })
  if (typeof files === 'number') return t('ssync.cloudFiles', { n: files })
  return undefined
}

export function VaultMenuTrigger({ rowRef, onOpen, expanded, title, label, cloud, children }: {
  rowRef: React.RefObject<HTMLDivElement | null>
  onOpen(el: HTMLDivElement): void
  expanded: boolean
  title?: string
  label: string
  cloud?: boolean
  children?: React.ReactNode
}) {
  const open = () => { if (rowRef.current) onOpen(rowRef.current) }
  return (
    <div className="t2s-special amx-vault-row" ref={rowRef}>
      <button type="button" className="amx-vault-name" onClick={open} title={title} aria-haspopup="menu" aria-expanded={expanded}>
        <span className="t2s-special-ic">{cloud ? <Cloud /> : <FolderOpen />}</span>
        <span className="t2s-special-title">{label}</span>
        {cloud && children}
      </button>
      {!cloud && children}
      <button type="button" className="t2s-special-go" tabIndex={-1} aria-hidden="true" onClick={open}><ChevronsUpDown size={13} /></button>
    </div>
  )
}
