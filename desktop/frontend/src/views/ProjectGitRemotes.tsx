import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Copy, ExternalLink, Globe, Link2, Loader2, MoreHorizontal, Plus, Upload, Waypoints } from 'lucide-react'
import { OverlayAt } from '@lcl/engine'
import { registerMessages, useI18n } from '../i18n'
import type { GitRemoteInfo } from '../types'

registerMessages({
  'gitRemotes.title': { zh: '远端', en: 'Remotes' },
  'gitRemotes.add': { zh: '添加…', en: 'Add…' },
  'gitRemotes.addFirst': { zh: '添加远端…', en: 'Add remote…' },
  'gitRemotes.empty': { zh: '还没有远端。要推送、拉取，或者在别的电脑上接着做，先加一个。', en: 'No remote yet. Add one to push, pull, or pick up this project on another computer.' },
  'gitRemotes.pushHere': { zh: '推送到这里', en: 'Push target' },
  'gitRemotes.noTarget': { zh: '还没定推送到哪个远端。在下面挑一个「以后推送到这里」。', en: 'No push target yet. Pick one below with Push here from now on.' },
  'gitRemotes.authForsion': { zh: '你的 Forsion 账号', en: 'Your Forsion account' },
  'gitRemotes.authGithub': { zh: '用绑定的 @{login}', en: 'Uses linked @{login}' },
  'gitRemotes.authGithubUnlinked': { zh: '没绑定 GitHub · 用这台电脑自己的凭据', en: 'No GitHub account linked · Uses this computer’s own credentials' },
  'gitRemotes.authLocal': { zh: '用这台电脑自己的凭据', en: 'Uses this computer’s own credentials' },
  'gitRemotes.other': { zh: '其他', en: 'Other' },
  'gitRemotes.local': { zh: '本机文件夹', en: 'Folder on this computer' },
  'gitRemotes.menu': { zh: '远端操作', en: 'Remote actions' },
  'gitRemotes.setTarget': { zh: '以后推送到这里', en: 'Push here from now on' },
  'gitRemotes.pushOnce': { zh: '只推送这一次', en: 'Push here once' },
  'gitRemotes.open': { zh: '在 {site} 打开', en: 'Open in {site}' },
  'gitRemotes.openPage': { zh: '打开仓库网页', en: 'Open repository page' },
  'gitRemotes.copy': { zh: '复制地址', en: 'Copy address' },
})

export const siteName = (r: GitRemoteInfo, t: (k: string) => string): string =>
  r.host === 'forsion' ? 'Forsion Git' : r.host === 'github' ? 'GitHub' : r.hostname ?? t('gitRemotes.local')

