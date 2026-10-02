/**
 * 侧栏左下角 Forsion 账号卡(forsion-ui UserProfileCard 规范):
 *  - 已登录:36px 头像(URL,或渐变圆+首字母)+ 昵称 + 会员徽章(TierBadge);
 *    点击弹出账号菜单。2026-09-28 起菜单只留四样:头部(→ 设置「Forsion 云端 → 账号」)、一行 AI 额度摘要
 *    (→「额度与积分」)、切换账号、退出登录 —— 升级、重置卡、邀请、网页个人中心都收进 Extend 画的那几页,
 *    菜单里不再各放一份(个人中心盘点:同一件事三四个入口、说法各不相同)。悬停露出「退出登录」。
 *  - 未登录:头像占位 + 「登录 / 注册」+ 副标题「点击登录」;不登录 Tangu 也能正常用。
 * 自管 authStatus(挂载即拉 + 监听 auth:device 推登录链接);登录/登出后回调 onAuthChange 让上层重连。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { OverlayAt, nativeSheetPresenter, runNativeSheetMenu, type SheetMenuItem, type SheetMenuSection } from '@lcl/engine'
import { LogIn, LogOut, Loader2, Gauge, ChevronRight, RotateCcw } from 'lucide-react'
import type { AuthAccountInfo, AuthStatusInfo } from '../types'
import { registerMessages, useI18n } from '../i18n'
import { TierBadge } from './TierBadge'
import { track } from '../achievements/store'
import { AccountSwitcher, accountSwitcherModel } from './AccountSwitcher'
import { formatRemaining, publishAccountQuota, remainingPercent, type AccountQuotaView } from '../services/accountQuota'
import { useApp } from '../stores/appStore'

registerMessages({
  'sidebar.account.notSignedIn': { zh: '未登录', en: 'Not signed in' },
  'sidebar.account.loginLink': { zh: '登录链接', en: 'Sign-in link' },
  'sidebar.account.menu.quota': { zh: 'AI 额度', en: 'AI quota' },
  'sidebar.account.menu.quotaLine': { zh: '今日 {daily} · 本周 {weekly}', en: 'Today {daily} · This week {weekly}' },
  'sidebar.account.menu.openAccount': { zh: '账号设置', en: 'Account settings' },
})

/** 「Forsion 云端」里 Extend 画的子页(registerSettingsView category 'forsion')。没有 Extend 的设备页 / 旧宿主不给跳。 */
const openCloudPage = (id: 'account' | 'quota'): void =>
  useApp.getState().openSettings(`forsion/fx:forsion-extend:${id}` as Parameters<ReturnType<typeof useApp.getState>['openSettings']>[0])

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
  const [quota, setQuota] = useState<AccountQuotaView | null>(null)
  const [quotaErr, setQuotaErr] = useState(false)
  const authRequest = useRef(0)
  const authAction = useRef(0)
  const actionBusy = useRef(false)
  const quotaRequest = useRef(0)

  const refresh = useCallback(() => {
    const request = ++authRequest.current
    setImgError(false)
    void window.tangu?.authStatus?.().then((value) => {
      if (request === authRequest.current) setAuth(value)
    }).catch(() => { if (request === authRequest.current) setAuth(null) })
  }, [])

  useEffect(() => {
    refresh()
    const off = window.tangu?.onAuthDevice?.((info) => {
      if (info?.url) onToast?.(`${t('sidebar.account.loginLink')}: ${info.url}${info.userCode ? ` (${info.userCode})` : ''}`)
    })
    // 登录态变化(本窗/他窗登录登出、CLI tangu login 等外部来源经主进程 auth.json watcher 广播)→ 重拉。
    const offAuth = window.tangu?.onAuthChanged?.(() => {
      ++quotaRequest.current
      setAuth(null)
      setMenu(null)
      setQuota(null)
      refresh()
    })
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
      ++authRequest.current
      ++quotaRequest.current
      off?.(); offAuth?.(); offBackend?.()
      window.removeEventListener('tangu:auth-expired', onExpired)
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh, onToast, t])

  const login = async (accountId?: string): Promise<void> => {
    if (!window.tangu?.forsionLogin) return
    if (actionBusy.current) return
    actionBusy.current = true
    const action = ++authAction.current
    ++authRequest.current
    ++quotaRequest.current
    setLoggingIn(true)
    setMenu(null)
    setQuota(null)
    try {
      if (accountId) await window.tangu.forsionSwitchAccount!(accountId)
      else await window.tangu.forsionLogin()
      if (action !== authAction.current) return
      track('account.login')
      refresh()
      onAuthChange?.()
    } catch (e: any) {
      if (action === authAction.current) onToast?.(t('sidebar.account.loginFail', { e: e?.message || e }), true)
    } finally {
      if (action === authAction.current) { actionBusy.current = false; setLoggingIn(false) }
    }
  }
  const logout = async (): Promise<void> => {
    const action = ++authAction.current
    ++authRequest.current
    ++quotaRequest.current
    actionBusy.current = true
    setLoggingIn(true)
    setMenu(null)
    setQuota(null)
    try {
      await window.tangu?.forsionLogout?.()
      if (action !== authAction.current) return
      setAuth(null)
      refresh()
      onAuthChange?.()
    } catch (e: any) {
      onToast?.(t('accountSwitcher.failed', { error: String(e?.message || e) }), true)
    } finally {
      if (action === authAction.current) { actionBusy.current = false; setLoggingIn(false) }
    }
  }

  // ── 账号菜单(点击头像弹出;portal + OverlayAt,任意外部点击/Esc/失焦关闭) ──
  const openMenu = (el: HTMLElement): void => {
    const r = el.getBoundingClientRect()
    setMenu({ x: r.left, y: r.top, anchorTop: r.top })
    setQuotaErr(false)
    setQuota(null) // 每次打开都从「加载中」起步,别让上一次的旧数据把失败盖成正常(codex#10)
    const request = ++quotaRequest.current
    if (!auth?.loggedIn) return
    void window.tangu?.accountQuota?.()
      .then((res) => {
        if (request !== quotaRequest.current) return
        if (res?.status === 200 && res.json) {
          const next = res.json as AccountQuotaView
          setQuota(next)
          publishAccountQuota(next)
        } else setQuotaErr(true)
      })
      .catch(() => { if (request === quotaRequest.current) setQuotaErr(true) })
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

  const loggedIn = !!auth?.loggedIn
  const hasQuota = !!window.tangu?.accountQuota
  // 「Forsion 云端」的账号页 / 额度页由 Extend 渲染半身画:cloudInvoke 在 = 本机装载了 Extend(设备页、网页壳没有)
  const hasCloudPages = !!window.tangu?.cloudInvoke
  // 过期 = token 仍在(loggedIn)但 whoami 判定失效(tokenValid:false)。此时绝不当「已登录」对待。
  const expired = loggedIn && auth?.tokenValid === false
  // 引擎轴(managed 才有,external/纯 Amadeus 形态 backendState=null):与「登没登录」正交。
  // 引擎没 ready 时绝不能只亮「已登录」绿灯——那正是「显示登录了但后端没启动」的老 bug。
  const engineDown = auth?.backendState === 'stopped' || auth?.backendState === 'crashed'
  const engineStarting = auth?.backendState === 'starting'
  const display = auth?.nickname || auth?.username || 'Forsion'
  const initial = display.trim().charAt(0).toUpperCase() || 'F'
  // ── 菜单条目的唯一一份:Web 浮层(下方 JSX)与 Android 原生半屏(lcl nativeSheet 可选宿主)都从这里渲染 ──
  const quotaText = (q: AccountQuotaView | null, failed: boolean): string => q
    ? t('sidebar.account.menu.quotaLine', {
      daily: formatRemaining(remainingPercent(q.dailyLimit, q.dailyRemaining, q.dailyPercent), t('sidebar.account.menu.unlimited')),
      weekly: formatRemaining(remainingPercent(q.weeklyLimit, q.weeklyRemaining, q.weeklyPercent), t('sidebar.account.menu.unlimited')),
    })
    : failed ? t('sidebar.account.menu.quotaFail') : t('sidebar.account.menu.loading')
  const accountItems = (q: AccountQuotaView | null, failed: boolean): Record<'head' | 'login' | 'restart' | 'quota' | 'logout', SheetMenuItem | null> => ({
    // 头部 = 进「Forsion 云端 → 账号」(资料、会员、安全都在那);没有那几页的宿主只是个标题
    head: loggedIn && hasCloudPages ? { id: 'account', label: display, detail: t('sidebar.account.menu.openAccount'), run: () => { setMenu(null); openCloudPage('account') } } : null,
    login: !loggedIn && !engineDown ? { id: 'login', label: t('sidebar.account.login'), icon: <LogIn size={14} />, disabled: loggingIn, run: () => { setMenu(null); void login() } } : null,
    restart: engineDown ? { id: 'engine-restart', label: t('sidebar.account.engineDown'), icon: <RotateCcw size={14} />, run: () => { setMenu(null); void window.tangu?.backendRestart?.().finally(refresh) } } : null,
    // 一行 AI 额度摘要(口径同全端:剩余向下取整、不足 1% 写 <1%)→「额度与积分」
    quota: loggedIn && hasQuota ? { id: 'quota', label: t('sidebar.account.menu.quota'), detail: quotaText(q, failed), icon: <Gauge size={14} />, disabled: !hasCloudPages, run: () => { setMenu(null); openCloudPage('quota') } } : null,
    logout: loggedIn ? { id: 'logout', label: t('sidebar.account.logout'), icon: <LogOut size={14} />, danger: true, run: () => { setMenu(null); void logout() } } : null,
  })

  /** Android:额度与已存账号先取回(各自最多等 3 秒,与 Web 菜单同一套口径),再呈现原生半屏。
   *  原生菜单不能就地刷新,所以等一下而不是先画「加载中」;超时就照实写「加载中」/「无法加载已登录账号」,不丢行。
   *  没有原生宿主 → false(调用方开 Web 浮层);宿主呈现失败 → 回落 Web 浮层。 */
  const openNativeMenu = (el: HTMLElement): boolean => {
    if (!nativeSheetPresenter()) return false
    setQuotaErr(false)
    setQuota(null)
    const request = ++quotaRequest.current
    const within = <T,>(p: Promise<T>, fallback: T): Promise<T> => Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), 3000))])
    const quotaP = auth?.loggedIn && window.tangu?.accountQuota
      ? within(window.tangu.accountQuota().then(
        (res) => (res?.status === 200 && res.json ? { q: res.json as AccountQuotaView, failed: false } : { q: null, failed: true }),
        () => ({ q: null, failed: true }),
      ), { q: null as AccountQuotaView | null, failed: false })
      : Promise.resolve({ q: null as AccountQuotaView | null, failed: false })
    const accountsP: Promise<{ accounts: AuthAccountInfo[]; failed: boolean; loaded: boolean }> = window.tangu?.authAccounts
      ? within(window.tangu.authAccounts().then((accounts) => ({ accounts, failed: false, loaded: true }), () => ({ accounts: [], failed: true, loaded: false })), { accounts: [], failed: true, loaded: false })
      : Promise.resolve({ accounts: [], failed: false, loaded: false })
    void Promise.all([quotaP, accountsP]).then(([qr, ar]) => {
      if (request !== quotaRequest.current) return true // 期间登录态变了 / 又点了一次:这一份作废
      if (qr.q) { setQuota(qr.q); publishAccountQuota(qr.q) } else if (qr.failed) setQuotaErr(true)
      const it = accountItems(qr.q, qr.failed)
      const switcher = accountSwitcherModel({ ...ar, busy: loggingIn, onSelect: (id) => void login(id), onAdd: () => void login(), t })
      const sections: SheetMenuSection[] = [
        { items: [it.head, it.login, it.restart, it.quota].filter((x): x is SheetMenuItem => !!x) },
        ...(switcher ? [{ title: switcher.title, items: switcher.items, ...(switcher.failedNote ? { footer: switcher.failedNote } : {}) }] : []),
        { items: it.logout ? [it.logout] : [] },
      ]
      return runNativeSheetMenu({ ...(it.head ? {} : { title: loggedIn ? display : t('sidebar.account.notSignedIn') }), sections })
    }).then((handled) => { if (!handled) openMenu(el) })
    return true
  }
  const showMenu = (el: HTMLElement): void => { if (!openNativeMenu(el)) openMenu(el) }

  // 引擎未运行 → 点击重启引擎;过期 → 重新登录;已登录(有效)→ 弹账号菜单(无 IPC 则直开账号中心);未登录 → 登录。
  const activate = (e: React.MouseEvent | React.KeyboardEvent): void => {
    if (window.tangu?.authAccounts) { showMenu(e.currentTarget as HTMLElement); return }
    if (engineDown) { void window.tangu?.backendRestart?.().finally(refresh); return }
    if (!loggedIn || expired) { void login(); return }
    if (window.tangu?.accountQuota || window.tangu?.forsionLogin) showMenu(e.currentTarget as HTMLElement)
    else if (hasCloudPages) openCloudPage('account')
  }
  const stateClass = engineDown ? ' engine-down' : expired ? ' expired' : ''
  const subText = engineDown ? t('sidebar.account.engineDown')
    : engineStarting ? t('sidebar.account.engineStarting')
    : expired ? t('sidebar.account.expired')
    : loggedIn ? '' : t('sidebar.account.loginSub')

  const avatarEl = loggedIn && auth?.avatar && !imgError ? (
    <img className="account-avatar" src={auth.avatar} alt="" onError={() => setImgError(true)} />
  ) : (
    <span className="account-avatar fallback">{loggingIn ? <Loader2 size={14} className="spin" /> : initial}</span>
  )

  const webItems = accountItems(quota, quotaErr)
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
      {/* 头部 = 进「Forsion 云端 → 账号」(资料、会员、安全都在那);没有那几页的宿主只是个标题 */}
      <div
        className={`ap-head${loggedIn && hasCloudPages ? ' ap-head--link' : ''}`}
        {...(loggedIn && hasCloudPages ? {
          role: 'button', tabIndex: 0, title: t('sidebar.account.menu.openAccount'),
          onClick: webItems.head?.run,
          onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); webItems.head?.run?.() } },
        } : {})}
      >
        {avatarEl}
        {/* 没登录时别把品牌名当账号名写在头部 —— 看着像「已用名为 Forsion 的账号登录」(W-01) */}
        <span className="ap-name">{loggedIn ? display : t('sidebar.account.notSignedIn')}</span>
        {loggedIn && <TierBadge tier={auth?.membershipTier} />}
        {loggedIn && hasCloudPages && <ChevronRight size={13} className="ap-head-go" aria-hidden="true" />}
      </div>
      {[webItems.login, webItems.restart].map((it) => it && (
        <button key={it.id} className="ap-item" disabled={it.disabled} onClick={it.run}>
          {it.icon}<span>{it.label}</span>
        </button>
      ))}
      {webItems.quota && (
        <button className="ap-item" disabled={webItems.quota.disabled} onClick={webItems.quota.run}>
          {webItems.quota.icon}<span>{webItems.quota.label}</span><span className="grow" />
          <span className="ap-dim">{webItems.quota.detail}</span>
        </button>
      )}
      <AccountSwitcher menu busy={loggingIn} onSelect={(id) => void login(id)} onAdd={() => void login()} />
      {webItems.logout && <button className="ap-item ap-danger" onClick={webItems.logout.run}>
        {webItems.logout.icon}<span>{webItems.logout.label}</span>
      </button>}
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
        title={engineDown ? t('sidebar.account.engineDown') : engineStarting ? t('sidebar.account.engineStarting') : expired ? t('sidebar.account.expired') : loggedIn ? display : t('sidebar.account.loginHint')}
        onClick={activate}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(e) } }}
      >
        {avatarEl}
        <span className="account-meta">
          <span className="account-name-row">
            <span className="account-name">{loggedIn ? display : (loggingIn ? t('sidebar.account.loggingIn') : t('sidebar.account.login'))}</span>
          </span>
          {/* 第二行(用户拍板 2026-08-13):正常登录态只放会员标识,不再写「用户中心」。
              引擎未运行 / 登录过期 / 未登录这几档是**状态提示**,卡上没别的地方说得了,照旧走 subText。
              free 用户 TierBadge 恒返回 null(对齐 AI Studio),此时第二行就是空的,卡自然变矮。 */}
          {loggedIn && !expired && !engineDown && !engineStarting
            ? <TierBadge tier={auth?.membershipTier} />
            : <span className="account-sub">{subText}</span>}
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
