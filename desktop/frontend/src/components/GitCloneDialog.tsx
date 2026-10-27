import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { GitBranch, Loader2, Lock } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import { gitCloneRepo, listGitRepos, type GitRemoteRepo } from '../services/backendService'
import { homeTarget } from '../services/engine/targets'
import { useEscape } from '../amadeus/components/Dialogs'
import { formatRelative } from '../format/time'
import { DialogOverlay } from '../amadeus/components/DialogOverlay'
import './gitCloneDialog.css'

registerMessages({
  'gitClone.title': { zh: '从 Git 克隆', en: 'Clone from Git' },
  'gitClone.subtitle': { zh: '把仓库克隆到这台电脑上，并加成一个项目。', en: 'Clones the repository to this computer and adds it as a project.' },
  'gitClone.tabUrl': { zh: '网址', en: 'URL' },
  'gitClone.urlPlaceholder': { zh: '仓库地址，以 https:// 或 git@ 开头', en: 'Repository address, starting with https:// or git@' },
  'gitClone.loading': { zh: '正在读取仓库列表…', en: 'Loading repositories…' },
  'gitClone.empty': { zh: '这个账号下还没有仓库。', en: 'This account has no repositories yet.' },
  'gitClone.noHost': { zh: '这里用不了。登录 Forsion 后再试，或者用「网址」。', en: 'Not available here. Sign in to Forsion and try again, or use URL.' },
  'gitClone.githubUnlinked': { zh: '还没绑定 GitHub 账号。绑定后这里会列出你的仓库。', en: 'No GitHub account is linked yet. Link one to list your repositories here.' },
  'gitClone.link': { zh: '去绑定', en: 'Link GitHub' },
  'gitClone.listFailed': { zh: '没能读到仓库列表。可以用「网址」直接贴地址。', en: 'Could not load the repository list. You can paste an address under URL instead.' },
  'gitClone.private': { zh: '私有', en: 'Private' },
  'gitClone.public': { zh: '公开', en: 'Public' },
  'gitClone.folderName': { zh: '文件夹名', en: 'Folder name' },
  'gitClone.into': { zh: '放在', en: 'Location' },
  'gitClone.choose': { zh: '选择文件夹…', en: 'Choose folder…' },
  'gitClone.change': { zh: '更改…', en: 'Change…' },
  'gitClone.confirm': { zh: '克隆', en: 'Clone' },
  'gitClone.cloning': { zh: '正在克隆…', en: 'Cloning…' },
  'gitClone.cloningHint': { zh: '大的仓库要等一会儿，别关掉这个窗口。', en: 'Large repositories take a while. Keep this window open.' },
  'gitClone.err.invalid_remote_url': { zh: '这个地址用不了。仓库地址要以 https:// 或 git@ 开头，而且不能把密码写在地址里。', en: 'That address cannot be used. A repository address must start with https:// or git@ and must not contain a password.' },
  'gitClone.err.invalid_folder_name': { zh: '文件夹名不能用。不要带斜杠或冒号，也不要以 - 开头。', en: 'That folder name cannot be used. Leave out slashes and colons, and do not start it with a hyphen.' },
  'gitClone.err.invalid_folder': { zh: '要放进去的文件夹不存在，重新选一个。', en: 'The folder to clone into does not exist. Choose another one.' },
  'gitClone.err.target_exists': { zh: '这个文件夹里已经有同名的东西了。换个文件夹名，或者换个位置。', en: 'There is already something with that name in this folder. Use another folder name or another location.' },
  'gitClone.err.remote_unreachable': { zh: '没能克隆：地址不对、没有权限，或者网络不通。', en: 'Could not clone: the address is wrong, you have no access, or the network is down.' },
  'gitClone.err.git_timeout': { zh: '克隆超时了。仓库很大时，可以在终端里克隆，再用「添加项目」把文件夹加进来。', en: 'Cloning timed out. For a very large repository, clone it in a terminal, then add the folder as a project.' },
  'gitClone.err.git_unavailable': { zh: '这台电脑上没有可用的 git。', en: 'git is not available on this computer.' },
  'gitClone.err.github_not_linked': { zh: 'GitHub 没有接受这次请求：这台电脑上没有可用的 GitHub 凭据，你的 Forsion 账号也还没有绑定 GitHub 账号。', en: 'GitHub refused this request: this computer has no working GitHub credentials, and your Forsion account has no GitHub account linked.' },
  'gitClone.err.github_relink_required': { zh: '绑定的 GitHub 账号已经失效。在账户中心的「账号安全」里重新绑定后再试。', en: 'The linked GitHub account no longer works. Link it again under Security in the account centre, then try again.' },
  'gitClone.err.github_unavailable': { zh: '暂时领不到绑定的 GitHub 账号的凭据。确认已登录 Forsion 并且网络正常，稍后再试。', en: 'Credentials for the linked GitHub account are unavailable right now. Check that you are signed in to Forsion and online, then try again.' },
  'gitClone.err.forsion_git_unavailable': { zh: '暂时领不到 Forsion Git 的凭据。确认已登录 Forsion 并且网络正常，稍后再试。', en: 'Forsion Git credentials are unavailable right now. Check that you are signed in to Forsion and online, then try again.' },
  'gitClone.err.forsion_git_needs_setup': { zh: '你的 Forsion 账号还没有开通 Forsion Git。先在网页上登录一次 Forsion Git，再回来重试。', en: 'Your Forsion account is not set up on Forsion Git yet. Sign in to Forsion Git on the web once, then try again.' },
  'gitClone.err.unsupported': { zh: '当前连接的引擎不支持克隆，更新引擎后再试。', en: 'The connected engine does not support cloning yet. Update it and try again.' },
})

