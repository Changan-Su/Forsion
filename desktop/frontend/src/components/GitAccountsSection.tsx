import { useEffect, useState } from 'react'
import { ExternalLink, KeyRound, UserRound } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import { getGitAccounts, getGitSettings, setGitSettings, type GitAccounts } from '../services/backendService'
import type { GitIdentity } from '../types'
import { SettingsPanel, SettingsRow } from './SettingsPrimitives'
import { homeTarget } from '../services/engine/targets'
import { routeExternalUrl } from '../builtins'

registerMessages({
  'gitAccounts.title': { zh: '账号', en: 'Accounts' },
  'gitAccounts.description': { zh: '推送和拉取时，按远端在哪个网站决定用哪个账号。带去的账号没有这个仓库的权限时，换成这台电脑自己的凭据再试一次。', en: 'Pushes and pulls use the account that matches the site the remote is on. If that account has no access to the repository, the action is retried once with this computer’s own credentials.' },
  'gitAccounts.signedOut': { zh: '登录 Forsion 后，Forsion Git 和 GitHub 上的远端会用你的账号推送和拉取。没登录时一律用这台电脑自己的 git 凭据。', en: 'Once you sign in to Forsion, remotes on Forsion Git and GitHub push and pull with your account. Until then, everything uses this computer’s own git credentials.' },
  'gitAccounts.forsionGitHint': { zh: '{site} · 用你的 Forsion 账号，不用另外绑定。', en: '{site} · Uses your Forsion account, with nothing to link.' },
  'gitAccounts.forsionGitUser': { zh: '{site} · @{username}，就是你的 Forsion 账号，不用另外绑定。', en: '{site} · @{username}, which is your Forsion account, with nothing to link.' },
  'gitAccounts.open': { zh: '打开网站', en: 'Open site' },
  'gitAccounts.githubLinked': { zh: '@{login} · 已绑定。github.com 上 https 地址的远端用它。', en: '@{login} · Linked. Remotes with an https address on github.com use it.' },
  'gitAccounts.githubUnlinked': { zh: '还没绑定。绑定前，GitHub 上的远端用这台电脑自己的凭据。', en: 'Not linked yet. Until you link one, remotes on GitHub use this computer’s own credentials.' },
  'gitAccounts.link': { zh: '去绑定', en: 'Link' },
  'gitAccounts.manage': { zh: '在账户中心管理', en: 'Manage in account centre' },
  'gitAccounts.other': { zh: '其他站点', en: 'Other sites' },
  'gitAccounts.otherHint': { zh: '用这台电脑自己的 git 凭据：钥匙串、凭据助手或 ssh 钥匙。github.com 的 ssh 地址也走这里。', en: 'Uses this computer’s own git credentials: the keychain, a credential helper or an ssh key. ssh addresses on github.com go this way too.' },
  'gitAccounts.identity': { zh: '提交身份', en: 'Commit identity' },
  'gitAccounts.identityDescription': { zh: '提交时署谁的名。从上往下，用第一个有的。', en: 'Whose name goes on your commits. The first one available, from the top, is used.' },
  'gitAccounts.levelGit': { zh: '这台电脑的 git 配置', en: 'Git configuration on this computer' },
  'gitAccounts.levelCustom': { zh: '这里填的', en: 'Set here' },
  'gitAccounts.levelForsion': { zh: '由 Forsion 账号生成', en: 'Generated from your Forsion account' },
  'gitAccounts.levelAuto': { zh: 'git 按电脑名猜的', en: 'Guessed by git from this computer’s name' },
  'gitAccounts.stateActive': { zh: '正在用', en: 'In use' },
  'gitAccounts.stateMissing': { zh: '没有', en: 'Not set' },
  'gitAccounts.stateUnused': { zh: '用不到', en: 'Not used' },
  'gitAccounts.noteGit': { zh: '在终端里用 git config 改，Forsion 不动它。', en: 'Change it with git config in a terminal. Forsion leaves it alone.' },
  'gitAccounts.noteForsion': { zh: '邮箱是一个不公开的地址；想让提交在 GitHub 上记到你名下，就改成你在 GitHub 用的邮箱。', en: 'The email is a private address. Change it to the one you use on GitHub if you want commits credited to you there.' },
  'gitAccounts.noteAuto': { zh: '建议改成你自己的名字和邮箱。', en: 'Consider changing it to your own name and email.' },
  'gitAccounts.identityNone': { zh: '还没有。填上名字和邮箱后，才能在 Forsion 里提交。', en: 'None yet. Add a name and email before committing from Forsion.' },
  'gitAccounts.edit': { zh: '修改', en: 'Change' },
  'gitAccounts.name': { zh: '名字', en: 'Name' },
  'gitAccounts.email': { zh: '邮箱', en: 'Email' },
  'gitAccounts.save': { zh: '保存', en: 'Save' },
  'gitAccounts.reset': { zh: '恢复默认', en: 'Reset to default' },
  'gitAccounts.emailInvalid': { zh: '邮箱的写法不对。', en: 'That email address does not look right.' },
  'gitAccounts.identityNote': { zh: '邮箱会写进提交记录，推送到公开仓库后所有人都看得到。', en: 'The email is written into your commits and is visible to everyone once pushed to a public repository.' },
})