/** GitHub 的标(lucide 1.x 去掉了品牌图标;照它旧版的线稿,和别的线性图标一个分量)。 */
function GithubMark({ size = 14 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
    <path d="M9 18c-4.51 2-5-2-7-2" />
  </svg>
}

export function RemoteHostIcon({ host }: { host: GitRemoteInfo['host'] | 'url' }) {
  return <span className="project-git-host" aria-hidden="true">{host === 'forsion' ? 'F' : host === 'github' ? <GithubMark /> : host === 'url' ? <Link2 size={13} /> : <Globe size={13} />}</span>
}

/**
 * 项目详情「Git」页的「远端」卡片(2026-10-14 用户批的方案 ①②③):全部远端、每个是哪个站 / 哪个仓库 / 推拉带谁的凭据,
 * 标出「推送到这里」(引擎算的 pushRemote:当前分支的上游 → origin → 唯一那个)。只有一个远端时行尾直接给「打开」;
 * 几个远端时行尾是菜单(以后推送到这里 / 只推送这一次 / 打开 / 复制地址)。没有远端时一颗「添加远端…」(去向在对话框里选)。
 * 动作本身由 ProjectProfile 的 gitRun 做(错误、信任重试、通知同一套),这里只出入口。
 */
export function ProjectGitRemotes({ remotes, pushRemote, githubLogin, busy, readOnly, detached, onAdd, onSetTarget, onPushOnce, onOpen, onCopy }: {
  remotes: GitRemoteInfo[]
  pushRemote: string | null
  /** 绑定的 GitHub 登录名;undefined = 不知道(还没问到 / 云端没开),null = 没绑。 */
  githubLogin: string | null | undefined
  busy: string
  readOnly: boolean
  detached: boolean
  /** 没有这个入口(老引擎 / 只读)→ undefined。 */
  onAdd?: () => void
  onSetTarget: (name: string) => void
  onPushOnce: (name: string) => void
  onOpen: (url: string) => void
  onCopy: (text: string) => void
}) {
  const { t } = useI18n()
  const [menu, setMenu] = useState<{ name: string; x: number; y: number } | null>(null)
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    window.addEventListener('blur', close)
    return () => { window.removeEventListener('click', close); window.removeEventListener('contextmenu', close); window.removeEventListener('blur', close) }
  }, [menu])
  const authText = (r: GitRemoteInfo): string =>
    r.auth === 'forsion' ? t('gitRemotes.authForsion')
      : r.auth === 'github' ? (githubLogin ? t('gitRemotes.authGithub', { login: githubLogin }) : githubLogin === null ? t('gitRemotes.authGithubUnlinked') : t('gitRemotes.authLocal'))
        : t('gitRemotes.authLocal')
  const single = remotes.length === 1
  const open = remotes.find((r) => r.name === menu?.name)

  return <section className="project-card" data-project-git-remotes={remotes.length}>
    <div className="project-card-head">
      <div><h3>{t('gitRemotes.title')}</h3></div>
      {!!remotes.length && onAdd && <button type="button" className="project-git-remotes-add" data-git-action="add-remote" disabled={!!busy} onClick={onAdd}><Plus size={12} />{t('gitRemotes.add')}</button>}
    </div>
    {!remotes.length ? <>
      <p className="agent-profile-muted project-git-remotes-empty">{t('gitRemotes.empty')}</p>
      {onAdd && <div className="project-card-actions"><button className="btn sm" data-git-action="add-remote" disabled={!!busy} onClick={onAdd}>{busy === 'git-add-remote' ? <Loader2 size={13} className="spin" /> : <Plus size={13} />}{t('gitRemotes.addFirst')}</button></div>}
    </> : <>
      {remotes.length > 1 && !pushRemote && <p className="agent-profile-muted project-git-remotes-empty" data-project-git-no-target>{t('gitRemotes.noTarget')}</p>}
      <div className="project-git-remotes">{remotes.map((r) => {
        const isTarget = r.name === pushRemote
        return <div key={r.name} className="project-git-remote" data-git-remote={r.name} data-git-remote-host={r.host} data-git-remote-target={isTarget ? '' : undefined}>
          <RemoteHostIcon host={r.host} />
          <div className="project-git-remote-text">
            <strong title={r.url}>{r.path || r.url}</strong>
            <small>{`${siteName(r, t)} · ${authText(r)}`}</small>
            <small className="project-git-remote-name"><span>{r.name}</span>{isTarget && <span className="project-git-remote-target">{t('gitRemotes.pushHere')}</span>}</small>
          </div>
          {single
            ? r.web && <button type="button" className="project-git-remote-btn" data-git-remote-open title={t('gitRemotes.openPage')} aria-label={t('gitRemotes.openPage')} onClick={() => onOpen(r.web!)}><ExternalLink size={13} /></button>
            : <button type="button" className="project-git-remote-btn" data-git-remote-menu={r.name} title={t('gitRemotes.menu')} aria-label={t('gitRemotes.menu')} aria-haspopup="menu" aria-expanded={menu?.name === r.name}
              onClick={(e) => { e.stopPropagation(); const box = e.currentTarget.getBoundingClientRect(); setMenu(menu?.name === r.name ? null : { name: r.name, x: box.right - 188, y: box.bottom + 4 }) }}><MoreHorizontal size={14} /></button>}
        </div>
      })}</div>
    </>}
    {menu && open && createPortal(
      <OverlayAt className="ctx-menu project-git-remote-menu" x={menu.x} y={menu.y} onClick={(e) => e.stopPropagation()}>
        {!readOnly && open.name !== pushRemote && <button type="button" data-act="set-target" disabled={!!busy || detached} onClick={() => { setMenu(null); onSetTarget(open.name) }}><Waypoints size={13} />{t('gitRemotes.setTarget')}</button>}
        {!readOnly && <button type="button" data-act="push-once" disabled={!!busy || detached} onClick={() => { setMenu(null); onPushOnce(open.name) }}><Upload size={13} />{t('gitRemotes.pushOnce')}</button>}
        {open.web && <button type="button" data-act="open" onClick={() => { setMenu(null); onOpen(open.web!) }}><ExternalLink size={13} />{open.host === 'other' ? t('gitRemotes.openPage') : t('gitRemotes.open', { site: siteName(open, t) })}</button>}
        <button type="button" data-act="copy" onClick={() => { setMenu(null); onCopy(open.url) }}><Copy size={13} />{t('gitRemotes.copy')}</button>
      </OverlayAt>,
      document.body,
    )}
  </section>
}
