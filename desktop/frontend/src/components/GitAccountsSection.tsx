import { useEffect, useState } from 'react'
import { ExternalLink, UserRound } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import { getGitAccounts, getGitSettings, setGitSettings, type GitAccounts } from '../services/backendService'
import { SettingsPanel, SettingsRow } from './SettingsPrimitives'
import { homeTarget } from '../services/engine/targets'
import { routeExternalUrl } from '../builtins'

registerMessages({
  'gitAccounts.title': { zh: '账号', en: 'Accounts' },
  'gitAccounts.description': { zh: '推送和拉取时用哪个账号，提交时署谁的名。', en: 'Which account pushes and pulls use, and whose name goes on your commits.' },
  'gitAccounts.signedOut': { zh: '登录 Forsion 后，这里会显示推送和拉取时用的账号。', en: 'Sign in to Forsion to see the accounts used for pushes and pulls here.' },
  'gitAccounts.forsionGitHint': { zh: '{site} · 用的就是你的 Forsion 账号，不用另外绑定。', en: '{site} · Uses your Forsion account, with nothing to link.' },
  'gitAccounts.open': { zh: '打开', en: 'Open' },
  'gitAccounts.githubLinked': { zh: '@{login} · 已绑定，推送和拉取 GitHub 上的仓库时用它。', en: '@{login} · Linked. Pushes and pulls for repositories on GitHub use it.' },
  'gitAccounts.githubUnlinked': { zh: '还没绑定。绑定后可以直接推送和拉取 GitHub 上的仓库。', en: 'Not linked yet. Link it to push and pull repositories on GitHub directly.' },
  'gitAccounts.link': { zh: '去绑定', en: 'Link' },
  'gitAccounts.manage': { zh: '在账户中心管理', en: 'Manage in account centre' },
  'gitAccounts.identity': { zh: '提交身份', en: 'Commit identity' },
  'gitAccounts.identityGit': { zh: '{name} <{email}> · 来自这台电脑的 git 配置，Forsion 照用它。', en: '{name} <{email}> · From the git configuration on this computer; Forsion uses it as is.' },
  'gitAccounts.identityForsion': { zh: '{name} <{email}> · 来自 Forsion 账号。邮箱是一个不公开的地址；想让提交在 GitHub 上记到你名下，就改成你在 GitHub 用的邮箱。', en: '{name} <{email}> · From your Forsion account. The email is a private address; change it to the one you use on GitHub if you want commits credited to you there.' },
  'gitAccounts.identityCustom': { zh: '{name} <{email}> · 你在这里填的。只在这台电脑的 git 没配名字和邮箱时使用。', en: '{name} <{email}> · Set here. Used only when git on this computer has no name and email configured.' },
  'gitAccounts.identityAuto': { zh: '{name} <{email}> · git 按这台电脑的用户名和主机名自己取的。建议改成你自己的名字和邮箱。', en: '{name} <{email}> · Picked by git from this computer’s user name and host name. Consider changing it to your own name and email.' },
  'gitAccounts.identityNone': { zh: '还没有。填上名字和邮箱后，才能在 Forsion 里提交。', en: 'None yet. Add a name and email before committing from Forsion.' },
  'gitAccounts.edit': { zh: '修改', en: 'Change' },
  'gitAccounts.name': { zh: '名字', en: 'Name' },
  'gitAccounts.email': { zh: '邮箱', en: 'Email' },
  'gitAccounts.save': { zh: '保存', en: 'Save' },
  'gitAccounts.reset': { zh: '恢复默认', en: 'Reset to default' },
  'gitAccounts.emailInvalid': { zh: '邮箱的写法不对。', en: 'That email address does not look right.' },
  'gitAccounts.identityNote': { zh: '邮箱会写进提交记录，推送到公开仓库后所有人都看得到。', en: 'The email is written into your commits and is visible to everyone once pushed to a public repository.' },
})

const EMAIL_OK = /^[^\s@<>]+@[^\s@<>]+$/

/**
 * 设置 → 通用 → Git 的「账号」:Forsion Git(跟着 Forsion 账号走)、GitHub(绑没绑;绑定 / 解绑在账户中心做,这里只给入口)、
 * 提交身份(这台电脑的 git 没配时用哪个名字和邮箱)。数据 = 引擎 GET /agent/git-accounts;提交身份写进引擎 config.json 的 git 段。
 * GitHub 在浏览器里绑,所以窗口回到前台时重读。老引擎(没有这个接口)→ 整块不出现。
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

  return <SettingsPanel icon={<UserRound size={16} />} title={t('gitAccounts.title')} description={t(forsionGit || github ? 'gitAccounts.description' : 'gitAccounts.signedOut')} className="git-accounts-panel">
    {forsionGit && <SettingsRow label="Forsion Git" description={t('gitAccounts.forsionGitHint', { site: forsionGit.webUrl.replace(/^https?:\/\//i, '') })}
      control={<button className="btn ghost sm" data-git-account="forsion-git-open" onClick={() => routeExternalUrl(forsionGit.webUrl)}><ExternalLink size={13} />{t('gitAccounts.open')}</button>} />}
    {github && <SettingsRow label="GitHub" description={github.linked && github.login ? t('gitAccounts.githubLinked', { login: github.login }) : t('gitAccounts.githubUnlinked')}
      control={linkGithub && <button className={`btn sm ${github.linked ? 'ghost' : 'primary'}`} data-git-account={github.linked ? 'github-manage' : 'github-link'} onClick={linkGithub}>{t(github.linked ? 'gitAccounts.manage' : 'gitAccounts.link')}</button>} />}
    <SettingsRow label={t('gitAccounts.identity')}
      description={identity ? t(`gitAccounts.${({ git: 'identityGit', custom: 'identityCustom', forsion: 'identityForsion', auto: 'identityAuto' } as const)[identity.source] ?? 'identityGit'}`, { name: identity.name, email: identity.email }) : t('gitAccounts.identityNone')}
      control={identity?.source !== 'git' && writable && !draft && <button className="btn ghost sm" data-git-account="identity-edit" onClick={() => setDraft({ name: identity?.name ?? '', email: identity?.email ?? '' })}>{t('gitAccounts.edit')}</button>} />
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
}
