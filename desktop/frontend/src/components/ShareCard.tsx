/**
 * 分享卡片(Notion 式 Share|Publish 双 tab;web/桌面经 window.amadeusCollab 解闸):
 * - 共享:邀请链接(可设查看密码/有效期默认 7 天/链接角色)+ 参与者列表(改角色/移除);须登录+同意邀请。
 * - 发布:公开只读链接,任何人可访问,Unpublish 即失效。
 * 配额随套餐(服务端强制;此处仅展示与报错透传):free 共享不可用/发布3;plus 2/10;pro 10/∞。
 */
import React, { useEffect, useState } from 'react'
import { X, Copy, Check, Link2, Globe2, Trash2, RotateCw, Cloud, CloudOff } from 'lucide-react'
import { useApp } from '../stores/appStore'
import { usePageStore } from '@amadeus/store/pageStore'
import { useEntrySync, isSyncedEntry } from '../stores/entrySyncStore'
import { openCloudSyncDialog } from './CloudSyncDialog'
import { publishStateFor, type PublishState } from '../amadeus/lib/shareState'
import type { AmadeusPageShare, AmadeusCollabQuota } from '../types'

const fmtQuota = (n: number): string => (Number.isFinite(n) ? String(n) : '无限制')
const baseName = (p: string): string => (p.split('/').pop() ?? p).replace(/\.md$/i, '')

