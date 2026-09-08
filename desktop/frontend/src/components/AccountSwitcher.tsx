import React, { useEffect, useState } from 'react'
import { Check, UserRound, UserRoundPlus } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import type { AuthAccountInfo } from '../types'

registerMessages({
  'accountSwitcher.title': { zh: '切换账号', en: 'Switch account' },
  'accountSwitcher.add': { zh: '登录其他账号', en: 'Sign in to another account' },
  'accountSwitcher.current': { zh: '当前账号', en: 'Current account' },
  'accountSwitcher.failed': { zh: '账号操作失败：{error}', en: 'Account action failed: {error}' },
  'accountSwitcher.loadFailed': { zh: '无法加载已登录账号', en: 'Could not load signed-in accounts' },
  'accountSwitcher.localHint': {
    zh: 'Forsion 文件夹与本机设置共用；云同步关联和进度随账号切换。新账号需要单独开启同步。',
    en: 'Your Forsion folder and device settings are shared. Cloud sync links and progress follow each account. Enable sync separately for a new account.',
  },
})

/** Only account labels cross IPC; saved credentials stay in the host. */
export function AccountSwitcher({ busy, onSelect, onAdd, menu = false }: {
  busy: boolean
  onSelect: (id: string) => void
  onAdd: () => void
  menu?: boolean
}): React.ReactElement | null {
  const { t } = useI18n()
  const [accounts, setAccounts] = useState<AuthAccountInfo[]>([])
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let version = 0
    const read = (): void => {
      const request = ++version
      setAccounts([])
      setFailed(false)
      void window.tangu?.authAccounts?.().then((items) => {
        if (request === version) setAccounts(items)
      }).catch(() => { if (request === version) setFailed(true) })
    }
    read()
    const off = window.tangu?.onAuthChanged?.(read)
    return () => { ++version; off?.() }
  }, [])
  if (!window.tangu?.forsionLogin) return null
  const itemClass = menu ? 'ap-item' : 'btn ghost sm'
  return (
    <div className={menu ? 'ap-accounts' : 'field'} aria-label={t('accountSwitcher.title')}>
      <div className={menu ? 'ap-head' : 'hint'}>{t('accountSwitcher.title')}</div>
      {failed && <div className="hint" role="status">{t('accountSwitcher.loadFailed')}</div>}
      <div style={menu ? undefined : { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
        {accounts.map((account) => (
          <button key={account.id} className={itemClass} disabled={busy || account.active}
            title={`${account.username || account.nickname || 'Forsion'} · ${account.cloudUrl}`}
            aria-current={account.active ? 'true' : undefined}
            onClick={() => onSelect(account.id)}>
            {account.active ? <Check size={14} /> : <UserRound size={14} />}
            <span>{account.nickname || account.username || account.cloudUrl}</span>
            {account.active && <span className="ap-dim">{t('accountSwitcher.current')}</span>}
          </button>
        ))}
        <button className={itemClass} disabled={busy} onClick={onAdd}>
          <UserRoundPlus size={14} /><span>{t('accountSwitcher.add')}</span>
        </button>
      </div>
      {!menu && <div className="hint" style={{ marginTop: 8 }}>{t('accountSwitcher.localHint')}</div>}
    </div>
  )
}