/** 提交身份的四级(与引擎 resolveGitIdentity 同一个顺序):从上往下取第一个有的。 */
const LEVELS = [
  ['git', 'gitAccounts.levelGit'], ['custom', 'gitAccounts.levelCustom'], ['forsion', 'gitAccounts.levelForsion'], ['auto', 'gitAccounts.levelAuto'],
] as const
const NOTES: Partial<Record<GitIdentity['source'], string>> = { git: 'gitAccounts.noteGit', forsion: 'gitAccounts.noteForsion', auto: 'gitAccounts.noteAuto' }

const EMAIL_OK = /^[^\s@<>]+@[^\s@<>]+$/

/**
 * 设置 → 通用 → Git 的头两块(2026-10-14 用户批的方案 ④):
 *   「账号」= 推拉时按远端所在的站用谁:Forsion Git(跟着 Forsion 账号走)、GitHub(绑没绑;绑定 / 解绑在账户中心做,这里只给入口)、
 *     其他站点(这台电脑自己的凭据),外加「带去的账号被拒 → 换电脑自己的再试一次」;
 *   「提交身份」= 四级链,从上往下取第一个有的,每级标「正在用 / 没有 / 用不到」;「这里填的」那级可改(写进引擎 config.json 的 git 段)。
 * 数据 = 引擎 GET /agent/git-accounts。GitHub 在浏览器里绑,所以窗口回到前台时重读。老引擎(没有这个接口)→ 两块都不出现。
 */
