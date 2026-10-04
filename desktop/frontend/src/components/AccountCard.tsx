/**
 * 侧栏左下角 Forsion 账号卡(forsion-ui UserProfileCard 规范):
 *  - 已登录:36px 头像(URL,或渐变圆+首字母)+ 昵称 + 会员徽章(TierBadge);
 *    点击弹出账号菜单:头部(→ 设置「Forsion 云端 → 账号」)、AI 额度(点开看今日 / 本周 / 后台额度、用额度重置卡、
 *    升级会员、去「额度与积分」)、背包、切换账号、退出登录。邀请、网页个人中心在 Extend 画的那几页里。悬停露出「退出登录」。
 *    09-28 曾把额度详情和用卡收进设置页,09-29 用户要回:额度随手看、卡随手用,用完弹用卡动画。
 *  - 未登录:头像占位 + 「登录 / 注册」+ 副标题「点击登录」;不登录 Tangu 也能正常用。
 * 自管 authStatus(挂载即拉 + 监听 auth:device 推登录链接);登录/登出后回调 onAuthChange 让上层重连。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { OverlayAt, nativeSheetPresenter, runNativeSheetMenu, type SheetMenuItem, type SheetMenuSection } from '@lcl/engine'
import { LogIn, LogOut, Loader2, Gauge, ChevronDown, ChevronRight, RotateCcw, ExternalLink, Backpack } from 'lucide-react'
import type { AuthAccountInfo, AuthStatusInfo } from '../types'
import { registerMessages, useI18n } from '../i18n'
import { TierBadge } from './TierBadge'
import { track } from '../achievements/store'
import { AccountSwitcher, accountSwitcherModel } from './AccountSwitcher'
import { formatRemaining, publishAccountQuota, remainingPercent, type AccountQuotaView } from '../services/accountQuota'
import { useApp } from '../stores/appStore'
import { museAvailable } from '../features/runtime'
import { presentResetCardCeremony } from './ResetCardCeremony'
import { usePluginStore } from '../amadeus/plugins/pluginStore'

registerMessages({
  'sidebar.account.notSignedIn': { zh: '未登录', en: 'Not signed in' },
  'sidebar.account.loginLink': { zh: '登录链接', en: 'Sign-in link' },
  'sidebar.account.menu.quota': { zh: 'AI 额度', en: 'AI quota' },
  'sidebar.account.menu.quotaLine': { zh: '今日 {daily} · 本周 {weekly}', en: 'Today {daily} · This week {weekly}' },
  'sidebar.account.menu.openAccount': { zh: '账号设置', en: 'Account settings' },
  'sidebar.account.menu.backpack': { zh: '背包', en: 'Backpack' },
  'sidebar.account.menu.background': { zh: '后台额度', en: 'Background quota' },
  'sidebar.account.menu.backgroundHint': {
    zh: '主额度之外额外的一份，只计 Muse 与自动化用云端默认后台模型的用量',
    en: 'An extra allowance on top of your main quota, used only by Muse and automations on the cloud default background model',
  },
  'sidebar.account.menu.resetOn': { zh: '{date} 重置', en: 'Resets {date}' },
  'sidebar.account.menu.useCard': { zh: '使用额度重置卡（{n} 张）', en: 'Use a quota reset card ({n} left)' },
  'sidebar.account.menu.useCardConfirm': { zh: '再点一次确认使用', en: 'Click again to confirm' },
  'sidebar.account.menu.noCard': { zh: '没有可用的额度重置卡', en: 'No quota reset card available' },
  'sidebar.account.menu.useCardFail': { zh: '额度重置卡使用失败', en: "Couldn't use the quota reset card" },
  'sidebar.account.menu.upgrade': { zh: '升级会员', en: 'Upgrade membership' },
  'sidebar.account.menu.more': { zh: '额度与积分', en: 'Quota and points' },
})

/** 后台额度两轴里更紧的那个的剩余百分比;两轴都不限 → null。 */
const tighter = (...pcts: Array<number | null>): number | null => {
  const axes = pcts.filter((x): x is number => x !== null)
  return axes.length ? Math.min(...axes) : null
}
/** 周重置日是北京日历日的纯日期串:手工拆,不过 new Date()(按 UTC 解析,西时区会少一天)。 */
const shortDate = (d?: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || '')
  return m ? `${Number(m[2])}/${Number(m[3])}` : ''
}