const ERROR_CODES = new Set(['invalid_remote_url', 'invalid_folder_name', 'invalid_folder', 'target_exists', 'remote_unreachable', 'git_timeout', 'git_unavailable', 'github_not_linked', 'github_relink_required', 'github_unavailable', 'forsion_git_unavailable', 'forsion_git_needs_setup'])
type Tab = 'forsion' | 'github' | 'url'
type Listing = { state: 'loading' } | { state: 'ok'; repos: GitRemoteRepo[] } | { state: 'none' } | { state: 'unlinked' } | { state: 'failed' }

/** 仓库地址 → 预填的文件夹名(最后一段,去掉 .git);引擎那边会再校验一遍。 */
export const cloneFolderName = (url: string): string =>
  (url.trim().replace(/[/\\]+$/, '').split(/[/\\:]/).pop() ?? '').replace(/\.git$/i, '').replace(/^-+/, '')

// ── 命令式入口:await askGitClone() → 克隆成功回那个文件夹,取消回 null(调用方随后把它加成项目)──
interface Req { resolve: (v: { path: string; name: string } | null) => void }
const useCloneStore = create<{ req: Req | null }>(() => ({ req: null }))
export function askGitClone(): Promise<{ path: string; name: string } | null> {
  // 已经开着一个(可能正在克隆):不顶掉它 —— 顶掉的话那一次的结果没人接,对话框会一直停在「正在克隆」
  if (useCloneStore.getState().req) return Promise.resolve(null)
  return new Promise((resolve) => { useCloneStore.setState({ req: { resolve } }) })
}

/** 挂载一次(AmadeusOverlays);载体类与 AskStringHost 同款,.dialog-* 的样式和取色才命中。 */
export function GitCloneHost() {
  const req = useCloneStore((s) => s.req)
  if (!req) return null
  const settle = (v: { path: string; name: string } | null): void => {
    if (useCloneStore.getState().req !== req) return
    useCloneStore.setState({ req: null })
    req.resolve(v)
  }
  return <div className="am-app tangu-lovable" style={{ display: 'contents' }}><GitCloneDialog onDone={settle} /></div>
}