export function ShareCard({ path, anchor, onClose }: { path: string; anchor: { x: number; y: number }; onClose: () => void }): React.ReactElement | null {
  const collab = window.amadeusCollab
  const toast = (t: string, err = false): void => useApp.getState().toast(t, err)
  const [tab, setTab] = useState<'share' | 'publish'>('share')
  const [share, setShare] = useState<AmadeusPageShare | null>(null)
  const [quota, setQuota] = useState<AmadeusCollabQuota | null>(null)
  const [pub, setPub] = useState<{ token: string; url: string } | null>(null)
  const [pubState, setPubState] = useState<PublishState>({ kind: 'none' }) // 含「被上级文件夹发布覆盖」
  const [pubCount, setPubCount] = useState(0)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [pwDraft, setPwDraft] = useState('')
  const [notOwner, setNotOwner] = useState(false)

  const refresh = (): void => {
    if (!collab) return
    void collab.pageShare(path)
      .then((r) => { setShare(r.share); setQuota(r.quota); setNotOwner(false) })
      .catch((e) => { if ((e as any)?.status === 404) setNotOwner(true) })
    void collab.publishes()
      .then((r) => {
        setQuota(r.quota)
        setPubCount(r.shares.length)
        const hit = r.shares.find((s) => s.path === path && s.mode === 'page')
        setPub(hit ? { token: hit.token, url: collab.publishUrl(hit.token) } : null)
        setPubState(publishStateFor(path, r.shares))
      })
      .catch(() => {})
  }
  useEffect(refresh, [path]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!collab) return null

  const copy = (text: string, key: string): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(key)
      setTimeout(() => setCopied(null), 1200)
    })
  }
  const err = (e: unknown, fallback: string): void => {
    const anyE = e as { code?: string; message?: string }
    toast(anyE?.code === 'QUOTA' ? (anyE.message || '已达套餐上限') : fallback, true)
  }
  const run = (p: Promise<unknown>, ok?: string, fallback = '操作失败'): void => {
    setBusy(true)
    void p.then(() => { if (ok) toast(ok); refresh() }).catch((e) => err(e, fallback)).finally(() => setBusy(false))
  }

  const left = Math.max(8, Math.min(anchor.x - 340, window.innerWidth - 372))
  const top = Math.min(anchor.y + 6, window.innerHeight - 420)

  return (
    <div className="amxc-cardwrap" onClick={onClose}>
      <div className="amxc-card" style={{ left, top }} onClick={(e) => e.stopPropagation()}>
        <div className="amxc-tabs">
          <button className={tab === 'share' ? 'on' : ''} onClick={() => setTab('share')}>共享</button>
          <button className={tab === 'publish' ? 'on' : ''} onClick={() => setTab('publish')}>发布</button>
          <span className="amxc-flex" />
          <button className="amxc-x" onClick={onClose}><X size={14} /></button>
        </div>

        {notOwner ? (
          <div className="amxc-hint" style={{ padding: '18px 8px' }}>只有库所有者可以管理共享与发布。</div>
        ) : tab === 'share' ? (
          !share ? (
            <div className="amxc-body">
              <div className="amxc-hint">邀请他人参与这一页(含子页面)。对方需登录 Forsion 账号并同意邀请;权限可为只读或可编辑,默认开放 7 天。</div>
              <button className="amxc-primary" disabled={busy || (quota ? quota.collab <= 0 : false)}
                onClick={() => run(collab.createPageShare(path, { role: 'editor', expiresDays: 7 }), '已开启共享')}>
                <Link2 size={13} /> 开启同步共享
              </button>
              {quota && (quota.collab <= 0
                ? <div className="amxc-hint">当前套餐不支持同步共享,升级 Plus/Pro 解锁。</div>
                : <div className="amxc-hint">套餐可共享 {fmtQuota(quota.collab)} 页。</div>)}
            </div>
          ) : (
            <div className="amxc-body">
              <div className="amxc-frow">
                <input className="amxc-input" readOnly value={collab.inviteUrl(share.inviteToken)} />
                <button className="amxc-ic" title="复制邀请链接" onClick={() => copy(collab.inviteUrl(share.inviteToken), 'inv')}>
                  {copied === 'inv' ? <Check size={13} /> : <Copy size={13} />}
                </button>
                <button className="amxc-ic" title="更换链接(旧链接失效)" onClick={() => run(collab.updatePageShare(share.id, { rotate: true }), '已更换邀请链接')}>
                  <RotateCw size={13} />
                </button>
              </div>
              <div className="amxc-frow">
                <span className="amxc-lbl">链接权限</span>
                <select value={share.inviteRole} onChange={(e) => run(collab.updatePageShare(share.id, { role: e.target.value as 'editor' | 'viewer' }))}>
                  <option value="editor">可编辑</option>
                  <option value="viewer">只读</option>
                </select>
                <span className="amxc-lbl">开放时间</span>
                <select
                  value={share.expiresAt === null ? 'forever' : '7'}
                  onChange={(e) => run(collab.updatePageShare(share.id, { expiresDays: e.target.value === 'forever' ? null : Number(e.target.value) }))}
                >
                  <option value="7">7 天</option>
                  <option value="30">30 天</option>
                  <option value="forever">永久</option>
                </select>
              </div>
              <div className="amxc-frow">
                <span className="amxc-lbl">查看密码</span>
                {share.hasPassword ? (
                  <>
                    <span className="amxc-tag">已设置</span>
                    <button className="amxc-ic" title="清除密码" onClick={() => run(collab.updatePageShare(share.id, { password: null }), '已清除密码')}><Trash2 size={12} /></button>
                  </>
                ) : (
                  <>
                    <input className="amxc-input" placeholder="可选" value={pwDraft} onChange={(e) => setPwDraft(e.target.value)} />
                    <button className="amxc-ic" title="设置" disabled={!pwDraft.trim()}
                      onClick={() => { const pw = pwDraft.trim(); setPwDraft(''); run(collab.updatePageShare(share.id, { password: pw }), '已设置密码') }}>
                      <Check size={13} />
                    </button>
                  </>
                )}
              </div>
              <div className="amxc-sec">参与者 · {share.participants.length}</div>
              {share.participants.length === 0 && <div className="amxc-hint">还没有人加入。把邀请链接发给对方,登录并同意后出现在这里。</div>}
              {share.participants.map((m) => (
                <div key={m.userId} className="amxc-row static">
                  <span className="amxc-row-name">{m.username ?? m.userId.slice(0, 8)}</span>
                  <select value={m.role} onChange={(e) => run(collab.setParticipantRole(share.id, m.userId, e.target.value as 'editor' | 'viewer'))}>
                    <option value="editor">可编辑</option>
                    <option value="viewer">只读</option>
                  </select>
                  <button className="amxc-ic" title="移除" onClick={() => run(collab.removeParticipant(share.id, m.userId), '已移除')}><Trash2 size={12} /></button>
                </div>
              ))}
              <button className="amxc-danger" disabled={busy} onClick={() => run(collab.revokePageShare(share.id), '已停止共享,参与者立即失去访问')}>
                停止共享
              </button>
            </div>
          )
        ) : (
          <div className="amxc-body">
            {pub ? (
              <>
                <div className="amxc-frow">
                  <input className="amxc-input" readOnly value={pub.url} />
                  <button className="amxc-ic" title="复制链接" onClick={() => copy(pub.url, 'pub')}>{copied === 'pub' ? <Check size={13} /> : <Copy size={13} />}</button>
                </div>
                <div className="amxc-frow">
                  <button className="amxc-danger" disabled={busy} onClick={() => run(collab.revokePublish(pub.token), '已取消发布,链接立即失效')}>取消发布</button>
                  <a className="amxc-view" href={pub.url} target="_blank" rel="noreferrer">查看页面</a>
                </div>
              </>
            ) : pubState.kind === 'inherited' ? (
              <>
                <div className="amxc-hint">
                  本页已通过上级{pubState.viaMode === 'subtree' ? '文件夹' : '页面'}《{baseName(pubState.via)}》整体发布 —— 拿到链接的人都能只读查看本页,无需单独发布。
                </div>
                <div className="amxc-frow">
                  <input className="amxc-input" readOnly value={`${collab.publishUrl(pubState.token)}#${encodeURIComponent(path)}`} />
                  <button className="amxc-ic" title="复制本页链接" onClick={() => copy(`${collab.publishUrl(pubState.token)}#${encodeURIComponent(path)}`, 'pub')}>
                    {copied === 'pub' ? <Check size={13} /> : <Copy size={13} />}
                  </button>
                </div>
                <div className="amxc-hint">要停止公开,请到该{pubState.viaMode === 'subtree' ? '文件夹' : '页面'}取消发布。</div>
              </>
            ) : (
              <>
                <div className="amxc-hint">发布后,任何拿到链接的人**无需账号**即可只读查看这一页(含子页面)。</div>
                <button className="amxc-primary" disabled={busy} onClick={() => run(collab.createPublish('page', path), '已发布,链接已生成')}>
                  <Globe2 size={13} /> 发布到公开链接
                </button>
              </>
            )}
            {quota && <div className="amxc-hint">已发布 {pubCount} / {fmtQuota(quota.publish)} 页。</div>}
          </div>
        )}
        <CloudSyncRow path={path} onClose={onClose} />
      </div>
    </div>
  )
}

/** 卡片底部的按条目云同步入口(仅桌面本地侧;与右键菜单同一 dialog 流)。 */
function CloudSyncRow({ path, onClose }: { path: string; onClose: () => void }) {
  const vaultRoot = usePageStore((s) => s.vaultRoot)
  const vaultSide = usePageStore((s) => s.vaultSide)
  useEntrySync((s) => s.vaults) // 订阅注册表变化以刷新 synced 态
  if (!window.amadeusSync?.entrySyncEnable || vaultSide !== 'local') return null
  const synced = isSyncedEntry(vaultRoot, path)
  return (
    <div className="amxc-body" style={{ borderTop: '1px solid var(--border, rgba(128,128,128,.25))', marginTop: 4, paddingTop: 8 }}>
      {synced ? (
        <button className="amxc-primary" onClick={() => { void window.amadeusSync!.entrySyncDisable!(path) }}>
          <CloudOff size={13} /> 关闭云同步(云端副本保留)
        </button>
      ) : (
        <button className="amxc-primary" onClick={() => { onClose(); openCloudSyncDialog(path, 'page') }}>
          <Cloud size={13} /> 开启云同步(同步到云端工作区)
        </button>
      )}
    </div>
  )
}