export function GitAccountsSection() {
  const { t } = useI18n()
  const [accounts, setAccounts] = useState<GitAccounts | null>(null)
  const [writable, setWritable] = useState(false)
  const [draft, setDraft] = useState<{ name: string; email: string } | null>(null)
  const [error, setError] = useState('')
  const [reloadAt, setReloadAt] = useState(0)

  useEffect(() => {
    let alive = true
    const read = () => { void getGitAccounts(homeTarget()).then((value) => { if (alive) setAccounts(value) }) }
    read()
    void getGitSettings(homeTarget()).then((r) => { if (alive) setWritable(r.writable) }).catch(() => {})
    window.addEventListener('focus', read)
    return () => { alive = false; window.removeEventListener('focus', read) }
  }, [homeTarget().base, reloadAt])

  if (!accounts) return null
  const { forsionGit, github, identity } = accounts
  const linkGithub = window.tangu?.openAccountCenter ? () => { void window.tangu!.openAccountCenter!('security') } : undefined
  const emailBad = !!draft && !!draft.email.trim() && !EMAIL_OK.test(draft.email.trim())
  const save = async (patch: { identityName: string | null; identityEmail: string | null }) => {
    try {
      await setGitSettings(homeTarget(), patch)
      setDraft(null); setError(''); setReloadAt((n) => n + 1)
    } catch (e: any) { setError(e?.message || String(e)) }
  }

  const site = forsionGit?.webUrl.replace(/^https?:\/\//i, '') ?? ''
  const active = identity ? LEVELS.findIndex(([source]) => source === identity.source) : LEVELS.length
  const canEdit = identity?.source !== 'git' && writable && !draft

  return <>
    <SettingsPanel icon={<KeyRound size={16} />} title={t('gitAccounts.title')} description={t(forsionGit || github ? 'gitAccounts.description' : 'gitAccounts.signedOut')} className="git-accounts-panel">
      {forsionGit && <SettingsRow label="Forsion Git" description={forsionGit.username ? t('gitAccounts.forsionGitUser', { site, username: forsionGit.username }) : t('gitAccounts.forsionGitHint', { site })}
        control={<button className="btn ghost sm" data-git-account="forsion-git-open" onClick={() => routeExternalUrl(forsionGit.webUrl)}><ExternalLink size={13} />{t('gitAccounts.open')}</button>} />}
      {github && <SettingsRow label="GitHub" description={github.linked && github.login ? t('gitAccounts.githubLinked', { login: github.login }) : t('gitAccounts.githubUnlinked')}
        control={linkGithub && <button className={`btn sm ${github.linked ? 'ghost' : 'primary'}`} data-git-account={github.linked ? 'github-manage' : 'github-link'} onClick={linkGithub}>{t(github.linked ? 'gitAccounts.manage' : 'gitAccounts.link')}</button>} />}
      <SettingsRow label={t('gitAccounts.other')} description={t('gitAccounts.otherHint')} />
    </SettingsPanel>
    <SettingsPanel icon={<UserRound size={16} />} title={t('gitAccounts.identity')} description={t(identity ? 'gitAccounts.identityDescription' : 'gitAccounts.identityNone')} className="git-identity-panel">
      {LEVELS.map(([source, label], i) => {
        const state = i === active ? 'active' : i < active ? 'missing' : 'unused'
        const note = i === active ? NOTES[source] : undefined
        return <SettingsRow key={source} label={t(label)}
          description={<span data-git-identity-level={source} data-state={state}>
            <span className="settings-badge" data-state={state}>{t(state === 'active' ? 'gitAccounts.stateActive' : state === 'missing' ? 'gitAccounts.stateMissing' : 'gitAccounts.stateUnused')}</span>
            {i === active && identity && <> {`${identity.name} <${identity.email}>`}</>}
            {note && <> · {t(note)}</>}
          </span>}
          control={source === 'custom' && canEdit && <button className="btn ghost sm" data-git-account="identity-edit" onClick={() => setDraft({ name: identity?.name ?? '', email: identity?.email ?? '' })}>{t('gitAccounts.edit')}</button>} />
      })}
      {draft && <div className="field" data-git-account="identity-form">
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <input type="text" style={{ flex: '1 1 140px', minWidth: 0 }} value={draft.name} maxLength={200} spellCheck={false} aria-label={t('gitAccounts.name')} placeholder={t('gitAccounts.name')}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <input type="email" style={{ flex: '2 1 200px', minWidth: 0 }} value={draft.email} maxLength={200} spellCheck={false} aria-label={t('gitAccounts.email')} placeholder={t('gitAccounts.email')}
            onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
          <button className="btn primary sm" data-git-account="identity-save" disabled={emailBad || !draft.name.trim() || !draft.email.trim()} onClick={() => void save({ identityName: draft.name.trim(), identityEmail: draft.email.trim() })}>{t('gitAccounts.save')}</button>
          <button className="btn ghost sm" onClick={() => { setDraft(null); setError('') }}>{t('common.cancel')}</button>
          {identity?.source === 'custom' && <button className="btn ghost sm" data-git-account="identity-reset" onClick={() => void save({ identityName: null, identityEmail: null })}>{t('gitAccounts.reset')}</button>}
        </div>
        <div className="hint">{t(emailBad ? 'gitAccounts.emailInvalid' : 'gitAccounts.identityNote')}</div>
      </div>}
      {error && <div className="hint model-catalog-error" role="alert">{error}</div>}
    </SettingsPanel>
  </>
}
