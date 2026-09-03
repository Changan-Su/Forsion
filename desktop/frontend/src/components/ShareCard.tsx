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
import { OverlayAt } from '@lcl/engine'
import { publishStateFor, type PublishState } from '../amadeus/lib/shareState'
import { registerMessages, translate, useI18n } from '../i18n'
import type { AmadeusPageShare, AmadeusCollabQuota } from '../types'

registerMessages({
  'share.unlimited': { zh: '无限制', en: 'unlimited' },
  'share.tabShare': { zh: '共享', en: 'Share' },
  'share.tabPublish': { zh: '发布', en: 'Publish' },
  'share.ownerOnly': { zh: '只有库所有者可以管理共享与发布。', en: 'Only the vault owner can manage sharing and publishing.' },
  'share.intro': { zh: '邀请他人参与这一页(含子页面)。对方需登录 Forsion 账号并同意邀请;权限可为只读或可编辑,默认开放 7 天。', en: 'Invite others to this page and its subpages. They need to sign in to a Forsion account and accept the invite; access can be read-only or editable, and stays open for 7 days by default.' },
  'share.enable': { zh: '开启同步共享', en: 'Turn on live sharing' },
  'share.enabled': { zh: '已开启共享', en: 'Sharing is on' },
  'share.planNoCollab': { zh: '当前套餐不支持同步共享,升级 Plus/Pro 解锁。', en: 'Your plan does not include live sharing — upgrade to Plus or Pro to unlock it.' },
  'share.quotaCollab': { zh: '套餐可共享 {n} 页。', en: 'Your plan can share {n} pages.' },
  'share.copyInvite': { zh: '复制邀请链接', en: 'Copy invite link' },
  'share.rotate': { zh: '更换链接(旧链接失效)', en: 'Replace link (the old one stops working)' },
  'share.rotated': { zh: '已更换邀请链接', en: 'Invite link replaced' },
  'share.linkRole': { zh: '链接权限', en: 'Link access' },
  'share.roleEditor': { zh: '可编辑', en: 'Can edit' },
  'share.roleViewer': { zh: '只读', en: 'Read-only' },
  'share.openFor': { zh: '开放时间', en: 'Open for' },
  'share.days7': { zh: '7 天', en: '7 days' },
  'share.days30': { zh: '30 天', en: '30 days' },
  'share.forever': { zh: '永久', en: 'Forever' },
  'share.password': { zh: '查看密码', en: 'Password' },
  'share.passwordSet': { zh: '已设置', en: 'Set' },
  'share.clearPassword': { zh: '清除密码', en: 'Clear password' },
  'share.passwordCleared': { zh: '已清除密码', en: 'Password cleared' },
  'share.passwordOptional': { zh: '可选', en: 'Optional' },
  'share.setPassword': { zh: '设置', en: 'Set password' },
  'share.passwordSaved': { zh: '已设置密码', en: 'Password set' },
  'share.participants': { zh: '参与者 · {n}', en: 'Participants · {n}' },
  'share.noParticipants': { zh: '还没有人加入。把邀请链接发给对方,登录并同意后出现在这里。', en: 'Nobody has joined yet. Send someone the invite link — they appear here once they sign in and accept.' },
  'share.removeParticipant': { zh: '移除', en: 'Remove' },
  'share.removed': { zh: '已移除', en: 'Removed' },
  'share.stop': { zh: '停止共享', en: 'Stop sharing' },
  'share.stopped': { zh: '已停止共享,参与者立即失去访问', en: 'Sharing stopped — participants lost access immediately' },
  'share.copyLink': { zh: '复制链接', en: 'Copy link' },
  'share.copyPageLink': { zh: '复制本页链接', en: 'Copy link to this page' },
  'share.unpublish': { zh: '取消发布', en: 'Unpublish' },
  'share.unpublished': { zh: '已取消发布,链接立即失效', en: 'Unpublished — the link stopped working immediately' },
  'share.viewPage': { zh: '查看页面', en: 'View page' },
  'share.viaFolder': { zh: '文件夹', en: 'folder' },
  'share.viaPage': { zh: '页面', en: 'page' },
  'share.inherited': { zh: '本页已通过上级{kind}《{name}》整体发布 —— 拿到链接的人都能只读查看本页,无需单独发布。', en: 'This page is already published as part of the parent {kind} "{name}" — anyone with that link can view it read-only, so nothing needs publishing here.' },
  'share.inheritedStop': { zh: '要停止公开,请到该{kind}取消发布。', en: 'To make it private again, unpublish that {kind}.' },
  'share.publishIntro': { zh: '发布后,任何拿到链接的人**无需账号**即可只读查看这一页(含子页面)。', en: 'Once published, anyone with the link can read this page and its subpages with **no account needed**.' },
  'share.publish': { zh: '发布到公开链接', en: 'Publish to a public link' },
  'share.published': { zh: '已发布,链接已生成', en: 'Published — link ready' },
  'share.publishCount': { zh: '已发布 {used} / {total} 页。', en: 'Published {used} / {total} pages.' },
  'share.quotaReached': { zh: '已达套餐上限', en: 'Plan limit reached' },
  'share.opFailed': { zh: '操作失败', en: 'Something went wrong' },
  'share.syncOff': { zh: '关闭云同步(云端副本保留)', en: 'Turn off cloud sync (the cloud copy is kept)' },
  'share.syncOn': { zh: '开启云同步(同步到云端工作区)', en: 'Turn on cloud sync (sync to the cloud workspace)' },
})

