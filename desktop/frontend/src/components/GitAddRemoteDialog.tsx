import { useEffect, useState, type ReactNode } from 'react'
import { create } from 'zustand'
import { Check } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import { useEscape } from '../amadeus/components/Dialogs'
import { RemoteHostIcon } from '../views/ProjectGitRemotes'
import './gitCloneDialog.css'

registerMessages({
  'gitAddRemote.title': { zh: '添加远端', en: 'Add remote' },
  'gitAddRemote.subtitleFirst': { zh: '推送和拉取都要先有一个远端。', en: 'Pushing and pulling need a remote first.' },
  'gitAddRemote.subtitleMore': { zh: '原来的远端留着，在「远端」卡片里随时切回去。', en: 'Your existing remotes stay. You can switch back from the Remotes card at any time.' },
  'gitAddRemote.forsion': { zh: '在你的 Forsion Git 账号下新建私有仓库并推送。用你的 Forsion 账号，国内访问快。', en: 'Creates a private repository under your Forsion Git account and pushes to it. Uses your Forsion account and is fast to reach from mainland China.' },
  'gitAddRemote.github': { zh: '在 @{login} 名下新建私有仓库并推送。用绑定的 GitHub 账号。', en: 'Creates a private repository under @{login} and pushes to it. Uses your linked GitHub account.' },
  'gitAddRemote.githubUnlinked': { zh: '还没绑定 GitHub 账号。在账户中心绑定后回到这里。', en: 'No GitHub account is linked yet. Link one in the account centre, then come back.' },
  'gitAddRemote.link': { zh: '去绑定', en: 'Link GitHub' },
  'gitAddRemote.url': { zh: '已有的仓库地址', en: 'Existing repository address' },
  'gitAddRemote.urlHint': { zh: '粘贴地址。github.com 和 Forsion Git 上的地址自动用对应账号，别的站用这台电脑自己的凭据。', en: 'Paste an address. Addresses on github.com and Forsion Git use the matching account; other sites use this computer’s own credentials.' },
  'gitAddRemote.repoName': { zh: '仓库名', en: 'Repository name' },
  'gitAddRemote.repoNameHint': { zh: '只用英文字母、数字和 - _ .', en: 'Use only letters, digits and - _ .' },
  'gitAddRemote.address': { zh: '仓库地址', en: 'Repository address' },
  'gitAddRemote.urlPlaceholder': { zh: '以 https:// 或 git@ 开头', en: 'Starts with https:// or git@' },
  'gitAddRemote.target': { zh: '以后推送到这里', en: 'Push here from now on' },
  'gitAddRemote.targetHint': { zh: '不勾就只推送这一次，推送去向不变。', en: 'Leave it unchecked to push here just this once and keep the current push target.' },
  'gitAddRemote.create': { zh: '新建并推送', en: 'Create and push' },
  'gitAddRemote.connect': { zh: '连接', en: 'Connect' },
})

export type AddRemoteKind = 'forsion' | 'github' | 'url'
export interface AddRemoteChoice { kind: AddRemoteKind; value: string; target: boolean }
/** 对话框要的三样(随时重读:GitHub 在浏览器里绑,窗口回到前台时再问一次)。null = 这里没有那一条路。 */
export interface AddRemoteOptions {
  forsion: { name: string } | null
  github: { linked: boolean; login?: string; name: string } | null
  connect: boolean
  hasRemotes: boolean
}

/** 仓库名的规矩与引擎 forsionRepoName 同一把(Gitea / GitHub 都收):英文字母、数字、- _ .;引擎还会再校验一遍。 */
const NAME_OK = /^[A-Za-z0-9_.-]{1,100}$/

// ── 命令式入口:await askAddRemote(load) → 用户选好的那一条(调用方用 gitRun 去做),取消 → null ──
interface Req { load: () => Promise<AddRemoteOptions>; resolve: (v: AddRemoteChoice | null) => void }
const useAddRemoteStore = create<{ req: Req | null }>(() => ({ req: null }))
export function askAddRemote(load: () => Promise<AddRemoteOptions>): Promise<AddRemoteChoice | null> {
  if (useAddRemoteStore.getState().req) return Promise.resolve(null)
  return new Promise((resolve) => { useAddRemoteStore.setState({ req: { load, resolve } }) })
}

/** 挂载一次(AmadeusOverlays,与 GitCloneHost 同处);载体类同 AskStringHost,.dialog-* 的样式才命中。 */
export function GitAddRemoteHost() {
  const req = useAddRemoteStore((s) => s.req)
  if (!req) return null
  const settle = (v: AddRemoteChoice | null): void => {
    if (useAddRemoteStore.getState().req !== req) return
    useAddRemoteStore.setState({ req: null })
    req.resolve(v)
  }
  return <div className="am-app tangu-lovable" style={{ display: 'contents' }}><GitAddRemoteDialog load={req.load} onDone={settle} /></div>
}

