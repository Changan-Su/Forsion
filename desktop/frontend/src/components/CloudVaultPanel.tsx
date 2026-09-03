/**
 * 云端库面板(window.amadeusCollab 解闸;web/桌面同款):
 * 我的库切换 + 「与我共享」(页面级共享,点击进入) + 已发布链接管理。
 * 成员/邀请管理在每页的分享卡片(ShareCard)里,不在这里。
 */
import React, { useEffect, useState } from 'react'
import { X, Copy, Trash2, FolderOpen, Check, Users, Globe2 } from 'lucide-react'
import { useApp } from '../stores/appStore'
import { openNote } from '../amadeusNav'
import { registerMessages, useI18n } from '../i18n'

registerMessages({
  'cloudvault.title': { zh: '云端笔记库', en: 'Cloud vaults' },
  'cloudvault.myVaults': { zh: '我的库', en: 'My vaults' },
  'cloudvault.sharedWithMe': { zh: '与我共享 · {n}', en: 'Shared with me · {n}' },
  'cloudvault.sharedEmpty': { zh: '别人共享给你的页面会出现在这里(打开对方发的邀请链接并同意)。', en: 'Pages other people share with you show up here — open their invite link and accept it.' },
  'cloudvault.roleViewer': { zh: '只读', en: 'Read-only' },
  'cloudvault.roleEditor': { zh: '可编辑', en: 'Can edit' },
  'cloudvault.published': { zh: '已发布 · {n}', en: 'Published · {n}' },
  'cloudvault.publishedEmpty': { zh: '在笔记的「分享 → 发布」里生成公开链接,链接会列在这里。', en: 'Create a public link from a note under Share → Publish, and it will be listed here.' },
  'cloudvault.copyLink': { zh: '复制链接', en: 'Copy link' },
  'cloudvault.unpublish': { zh: '取消发布', en: 'Unpublish' },
  'cloudvault.unpublished': { zh: '已取消发布,链接立即失效', en: 'Unpublished — the link stopped working immediately' },
})

export function CloudVaultPanel({ onClose }: { onClose: () => void }): React.ReactElement | null {
  const { t } = useI18n()
  const collab = window.amadeusCollab
  const toast = (msg: string, err = false): void => useApp.getState().toast(msg, err)
  const [vaults, setVaults] = useState<Array<{ id: string; name: string }>>([])
  const [activeId, setActiveId] = useState('')
  const [shared, setShared] = useState<Array<{ vaultId: string; path: string; title: string; role: string; ownerName: string | null }>>([])
  const [pubs, setPubs] = useState<Array<{ token: string; mode: string; path: string }>>([])
  const [quota, setQuota] = useState<{ publish: number } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const refresh = (): void => {
    if (!collab) return
    void collab.listVaults().then((v) => setVaults(v.map((x) => ({ id: x.id, name: x.name })))).catch(() => {})
    void collab.activeVaultId().then(setActiveId).catch(() => {})
    void collab.sharedWithMe().then(setShared).catch(() => setShared([]))
    void collab.publishes().then((r) => { setPubs(r.shares); setQuota(r.quota) }).catch(() => setPubs([]))
  }
  useEffect(refresh, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (!collab) return null

  const copy = (url: string, key: string): void => {
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(key)
      setTimeout(() => setCopied(null), 1200)
    })
  }

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
            onClick={() => { if (v.id !== activeId) collab.switchVault(v.id) }}>
            <span className="amxc-row-name">{v.name}</span>
            {v.id === activeId && <Check size={13} />}
          </button>
        ))}

        <div className="amxc-sec"><Users size={12} /> {t('cloudvault.sharedWithMe', { n: shared.length })}</div>
        {shared.length === 0 && <div className="amxc-hint">{t('cloudvault.sharedEmpty')}</div>}
        {shared.map((s) => (
          <button key={`${s.vaultId}:${s.path}`} className="amxc-row"
            onClick={() => {
              onClose()
              if (s.vaultId === activeId) void openNote(s.path)
              else collab.switchVault(s.vaultId) // 切库后树只显示共享范围(服务端过滤)
            }}>
            <span className="amxc-row-name">{s.title}</span>
            <span className="amxc-tag">{s.role === 'viewer' ? t('cloudvault.roleViewer') : t('cloudvault.roleEditor')}{s.ownerName ? ` · ${s.ownerName}` : ''}</span>
          </button>
        ))}

        <div className="amxc-sec"><Globe2 size={12} /> {t('cloudvault.published', { n: pubs.length })}{quota && Number.isFinite(quota.publish) ? ` / ${quota.publish}` : ''}</div>
        {pubs.length === 0 && <div className="amxc-hint">{t('cloudvault.publishedEmpty')}</div>}
        {pubs.map((s) => (
          <div key={s.token} className="amxc-row static">
            <span className="amxc-row-name" title={s.path}>{s.mode === 'subtree' ? '📁 ' : '📄 '}{s.path}</span>
            <button className="amxc-ic" title={t('cloudvault.copyLink')} onClick={() => copy(collab.publishUrl(s.token), s.token)}>
              {copied === s.token ? <Check size={12} /> : <Copy size={12} />}
            </button>
            <button className="amxc-ic" title={t('cloudvault.unpublish')}
              onClick={() => void collab.revokePublish(s.token).then(() => { toast(t('cloudvault.unpublished')); refresh() })}>
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
