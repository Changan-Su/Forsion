/**
 * 侧栏左下角 Forsion 账号卡(forsion-ui UserProfileCard 规范):
 *  - 已登录:36px 头像(URL,或渐变圆+首字母)+ 昵称 + 会员徽章(TierBadge),副标题「用户中心」;
 *    点击弹出账号菜单(额度剩余百分比/重置卡/升级会员/邀请好友/用户中心/登出);
 *    宿主能力缺席(web 无 accountQuota IPC)时回落为直接打开个人中心。悬停露出「登出」。
 *  - 未登录:头像占位 + 「登录 / 注册」+ 副标题「点击登录」;不登录 Tangu 也能正常用。
 * 自管 authStatus(挂载即拉 + 监听 auth:device 推登录链接);登录/登出后回调 onAuthChange 让上层重连。
 */
import React, { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { OverlayAt } from '@lcl/engine'
import { LogOut, Loader2, Gauge, ChevronDown, ChevronRight, Send, UserRound, ExternalLink, RotateCcw } from 'lucide-react'
import type { AuthStatusInfo } from '../types'
import { useI18n } from '../i18n'
import { TierBadge } from './TierBadge'
import { track } from '../achievements/store'

/** /api/token-quota/my 透传里本菜单消费的字段(percent 是「已用」百分比,展示用 100-x)。 */
interface QuotaJson {
  dailyLimit: number
  dailyPercent: number
  weeklyLimit: number
  weeklyPercent: number
  weeklyResetAt?: string
  resetCards?: number
  resetCardsWeekly?: number
}

/** 重置卡两种粒度:全额(日+周)/ 仅周,与 server reset-card/use 的 type 一致。 */
type ResetScope = 'both' | 'weekly'

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
  const [menu, setMenu] = useState<{ x: number; y: number; anchorTop: number } | null>(null)
  const [quota, setQuota] = useState<QuotaJson | null>(null)
  const [quotaErr, setQuotaErr] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  const [confirmReset, setConfirmReset] = useState<ResetScope | ''>('')
  const [busyReset, setBusyReset] = useState(false)

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

  // ── 账号菜单(点击头像弹出;portal + OverlayAt,任意外部点击/Esc/失焦关闭) ──
  const openMenu = (el: HTMLElement): void => {
    const r = el.getBoundingClientRect()
    setMenu({ x: r.left, y: r.top, anchorTop: r.top })
    setUsageOpen(false)
    setConfirmReset('')
    setQuotaErr(false)
    setQuota(null) // 每次打开都从「加载中」起步,别让上一次的旧数据把失败盖成正常(codex#10)
    void window.tangu?.accountQuota?.()
      .then((res) => { if (res?.status === 200 && res.json) setQuota(res.json as QuotaJson); else setQuotaErr(true) })
      .catch(() => setQuotaErr(true))
  }
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close() }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  const useReset = async (scope: ResetScope): Promise<void> => {
    if (busyReset) return
    if (confirmReset !== scope) { setConfirmReset(scope); return } // 两击确认,且换行即重新确认
    setBusyReset(true)
    try {
      const r = await window.tangu?.accountUseResetCard?.(scope)
      if (r?.status === 200 && r.json?.success) {
        setQuota({
          ...(r.json.quota || {}),
          resetCards: r.json.resetCards,
          resetCardsWeekly: r.json.resetCardsWeekly,
        })
        // 成功文案按卡型说实话:周卡别宣称恢复了今日(codex3#4)
        onToast?.(t(scope === 'weekly' ? 'sidebar.account.menu.resetDoneWeekly' : 'sidebar.account.menu.resetDone'))
      } else if (r?.json?.error === 'no_reset_card') {
        onToast?.(t('sidebar.account.menu.noCard'), true)
      } else {
        onToast?.(String(r?.json?.detail || t('sidebar.account.menu.resetFail')), true)
      }
    } catch (e: any) {
      onToast?.(String(e?.message || e), true)
    } finally {
      setBusyReset(false)
      setConfirmReset('')
    }
  }

  // percent 是「已用」百分比,菜单按用户口径显示剩余
  const remainPct = (used: number): string => `${Math.max(0, 100 - Math.round(used))}%`
  // 纯日期串(北京日历日)手工拆,不过 new Date()——那会按 UTC 解析,西时区显示会少一天(codex#9)
  const fmtResetDate = (d?: string): string => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || '')
    return m ? `${Number(m[2])}/${Number(m[3])}` : (d || '')
  }

  const loggedIn = !!auth?.loggedIn
  // 过期 = token 仍在(loggedIn)但 whoami 判定失效(tokenValid:false)。此时绝不当「已登录」对待。
  const expired = loggedIn && auth?.tokenValid === false
  // 引擎轴(managed 才有,external/纯 Amadeus 形态 backendState=null):与「登没登录」正交。
  // 引擎没 ready 时绝不能只亮「已登录」绿灯——那正是「显示登录了但后端没启动」的老 bug。
  const engineDown = auth?.backendState === 'stopped' || auth?.backendState === 'crashed'
  const engineStarting = auth?.backendState === 'starting'
  const display = auth?.nickname || auth?.username || 'Forsion'
  const initial = display.trim().charAt(0).toUpperCase() || 'F'
  // 引擎未运行 → 点击重启引擎;过期 → 重新登录;已登录(有效)→ 弹账号菜单(无 IPC 则直开账号中心);未登录 → 登录。
  const activate = (e: React.MouseEvent | React.KeyboardEvent): void => {
    if (engineDown) { void window.tangu?.backendRestart?.().finally(refresh); return }
    if (!loggedIn || expired) { void login(); return }
    if (window.tangu?.accountQuota) openMenu(e.currentTarget as HTMLElement)
    else openCenter()
  }
  const stateClass = engineDown ? ' engine-down' : expired ? ' expired' : ''
  const subText = engineDown ? t('sidebar.account.engineDown')
    : engineStarting ? t('sidebar.account.engineStarting')
    : expired ? t('sidebar.account.expired')
    : loggedIn ? t('sidebar.account.center') : t('sidebar.account.loginSub')

  const avatarEl = loggedIn && auth?.avatar && !imgError ? (
    <img className="account-avatar" src={auth.avatar} alt="" onError={() => setImgError(true)} />
  ) : (
    <span className="account-avatar fallback">{loggingIn ? <Loader2 size={14} className="spin" /> : initial}</span>
  )

  const menuEl = menu ? createPortal(
    <OverlayAt
      className="account-pop"
      x={menu.x}
      y={menu.y}
      anchorTop={menu.anchorTop}
      prefer="above"
      margin={8}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="ap-head">
        {avatarEl}
        <span className="ap-name">{display}</span>
        <TierBadge tier={auth?.membershipTier} />
      </div>
      <button className="ap-item" onClick={() => setUsageOpen((v) => !v)}>
        <Gauge size={14} /><span>{t('sidebar.account.menu.usage')}</span><span className="grow" />
        {usageOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      {usageOpen && (
        <div className="ap-usage">
          {quota ? (
            <>
              <div className="ap-row">
                <span>{t('sidebar.account.menu.weekly')}</span><span className="grow" />
                <b>{quota.weeklyLimit < 0 ? t('sidebar.account.menu.unlimited') : remainPct(quota.weeklyPercent)}</b>
                {quota.weeklyLimit >= 0 && !!quota.weeklyResetAt && <span className="ap-dim">{fmtResetDate(quota.weeklyResetAt)}</span>}
              </div>
              <div className="ap-row">
                <span>{t('sidebar.account.menu.daily')}</span><span className="grow" />
                <b>{quota.dailyLimit < 0 ? t('sidebar.account.menu.unlimited') : remainPct(quota.dailyPercent)}</b>
              </div>
            </>
          ) : (
            <div className="ap-row ap-dim">{quotaErr ? t('sidebar.account.menu.quotaFail') : t('sidebar.account.menu.loading')}</div>
          )}
          {/* 升级入口不依赖额度接口成败(codex#8) */}
          {!!window.tangu?.openPayCenter && (
            <button className="ap-item ap-sub-item" onClick={() => { void window.tangu?.openPayCenter?.(); setMenu(null) }}>
              <span>{t('sidebar.account.menu.upgrade')}</span><span className="grow" /><ExternalLink size={12} />
            </button>
          )}
          {!!quota && ([
            ['both', quota.resetCards, 'sidebar.account.menu.resets'],
            ['weekly', quota.resetCardsWeekly, 'sidebar.account.menu.resetsWeekly'],
          ] as Array<[ResetScope, number | undefined, string]>).map(([scope, n, key]) => (n || 0) > 0 && (
            <button key={scope} className="ap-item ap-sub-item" disabled={busyReset} onClick={() => void useReset(scope)}>
              <RotateCcw size={12} className={busyReset && confirmReset === scope ? 'spin' : undefined} />
              <span>{confirmReset === scope ? t('sidebar.account.menu.resetConfirm') : t(key, { n: String(n) })}</span>
            </button>
          ))}
        </div>
      )}
      <button className="ap-item" onClick={() => { void window.tangu?.openAccountCenter?.('points-exchange'); setMenu(null) }}>
        <Send size={14} /><span>{t('sidebar.account.menu.invite')}</span>
      </button>
      <button className="ap-item" onClick={() => { openCenter(); setMenu(null) }}>
        <UserRound size={14} /><span>{t('sidebar.account.menu.center')}</span><span className="grow" /><ExternalLink size={12} />
      </button>
      <button className="ap-item ap-danger" onClick={() => { setMenu(null); void logout() }}>
        <LogOut size={14} /><span>{t('sidebar.account.logout')}</span>
      </button>
    </OverlayAt>,
    document.body,
  ) : null

  if (compact) {
    return (
      <>
        <button
          className={`ribbon-account${stateClass}`}
          title={engineDown ? t('sidebar.account.engineDown') : engineStarting ? t('sidebar.account.engineStarting') : expired ? t('sidebar.account.expired') : loggedIn ? display : t('sidebar.account.login')}
          onClick={activate}
        >
          {avatarEl}
        </button>
        {menuEl}
      </>
    )
  }

  return (
    <>
      <div
        className={`account-card${stateClass}`}
        role="button"
        tabIndex={0}
        title={engineDown ? t('sidebar.account.engineDown') : engineStarting ? t('sidebar.account.engineStarting') : expired ? t('sidebar.account.expired') : loggedIn ? t('sidebar.account.center') : t('sidebar.account.loginHint')}
        onClick={activate}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(e) } }}
      >
        {avatarEl}
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
      {menuEl}
    </>
  )
}
