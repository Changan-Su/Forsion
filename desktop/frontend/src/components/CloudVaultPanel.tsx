/**
 * 云端库面板(window.amadeusCollab 解闸;web/桌面同款):只管切换我的库。
 * 共享和发布的管理都在「共享与发布」总览页,每页的成员和链接在分享卡片(ShareCard)里。
 */
import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, FolderOpen, Check } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'

registerMessages({
  'cloudvault.title': { zh: '云端智库', en: 'Cloud vaults' },
  'cloudvault.myVaults': { zh: '我的库', en: 'My vaults' },
})

export function CloudVaultPanel({ onClose }: { onClose: () => void }): React.ReactElement | null {
  const { t } = useI18n()
  const collab = window.amadeusCollab
  const [vaults, setVaults] = useState<Array<{ id: string; name: string }>>([])
  const [activeId, setActiveId] = useState('')

  useEffect(() => {
    if (!collab) return
    void collab.listVaults().then((v) => setVaults(v.map((x) => ({ id: x.id, name: x.name })))).catch(() => {})
    void collab.activeVaultId().then(setActiveId).catch(() => {})
  }, [collab])

  if (!collab) return null

  // 挂到 body 下:它是整屏遮罩,留在笔记列表里会再吃一层列表抽屉的 zoom(手机上抽屉体与 body 各 1.15),
  // 卡片被放大到比屏幕还宽、关闭钮出屏(手机走查 2026-11-19)。React 事件照旧沿组件树冒泡。
  return createPortal(
    <div className="amxc-overlay" onClick={onClose}>
      <div className="amxc-panel" onClick={(e) => e.stopPropagation()}>
        <div className="amxc-head">
          <span><FolderOpen size={14} /> {t('cloudvault.title')}</span>
          <button className="amxc-x" onClick={onClose}><X size={14} /></button>
        </div>

        <div className="amxc-sec">{t('cloudvault.myVaults')}</div>
        {vaults.map((v) => (
          <button key={v.id} className={`amxc-row${v.id === activeId ? ' on' : ''}`}
            onClick={() => { if (v.id !== activeId) collab.switchVault(v.id) }}>
            <span className="amxc-row-name">{v.name}</span>
            {v.id === activeId && <Check size={13} />}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  )
}
