/**
 * 云端库面板(window.amadeusCollab 解闸;web/桌面同款):只管切换我的库。
 * 共享和发布的管理都在「共享与发布」总览页,每页的成员和链接在分享卡片(ShareCard)里。
 */
import React, { useEffect, useState } from 'react'
import { X, FolderOpen, Check } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import { useMobileBackClose } from '../amadeus/lib/mobileBack'
import './syncSettingsMessages'

const DEFAULT_VAULT_NAME = 'My Vault'
export const isDefaultVault = (v: { name: string; isDefault?: unknown }): boolean =>
  typeof v.isDefault === 'boolean' ? v.isDefault : v.name === DEFAULT_VAULT_NAME

registerMessages({
  'cloudvault.title': { zh: '云端智库', en: 'Cloud vaults' },
  'cloudvault.myVaults': { zh: '我的库', en: 'My vaults' },
})

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