function GitCloneDialog({ onDone }: { onDone: (v: { path: string; name: string } | null) => void }) {
  const { t } = useI18n()
  const [tab, setTab] = useState<Tab>('forsion')
  const [lists, setLists] = useState<Partial<Record<'forsion' | 'github', Listing>>>({})
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [nameEdited, setNameEdited] = useState(false)
  const [parent, setParent] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ message: string; info?: string; link?: boolean } | null>(null)
  const linkGithub = window.tangu?.openAccountCenter ? () => { void window.tangu!.openAccountCenter!('security') } : undefined
  // 克隆途中不让 Esc / 点遮罩把对话框关掉:git 还在后台写文件夹,关了就没人告诉用户结果
  const close = () => { if (!busy) onDone(null) }
  useEscape(close)

  const load = (host: 'forsion' | 'github') => {
    setLists((cur) => ({ ...cur, [host]: { state: 'loading' } }))
    void listGitRepos(homeTarget(), host).then(
      (repos) => {
        setLists((cur) => ({ ...cur, [host]: repos ? { state: 'ok', repos } : { state: 'none' } }))
        // 一打开就落在 Forsion Git 那一栏;这里没有它(没登录)时别让人先看到一句「用不了」,直接换到贴地址
        if (!repos && host === 'forsion') setTab((cur) => (cur === 'forsion' ? 'url' : cur))
      },
      (e: any) => setLists((cur) => ({ ...cur, [host]: { state: e?.code === 'github_not_linked' || e?.code === 'github_relink_required' ? 'unlinked' : 'failed' } })),
    )
  }
  useEffect(() => { if (tab !== 'url' && !lists[tab]) load(tab) }, [tab])
  // GitHub 在浏览器里的账户中心绑:窗口回到前台时,还显示「没绑定」的那一栏重读一次
  useEffect(() => {
    const onFocus = () => { if (lists.github?.state === 'unlinked') load('github') }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [lists.github?.state])

  const pickUrl = (next: string) => { setUrl(next); setError(null); if (!nameEdited) setName(cloneFolderName(next)) }
  const pickParent = async () => { const dir = await window.tangu?.pickDirectory?.({ purpose: 'project' }); if (dir) { setParent(dir); setError(null) } }
  const clone = async () => {
    if (busy || !url.trim() || !name.trim() || !parent) return
    setBusy(true); setError(null)
    try {
      onDone(await gitCloneRepo(homeTarget(), url.trim(), parent, name.trim()))
    } catch (e: any) {
      const code = typeof e?.code === 'string' ? e.code : ''
      setError({
        message: ERROR_CODES.has(code) ? t(`gitClone.err.${code}`) : e?.status === 404 ? t('gitClone.err.unsupported') : String(e?.message || e),
        info: typeof e?.info === 'string' && e.info && code === 'remote_unreachable' ? e.info : undefined,
        link: code === 'github_not_linked' || code === 'github_relink_required',
      })
      setBusy(false)
    }
  }
  const listing = tab === 'url' ? null : lists[tab]

  return (
    <DialogOverlay onMouseDown={close}>
      <div className="dialog git-clone-dialog" role="dialog" aria-modal="true" aria-label={t('gitClone.title')} data-git-clone onMouseDown={(e) => e.stopPropagation()}>
        <div>
          <div className="dialog-title">{t('gitClone.title')}</div>
          <div className="dialog-msg">{t('gitClone.subtitle')}</div>
        </div>
        <div className="git-clone-tabs" role="tablist">
          {(['forsion', 'github', 'url'] as const).map((id) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} data-git-clone-tab={id} disabled={busy} onClick={() => setTab(id)}>{id === 'forsion' ? 'Forsion Git' : id === 'github' ? 'GitHub' : t('gitClone.tabUrl')}</button>)}
        </div>
        {tab === 'url'
          ? <input className="dialog-input" autoFocus spellCheck={false} value={url} disabled={busy} placeholder={t('gitClone.urlPlaceholder')} data-git-clone-url onChange={(e) => pickUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void clone() }} />
          : <div className="dialog-list git-clone-list" data-git-clone-list={listing?.state ?? 'loading'}>
            {(!listing || listing.state === 'loading') && <div className="dialog-msg git-clone-note"><Loader2 size={13} className="spin" />{t('gitClone.loading')}</div>}
            {listing?.state === 'none' && <div className="dialog-msg git-clone-note">{t('gitClone.noHost')}</div>}
            {listing?.state === 'failed' && <div className="dialog-msg git-clone-note">{t('gitClone.listFailed')}</div>}
            {listing?.state === 'unlinked' && <div className="dialog-msg git-clone-note">{t('gitClone.githubUnlinked')}{linkGithub && <button type="button" className="dialog-btn" data-git-clone-link onClick={linkGithub}>{t('gitClone.link')}</button>}</div>}
            {listing?.state === 'ok' && !listing.repos.length && <div className="dialog-msg git-clone-note">{t('gitClone.empty')}</div>}
            {listing?.state === 'ok' && listing.repos.map((repo) => <button key={repo.cloneUrl} type="button" className={`dialog-listitem git-clone-repo${url === repo.cloneUrl ? ' on' : ''}`} aria-pressed={url === repo.cloneUrl} disabled={busy} onClick={() => pickUrl(repo.cloneUrl)}>
              {repo.private ? <Lock size={13} /> : <GitBranch size={13} />}
              <strong>{repo.fullName}</strong>
              <span className="git-clone-chip">{t(repo.private ? 'gitClone.private' : 'gitClone.public')}</span>
              {repo.updatedAt && <small>{formatRelative(repo.updatedAt)}</small>}
            </button>)}
          </div>}
        <div className="git-clone-where">
          <label htmlFor="git-clone-name">{t('gitClone.folderName')}</label>
          <input id="git-clone-name" className="dialog-input" spellCheck={false} value={name} disabled={busy} maxLength={100} onChange={(e) => { setName(e.target.value); setNameEdited(true); setError(null) }} />
          <span>{t('gitClone.into')}</span>
          <div className="git-clone-parent"><code title={parent || undefined}><bdi>{parent || '—'}</bdi></code><button type="button" className="dialog-btn" data-git-clone-parent disabled={busy} onClick={() => void pickParent()}>{t(parent ? 'gitClone.change' : 'gitClone.choose')}</button></div>
        </div>
        {error && <div className="git-clone-error" role="alert" data-git-clone-error><p>{error.message}</p>{error.info && <pre>{error.info}</pre>}
          {error.link && linkGithub && <button type="button" className="dialog-btn" onClick={linkGithub}>{t('gitClone.link')}</button>}</div>}
        {busy && <div className="dialog-msg git-clone-note">{t('gitClone.cloningHint')}</div>}
        <div className="dialog-actions">
          <button className="dialog-btn" disabled={busy} onClick={close}>{t('common.cancel')}</button>
          <button className="dialog-btn" data-primary data-git-clone-confirm disabled={busy || !url.trim() || !name.trim() || !parent} onClick={() => void clone()}>{busy && <Loader2 size={13} className="spin" />}{t(busy ? 'gitClone.cloning' : 'gitClone.confirm')}</button>
        </div>
      </div>
    </DialogOverlay>
  )
}
