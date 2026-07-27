/**
 * 侧栏左下角 Forsion 账号卡(forsion-ui UserProfileCard 规范):
 *  - 已登录:36px 头像(URL,或渐变圆+首字母)+ 昵称 + 会员徽章(TierBadge),副标题「用户中心」;
 *    整行可点击 → 浏览器打开个人中心(IPC auth:openAccountCenter);悬停露出「登出」。
 *  - 未登录:头像占位 + 「登录 / 注册」+ 副标题「点击登录」;不登录 Tangu 也能正常用。
 * 自管 authStatus(挂载即拉 + 监听 auth:device 推登录链接);登录/登出后回调 onAuthChange 让上层重连。
 */
import React, { useCallback, useEffect, useState } from 'react'
import { LogOut, Loader2 } from 'lucide-react'
import type { AuthStatusInfo } from '../types'
import { useI18n } from '../i18n'
import { TierBadge } from './TierBadge'
import { track } from '../achievements/store'

export const AccountCard: React.FC<{
  onToast?: (text: string, error?: boolean) => void
  onAuthChange?: () => void
  /** ribbon 紧凑态:只渲染头像钮(点击→个人中心/登录),无昵称/徽章/登出行。 */
  compact?: boolean
}> = ({ onToast, onAuthChange, compact }) => {
  const { t } = useI18n()
  const [auth, setAuth] = useState<AuthStatusInfo | null>(null)
  const [loggingIn, setLoggingIn] = useState(false)
  const [imgError, setImgError] = useState(false)

  const refresh = useCallback(() => {
    setImgError(false)
    void window.tangu?.authStatus?.().then(setAuth).catch(() => setAuth(null))
  }, [])

  useEffect(() => {
    refresh()
    const off = window.tangu?.onAuthDevice?.((info) => {
      if (info?.url) onToast?.(`${t('sidebar.account.center')}: ${info.url}${info.userCode ? ` (${info.userCode})` : ''}`)
    })
    // 登录态变化(本窗/他窗登录登出、CLI tangu login 等外部来源经主进程 auth.json watcher 广播)→ 重拉。
    const offAuth = window.tangu?.onAuthChanged?.(() => refresh())
    // 引擎进程态变化(启动/就绪/崩溃)→ 重拉:authStatus.backendState 是本卡「引擎未运行」轴的数据源。
    const offBackend = window.tangu?.onBackendStatus?.(() => refresh())
    // token 过期(handleAuthExpired 派发)→ 重拉 authStatus,使本卡显示过期态 + 点击改走重新登录。
    const onExpired = (): void => refresh()
    window.addEventListener('tangu:auth-expired', onExpired)
    // 窗口聚焦重拉:用户去浏览器的账号中心退出登录后切回桌面,authStatus 的 whoami 撞 401
    // → 主进程就地转真登出 → 本卡立刻显示未登录(不然要等下一次偶发刷新)。
    const onFocus = (): void => refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      off?.(); offAuth?.(); offBackend?.()
      window.removeEventListener('tangu:auth-expired', onExpired)
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh, onToast, t])

  const login = async (): Promise<void> => {
    if (!window.tangu?.forsionLogin) return
    setLoggingIn(true)
    try {
      await window.tangu.forsionLogin()
      track('account.login')
      refresh()
      onAuthChange?.()
    } catch (e: any) {
      onToast?.(t('sidebar.account.loginFail', { e: e?.message || e }), true)
    } finally {
      setLoggingIn(false)
    }
  }
  const logout = async (): Promise<void> => {
    await window.tangu?.forsionLogout?.().catch(() => {})
    refresh()
    onAuthChange?.()
  }
  const openCenter = (): void => { void window.tangu?.openAccountCenter?.() }

  const loggedIn = !!auth?.loggedIn
  // 过期 = token 仍在(loggedIn)但 whoami 判定失效(tokenValid:false)。此时绝不当「已登录」对待。
  const expired = loggedIn && auth?.tokenValid === false
  // 引擎轴(managed 才有,external/纯 Amadeus 形态 backendState=null):与「登没登录」正交。
  // 引擎没 ready 时绝不能只亮「已登录」绿灯——那正是「显示登录了但后端没启动」的老 bug。
  const engineDown = auth?.backendState === 'stopped' || auth?.backendState === 'crashed'
  const engineStarting = auth?.backendState === 'starting'
  const display = auth?.nickname || auth?.username || 'Forsion'
  const initial = display.trim().charAt(0).toUpperCase() || 'F'
  // 引擎未运行 → 点击重启引擎;过期 → 重新登录;已登录(有效)→ 账号中心;未登录 → 登录。
  const activate = (): void => {
    if (engineDown) { void window.tangu?.backendRestart?.().finally(refresh); return }
    (loggedIn && !expired) ? openCenter() : void login()
  }
  const stateClass = engineDown ? ' engine-down' : expired ? ' expired' : ''
  const subText = engineDown ? t('sidebar.account.engineDown')
    : engineStarting ? t('sidebar.account.engineStarting')
    : expired ? t('sidebar.account.expired')
    : loggedIn ? t('sidebar.account.center') : t('sidebar.account.loginSub')

  if (compact) {
    return (
      <button
        className={`ribbon-account${stateClass}`}
        title={engineDown ? t('sidebar.account.engineDown') : engineStarting ? t('sidebar.account.engineStarting') : expired ? t('sidebar.account.expired') : loggedIn ? display : t('sidebar.account.login')}
        onClick={activate}
      >
        {loggedIn && auth?.avatar && !imgError ? (
          <img className="account-avatar" src={auth.avatar} alt="" onError={() => setImgError(true)} />
        ) : (
          <span className="account-avatar fallback">{loggingIn ? <Loader2 size={14} className="spin" /> : initial}</span>
        )}
      </button>
    )
  }

  return (
    <div
      className={`account-card${stateClass}`}
      role="button"
      tabIndex={0}
      title={engineDown ? t('sidebar.account.engineDown') : engineStarting ? t('sidebar.account.engineStarting') : expired ? t('sidebar.account.expired') : loggedIn ? t('sidebar.account.center') : t('sidebar.account.loginHint')}
      onClick={activate}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate() } }}
    >
      {loggedIn && auth?.avatar && !imgError ? (
        <img className="account-avatar" src={auth.avatar} alt="" onError={() => setImgError(true)} />
      ) : (
        <span className="account-avatar fallback">{loggingIn ? <Loader2 size={14} className="spin" /> : initial}</span>
      )}
      <span className="account-meta">
        <span className="account-name-row">
          <span className="account-name">{loggedIn ? display : (loggingIn ? t('sidebar.account.loggingIn') : t('sidebar.account.login'))}</span>
          {loggedIn && !expired && <TierBadge tier={auth?.membershipTier} />}
        </span>
        <span className="account-sub">{subText}</span>
      </span>
      {loggedIn && (
        <button className="icon-btn account-logout" title={t('sidebar.account.logout')} onClick={(e) => { e.stopPropagation(); void logout() }}>
          <LogOut size={13} />
        </button>
      )}
    </div>
  )
}