const fmtQuota = (n: number): string => (Number.isFinite(n) ? String(n) : translate('share.unlimited'))
const baseName = (p: string): string => (p.split('/').pop() ?? p).replace(/\.md$/i, '')

export function ShareCard({ path, anchor, onClose }: { path: string; anchor: { x: number; y: number }; onClose: () => void }): React.ReactElement | null {
  const collab = window.amadeusCollab
  const { t } = useI18n()
  const toast = (msg: string, err = false): void => useApp.getState().toast(msg, err)
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
    toast(anyE?.code === 'QUOTA' ? (anyE.message || t('share.quotaReached')) : fallback, true)
  }
  const run = (p: Promise<unknown>, ok?: string, fallback = t('share.opFailed')): void => {
    setBusy(true)
    void p.then(() => { if (ok) toast(ok); refresh() }).catch((e) => err(e, fallback)).finally(() => setBusy(false))
  }

  return (
    <div className="amxc-cardwrap" onClick={onClose}>
      <OverlayAt className="amxc-card" x={anchor.x - 340} y={anchor.y + 6} onClick={(e) => e.stopPropagation()}>
        <div className="amxc-tabs">
          <button className={tab === 'share' ? 'on' : ''} onClick={() => setTab('share')}>{t('share.tabShare')}</button>
          <button className={tab === 'publish' ? 'on' : ''} onClick={() => setTab('publish')}>{t('share.tabPublish')}</button>
          <span className="amxc-flex" />
          <button className="amxc-x" onClick={onClose}><X size={14} /></button>
        </div>

        {notOwner ? (
          <div className="amxc-hint" style={{ padding: '18px 8px' }}>{t('share.ownerOnly')}</div>
        ) : tab === 'share' ? (
          !share ? (
            <div className="amxc-body">
              <div className="amxc-hint">{t('share.intro')}</div>
              <button className="amxc-primary" disabled={busy || (quota ? quota.collab <= 0 : false)}
                onClick={() => run(collab.createPageShare(path, { role: 'editor', expiresDays: 7 }), t('share.enabled'))}>
                <Link2 size={13} /> {t('share.enable')}
              </button>
              {quota && (quota.collab <= 0
                ? <div className="amxc-hint">{t('share.planNoCollab')}</div>
                : <div className="amxc-hint">{t('share.quotaCollab', { n: fmtQuota(quota.collab) })}</div>)}
            </div>
          ) : (
            <div className="amxc-body">
              <div className="amxc-frow">
                <input className="amxc-input" readOnly value={collab.inviteUrl(share.inviteToken)} />
                <button className="amxc-ic" title={t('share.copyInvite')} onClick={() => copy(collab.inviteUrl(share.inviteToken), 'inv')}>
                  {copied === 'inv' ? <Check size={13} /> : <Copy size={13} />}
                </button>
                <button className="amxc-ic" title={t('share.rotate')} onClick={() => run(collab.updatePageShare(share.id, { rotate: true }), t('share.rotated'))}>
                  <RotateCw size={13} />
                </button>
              </div>
              <div className="amxc-frow">
                <span className="amxc-lbl">{t('share.linkRole')}</span>
                <select value={share.inviteRole} onChange={(e) => run(collab.updatePageShare(share.id, { role: e.target.value as 'editor' | 'viewer' }))}>
                  <option value="editor">{t('share.roleEditor')}</option>
                  <option value="viewer">{t('share.roleViewer')}</option>
                </select>
                <span className="amxc-lbl">{t('share.openFor')}</span>
                <select
                  value={share.expiresAt === null ? 'forever' : '7'}
                  onChange={(e) => run(collab.updatePageShare(share.id, { expiresDays: e.target.value === 'forever' ? null : Number(e.target.value) }))}
                >
                  <option value="7">{t('share.days7')}</option>
                  <option value="30">{t('share.days30')}</option>
                  <option value="forever">{t('share.forever')}</option>
                </select>
              </div>
              <div className="amxc-frow">
                <span className="amxc-lbl">{t('share.password')}</span>
                {share.hasPassword ? (
                  <>
                    <span className="amxc-tag">{t('share.passwordSet')}</span>
                    <button className="amxc-ic" title={t('share.clearPassword')} onClick={() => run(collab.updatePageShare(share.id, { password: null }), t('share.passwordCleared'))}><Trash2 size={12} /></button>
                  </>
                ) : (
                  <>
                    <input className="amxc-input" placeholder={t('share.passwordOptional')} value={pwDraft} onChange={(e) => setPwDraft(e.target.value)} />
                    <button className="amxc-ic" title={t('share.setPassword')} disabled={!pwDraft.trim()}
                      onClick={() => { const pw = pwDraft.trim(); setPwDraft(''); run(collab.updatePageShare(share.id, { password: pw }), t('share.passwordSaved')) }}>
                      <Check size={13} />
                    </button>
                  </>
                )}
              </div>
              <div className="amxc-sec">{t('share.participants', { n: share.participants.length })}</div>
              {share.participants.length === 0 && <div className="amxc-hint">{t('share.noParticipants')}</div>}
              {share.participants.map((m) => (
                <div key={m.userId} className="amxc-row static">
                  <span className="amxc-row-name">{m.username ?? m.userId.slice(0, 8)}</span>
                  <select value={m.role} onChange={(e) => run(collab.setParticipantRole(share.id, m.userId, e.target.value as 'editor' | 'viewer'))}>
                    <option value="editor">{t('share.roleEditor')}</option>
                    <option value="viewer">{t('share.roleViewer')}</option>
                  </select>
                  <button className="amxc-ic" title={t('share.removeParticipant')} onClick={() => run(collab.removeParticipant(share.id, m.userId), t('share.removed'))}><Trash2 size={12} /></button>
                </div>
              ))}
              <button className="amxc-danger" disabled={busy} onClick={() => run(collab.revokePageShare(share.id), t('share.stopped'))}>
                {t('share.stop')}
              </button>
            </div>
          )
        ) : (
          <div className="amxc-body">
            {pub ? (
              <>
                <div className="amxc-frow">
                  <input className="amxc-input" readOnly value={pub.url} />
                  <button className="amxc-ic" title={t('share.copyLink')} onClick={() => copy(pub.url, 'pub')}>{copied === 'pub' ? <Check size={13} /> : <Copy size={13} />}</button>
                </div>
                <div className="amxc-frow">
                  <button className="amxc-danger" disabled={busy} onClick={() => run(collab.revokePublish(pub.token), t('share.unpublished'))}>{t('share.unpublish')}</button>
                  <a className="amxc-view" href={pub.url} target="_blank" rel="noreferrer">{t('share.viewPage')}</a>
                </div>
              </>
            ) : pubState.kind === 'inherited' ? (
              <>
                <div className="amxc-hint">
                  {t('share.inherited', {
                    kind: pubState.viaMode === 'subtree' ? t('share.viaFolder') : t('share.viaPage'),
                    name: baseName(pubState.via),
                  })}
                </div>
                <div className="amxc-frow">
                  <input className="amxc-input" readOnly value={`${collab.publishUrl(pubState.token)}#${encodeURIComponent(path)}`} />
                  <button className="amxc-ic" title={t('share.copyPageLink')} onClick={() => copy(`${collab.publishUrl(pubState.token)}#${encodeURIComponent(path)}`, 'pub')}>
                    {copied === 'pub' ? <Check size={13} /> : <Copy size={13} />}
                  </button>
                </div>
                <div className="amxc-hint">{t('share.inheritedStop', { kind: pubState.viaMode === 'subtree' ? t('share.viaFolder') : t('share.viaPage') })}</div>
              </>
            ) : (
              <>
                <div className="amxc-hint">{t('share.publishIntro')}</div>
                <button className="amxc-primary" disabled={busy} onClick={() => run(collab.createPublish('page', path), t('share.published'))}>
                  <Globe2 size={13} /> {t('share.publish')}
                </button>
              </>
            )}
            {quota && <div className="amxc-hint">{t('share.publishCount', { used: pubCount, total: fmtQuota(quota.publish) })}</div>}
          </div>
        )}
        <CloudSyncRow path={path} onClose={onClose} />
      </OverlayAt>
    </div>
  )
}

/** 卡片底部的按条目云同步入口(仅桌面本地侧;与右键菜单同一 dialog 流)。 */
function CloudSyncRow({ path, onClose }: { path: string; onClose: () => void }) {
  const vaultRoot = usePageStore((s) => s.vaultRoot)
  const vaultSide = usePageStore((s) => s.vaultSide)
  useEntrySync((s) => s.vaults) // 订阅注册表变化以刷新 synced 态
  const { t } = useI18n()
  if (!window.amadeusSync?.entrySyncEnable || vaultSide !== 'local') return null
  const synced = isSyncedEntry(vaultRoot, path)
  return (
    <div className="amxc-body" style={{ borderTop: '1px solid var(--border, rgba(128,128,128,.25))', marginTop: 4, paddingTop: 8 }}>
      {synced ? (
        <button className="amxc-primary" onClick={() => { void window.amadeusSync!.entrySyncDisable!(path) }}>
          <CloudOff size={13} /> {t('share.syncOff')}
        </button>
      ) : (
        <button className="amxc-primary" onClick={() => { onClose(); openCloudSyncDialog(path, 'page') }}>
          <Cloud size={13} /> {t('share.syncOn')}
        </button>
      )}
    </div>
  )
}