/** 「Forsion 云端」里 Extend 画的子页(registerSettingsView category 'forsion')。没有 Extend 的设备页 / 旧宿主不给跳。 */
const openCloudPage = (id: 'account' | 'quota' | 'backpack'): void =>
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
  const hasBackpackPage = usePluginStore((s) => s.activeIds.includes('forsion-extend') &&
    s.settingsViews.some((v) => v.pluginId === 'forsion-extend' && v.item.id === 'backpack' && v.item.category === 'forsion'))
  const [quotaOpen, setQuotaOpen] = useState(false)
  const [confirmCard, setConfirmCard] = useState(false)
  const [usingCard, setUsingCard] = useState(false)
  const authRequest = useRef(0)
  const authAction = useRef(0)
  const actionBusy = useRef(false)
  const quotaRequest = useRef(0)
  /** 账号代次:只在登录 / 切号 / 登出时变。用卡结果只在换了账号时才丢 —— 关掉再开菜单不能丢(会按旧张数再点、多耗一张)。 */
  const accountGen = useRef(0)

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
      ++accountGen.current
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
    ++accountGen.current
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
    ++accountGen.current
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
    setQuotaOpen(false) // 同 09-28 前:每次打开从收起的一行摘要起步
    setConfirmCard(false)
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

  // 两击确认(防误耗);成功就关菜单、弹用卡动画。失败不一定没核销(服务端先核销再读额度,回包可能丢)→ 关菜单,
  // 下次打开重拉张数,免得照旧张数再点一次多用一张。在途期间 usingCard 一直锁着按钮(关掉再开菜单也锁着),
  // 结果只在换了账号时丢;菜单这时开着就顺手换上回包里的新额度(Codex 评审 P1)
  const useCard = async (): Promise<void> => {
    if (usingCard || !quota) return
    if (!confirmCard) { setConfirmCard(true); return }
    setUsingCard(true)
    const gen = accountGen.current
    const before = quota
    try {
      const r = await window.tangu?.accountUseResetCard?.('both')
      if (gen !== accountGen.current) return
      ++quotaRequest.current // 在途的额度 GET 作废:它可能比用卡早读到旧张数
      setMenu(null)
      if (r?.status === 200 && r.json?.success) {
        const next = { ...(r.json.quota || {}), resetCards: r.json.resetCards } as AccountQuotaView
        setQuota(next)
        publishAccountQuota(next)
        presentResetCardCeremony({ scope: 'both', before, after: next, remainingCards: r.json.resetCards })
      } else {
        onToast?.(r?.json?.error === 'no_reset_card' ? t('sidebar.account.menu.noCard') : String(r?.json?.detail || t('sidebar.account.menu.useCardFail')), true)
      }
    } catch (e: any) {
      if (gen === accountGen.current) { setMenu(null); onToast?.(String(e?.message || e), true) }
    } finally {
      setUsingCard(false)
      setConfirmCard(false)
    }
  }

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
  const accountItems = (q: AccountQuotaView | null, failed: boolean): Record<'head' | 'login' | 'restart' | 'quota' | 'backpack' | 'upgrade' | 'logout', SheetMenuItem | null> => ({
    // 头部 = 进「Forsion 云端 → 账号」(资料、会员、安全都在那);没有那几页的宿主只是个标题
    head: loggedIn && hasCloudPages ? { id: 'account', label: display, detail: t('sidebar.account.menu.openAccount'), run: () => { setMenu(null); openCloudPage('account') } } : null,
    login: !loggedIn && !engineDown ? { id: 'login', label: t('sidebar.account.login'), icon: <LogIn size={14} />, disabled: loggingIn, run: () => { setMenu(null); void login() } } : null,
    restart: engineDown ? { id: 'engine-restart', label: t('sidebar.account.engineDown'), icon: <RotateCcw size={14} />, run: () => { setMenu(null); void window.tangu?.backendRestart?.().finally(refresh) } } : null,
    // 一行 AI 额度摘要(口径同全端:剩余向下取整、不足 1% 写 <1%)→「额度与积分」
    quota: loggedIn && hasQuota ? { id: 'quota', label: t('sidebar.account.menu.quota'), detail: quotaText(q, failed), icon: <Gauge size={14} />, disabled: !hasCloudPages, run: () => { setMenu(null); openCloudPage('quota') } } : null,
    // 背包 / 升级:Web 浮层里住在别处(背包一行、升级在额度展开区),原生半屏不能就地展开 → 各占一行,免得安卓静默少入口。
    backpack: loggedIn && hasCloudPages && hasBackpackPage ? { id: 'backpack', label: t('sidebar.account.menu.backpack'), icon: <Backpack size={14} />, run: () => { setMenu(null); openCloudPage('backpack') } } : null,
    upgrade: loggedIn && window.tangu?.openPayCenter ? { id: 'upgrade', label: t('sidebar.account.menu.upgrade'), icon: <ExternalLink size={14} />, run: () => { setMenu(null); void window.tangu?.openPayCenter?.() } } : null,
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
        { items: [it.head, it.login, it.restart, it.quota, it.backpack, it.upgrade].filter((x): x is SheetMenuItem => !!x) },
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
      {!loggedIn && !engineDown && <button className="ap-item" disabled={loggingIn} onClick={() => { setMenu(null); void login() }}>
        <LogIn size={14} /><span>{t('sidebar.account.login')}</span>
      </button>}
      {engineDown && <button className="ap-item" onClick={() => { setMenu(null); void window.tangu?.backendRestart?.().finally(refresh) }}>
        <RotateCcw size={14} /><span>{t('sidebar.account.engineDown')}</span>
      </button>}
      {/* AI 额度:收起时一行摘要,点开看各项、用卡、升级(数字口径同全端 formatRemaining,每个数字只出现一次) */}
      {loggedIn && hasQuota && (() => {
        const unlimited = t('sidebar.account.menu.unlimited')
        const daily = quota ? remainingPercent(quota.dailyLimit, quota.dailyRemaining, quota.dailyPercent) : null
        const weekly = quota ? remainingPercent(quota.weeklyLimit, quota.weeklyRemaining, quota.weeklyPercent) : null
        const bg = quota?.background
        const bgPct = bg ? tighter(remainingPercent(bg.dailyLimit, bg.dailyRemaining, bg.dailyPercent), remainingPercent(bg.weeklyLimit, bg.weeklyRemaining, bg.weeklyPercent)) : null
        const cards = Math.max(0, Number(quota?.resetCards) || 0)
        const resetDate = quota && quota.weeklyLimit >= 0 ? shortDate(quota.weeklyResetAt) : ''
        return <>
          <button className="ap-item" aria-expanded={quotaOpen} onClick={() => { setQuotaOpen((v) => !v); setConfirmCard(false) }}>
            <Gauge size={14} /><span>{t('sidebar.account.menu.quota')}</span><span className="grow" />
            {!quotaOpen && <span className="ap-dim">
              {quota
                ? t('sidebar.account.menu.quotaLine', { daily: formatRemaining(daily, unlimited), weekly: formatRemaining(weekly, unlimited) })
                : quotaErr ? t('sidebar.account.menu.quotaFail') : t('sidebar.account.menu.loading')}
            </span>}
            {quotaOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
          {quotaOpen && <div className="ap-usage" data-testid="account-quota-detail">
            {quota ? <>
              <div className="ap-row"><span>{t('sidebar.account.menu.daily')}</span><span className="grow" /><b>{formatRemaining(daily, unlimited)}</b></div>
              <div className="ap-row">
                <span>{t('sidebar.account.menu.weekly')}</span><span className="grow" /><b>{formatRemaining(weekly, unlimited)}</b>
                {!!resetDate && <span className="ap-dim">{t('sidebar.account.menu.resetOn', { date: resetDate })}</span>}
              </div>
              {/* 后台额度:Muse 只在桌面本地引擎跑;服务端没配计入模型 → 不显示 */}
              {museAvailable() && !!bg?.modelId && (
                <div className="ap-row" data-row="background" title={t('sidebar.account.menu.backgroundHint')}>
                  <span>{t('sidebar.account.menu.background')}</span><span className="grow" /><b>{formatRemaining(bgPct, unlimited)}</b>
                </div>
              )}
            </> : <div className="ap-row ap-dim">{quotaErr ? t('sidebar.account.menu.quotaFail') : t('sidebar.account.menu.loading')}</div>}
            {cards > 0 && !!window.tangu?.accountUseResetCard && (
              <button className="ap-item ap-sub-item" disabled={usingCard} onClick={() => void useCard()}>
                <RotateCcw size={12} className={usingCard ? 'spin' : undefined} />
                <span>{confirmCard ? t('sidebar.account.menu.useCardConfirm') : t('sidebar.account.menu.useCard', { n: String(cards) })}</span>
              </button>
            )}
            {/* 升级入口不依赖额度接口成败 */}
            {!!window.tangu?.openPayCenter && (
              <button className="ap-item ap-sub-item" onClick={() => { setMenu(null); void window.tangu?.openPayCenter?.() }}>
                <span>{t('sidebar.account.menu.upgrade')}</span><span className="grow" /><ExternalLink size={12} />
              </button>
            )}
            {hasCloudPages && (
              <button className="ap-item ap-sub-item" onClick={() => { setMenu(null); openCloudPage('quota') }}>
                <span>{t('sidebar.account.menu.more')}</span><span className="grow" /><ChevronRight size={12} />
              </button>
            )}
          </div>}
        </>
      })()}
      {loggedIn && hasCloudPages && hasBackpackPage && (
        <button className="ap-item" onClick={() => { setMenu(null); openCloudPage('backpack') }}>
          <Backpack size={14} /><span>{t('sidebar.account.menu.backpack')}</span>
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