function GitAddRemoteDialog({ load, onDone }: { load: () => Promise<AddRemoteOptions>; onDone: (v: AddRemoteChoice | null) => void }) {
  const { t } = useI18n()
  const [opts, setOpts] = useState<AddRemoteOptions | null>(null)
  const [kind, setKind] = useState<AddRemoteKind | null>(null)
  const [names, setNames] = useState<{ forsion?: string; github?: string }>({})
  const [url, setUrl] = useState('')
  const [target, setTarget] = useState(true)
  const linkGithub = window.tangu?.openAccountCenter ? () => { void window.tangu!.openAccountCenter!('security') } : undefined
  const close = () => onDone(null)
  useEscape(close)

  useEffect(() => {
    let alive = true
    const read = () => { void load().then((value) => { if (alive) setOpts(value) }) }
    read()
    window.addEventListener('focus', read)
    return () => { alive = false; window.removeEventListener('focus', read) }
  }, [load])
  // 缺省选第一条能用的(Forsion Git → 绑了的 GitHub → 贴地址)
  useEffect(() => {
    if (!opts || kind) return
    setKind(opts.forsion ? 'forsion' : opts.github?.linked ? 'github' : opts.connect ? 'url' : opts.github ? 'github' : null)
  }, [opts, kind])

  const nameOf = (k: 'forsion' | 'github'): string => names[k] ?? (k === 'forsion' ? opts?.forsion?.name : opts?.github?.name) ?? ''
  const value = kind === 'url' ? url.trim() : kind ? nameOf(kind).trim() : ''
  const githubBlocked = kind === 'github' && !opts?.github?.linked
  const nameBad = kind !== 'url' && !!value && !NAME_OK.test(value)
  const ready = !!kind && !!value && !githubBlocked && !nameBad
  const submit = () => { if (ready && kind) onDone({ kind, value, target: opts?.hasRemotes ? target : true }) }

  const choice = (k: AddRemoteKind, title: string, body: ReactNode) =>
    <button type="button" role="radio" aria-checked={kind === k} className={`git-remote-choice${kind === k ? ' on' : ''}`} data-git-add-remote={k} onClick={() => setKind(k)}>
      <span className="git-remote-radio" aria-hidden="true" />
      <RemoteHostIcon host={k} />
      <span className="git-remote-choice-text"><strong>{title}</strong><small>{body}</small></span>
    </button>

  return (
    <div className="dialog-overlay" onMouseDown={close}>
      <div className="dialog git-clone-dialog git-add-remote-dialog" role="dialog" aria-modal="true" aria-label={t('gitAddRemote.title')} data-git-add-remote-dialog onMouseDown={(e) => e.stopPropagation()}>
        <div>
          <div className="dialog-title">{t('gitAddRemote.title')}</div>
          <div className="dialog-msg">{t(opts?.hasRemotes ? 'gitAddRemote.subtitleMore' : 'gitAddRemote.subtitleFirst')}</div>
        </div>
        <div className="git-remote-choices" role="radiogroup" aria-label={t('gitAddRemote.title')}>
          {opts?.forsion && choice('forsion', 'Forsion Git', t('gitAddRemote.forsion'))}
          {opts?.github && choice('github', 'GitHub', opts.github.linked && opts.github.login ? t('gitAddRemote.github', { login: opts.github.login }) : t('gitAddRemote.githubUnlinked'))}
          {opts?.connect && choice('url', t('gitAddRemote.url'), t('gitAddRemote.urlHint'))}
        </div>
        {githubBlocked
          ? linkGithub && <div className="git-clone-note"><button type="button" className="dialog-btn" data-git-add-remote-link onClick={linkGithub}>{t('gitAddRemote.link')}</button></div>
          : kind && <div className="git-clone-where">
            <label htmlFor="git-add-remote-value">{t(kind === 'url' ? 'gitAddRemote.address' : 'gitAddRemote.repoName')}</label>
            <input id="git-add-remote-value" className="dialog-input" autoFocus spellCheck={false} data-git-add-remote-value
              value={kind === 'url' ? url : nameOf(kind)} maxLength={kind === 'url' ? 2000 : 100} placeholder={kind === 'url' ? t('gitAddRemote.urlPlaceholder') : undefined}
              onChange={(e) => (kind === 'url' ? setUrl(e.target.value) : setNames((cur) => ({ ...cur, [kind]: e.target.value })))}
              onKeyDown={(e) => { if (e.key === 'Enter') submit() }} />
            {nameBad && <><span /><small className="git-add-remote-bad" role="alert">{t('gitAddRemote.repoNameHint')}</small></>}
          </div>}
        {opts?.hasRemotes && !githubBlocked && <label className="git-add-remote-target" data-git-add-remote-target>
          <input type="checkbox" checked={target} onChange={(e) => setTarget(e.target.checked)} />
          <span className="git-add-remote-box" aria-hidden="true">{target && <Check size={10} strokeWidth={3} />}</span>
          <span><strong>{t('gitAddRemote.target')}</strong><small>{t('gitAddRemote.targetHint')}</small></span>
        </label>}
        <div className="dialog-actions">
          <button className="dialog-btn" onClick={close}>{t('common.cancel')}</button>
          <button className="dialog-btn" data-primary data-git-add-remote-confirm disabled={!ready} onClick={submit}>{t(kind === 'url' ? 'gitAddRemote.connect' : 'gitAddRemote.create')}</button>
        </div>
      </div>
    </div>
  )
}
