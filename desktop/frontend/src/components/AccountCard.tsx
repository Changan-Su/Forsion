/**
 * 侧栏左下角 Forsion 账号卡(forsion-ui UserProfileCard 规范):
 *  - 已登录:36px 头像(URL,或渐变圆+首字母)+ 昵称 + 会员徽章(TierBadge);
 *    点击弹出账号菜单:头部(→ 设置「Forsion 云端 → 账号」)、AI 额度(点开看今日 / 本周 / 后台额度、用额度重置卡、
 *    升级会员、去「额度与积分」)、背包、切换账号、退出登录。邀请、网页个人中心在 Extend 画的那几页里。悬停露出「退出登录」。
 *    Android 原生外壳下这张菜单还带「设置」「Forsion Unit 切换」两行(左栏没有底部那一排,用户 2026-10-05 拍板;见 accountMenuRows)。
 *    09-28 曾把额度详情和用卡收进设置页,09-29 用户要回:额度随手看、卡随手用,用完弹用卡动画。
 *  - 未登录:头像占位 + 「登录 / 注册」+ 副标题「点击登录」;不登录 Tangu 也能正常用。
 * 自管 authStatus(挂载即拉 + 监听 auth:device 推登录链接);登录/登出后回调 onAuthChange 让上层重连。
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import { OverlayAt, accountMenuRows, openPanel, nativeSheetPresenter, runNativeSheetMenu, type Droplet, type SheetMenuItem, type SheetMenuSection } from '@lcl/engine'
import { LogIn, LogOut, Loader2, Gauge, ChevronDown, ChevronRight, RotateCcw, ExternalLink, Backpack, Gift } from 'lucide-react'
import type { AuthAccountInfo, AuthStatusInfo } from '../types'
import { registerMessages, useI18n } from '../i18n'
import { TierBadge } from './TierBadge'
import { track } from '../achievements/store'
import { AccountSwitcher, accountSwitcherModel } from './AccountSwitcher'
import { formatRemaining, mergeQuotaView, pointsReadToken, reconcilePointsRead, publishAccountQuota, remainingPercent, type AccountQuotaView } from '../services/accountQuota'
import { loadAccountRewards, emptyAccountRewards, ACCOUNT_REWARDS_CHANGED, type AccountRewards } from '../services/accountRewards'
import { accountChip, publishAccountChip, type AccountChip } from '../services/accountChip'
import { useApp } from '../stores/appStore'
import { accountBridgeAvailable, museAvailable } from '../features/runtime'
import { presentResetCardCeremony } from './ResetCardCeremony'
import { usePluginStore } from '../amadeus/plugins/pluginStore'
import { AccountUnitSection, unitPanelAvailable, unitPanelForcesMenu } from './AccountUnitSection'
import { quotaPromptTelemetry } from '../telemetrySend'
import { LocalUnitIcon, useLocalUnits } from './localUnits'
import { LocalUnitDialogHost } from './LocalUnitDialogs'

registerMessages({
  'sidebar.account.notSignedIn': { zh: '未登录', en: 'Not signed in' },
  'sidebar.account.loginLink': { zh: '登录链接', en: 'Sign-in link' },
  'sidebar.account.menu.quota': { zh: 'AI 额度', en: 'AI quota' },
  'sidebar.account.menu.quotaToday': { zh: '今日 {pct}', en: 'Today {pct}' },
  'sidebar.account.menu.quotaWeek': { zh: '本周 {pct}', en: 'This week {pct}' },
  'sidebar.account.menu.pointsLabel': { zh: '积分', en: 'Points' },
  'sidebar.account.menu.openAccount': { zh: '账号设置', en: 'Account settings' },
  'sidebar.account.menu.backpack': { zh: '背包', en: 'Backpack' },
  'sidebar.account.menu.points': { zh: '{n} 积分', en: '{n} points' },
  'sidebar.account.menu.invite': { zh: '邀请奖励', en: 'Invite rewards' },
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
  'sidebar.account.menu.more': { zh: '会员与用量', en: 'Membership & usage' },
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
const openCloudPage = (id: 'account' | 'quota' | 'backpack' | 'points#invite'): void =>
  useApp.getState().openSettings(`forsion/fx:forsion-extend:${id}` as Parameters<ReturnType<typeof useApp.getState>['openSettings']>[0])

/** 账号卡(Ribbon 的 rb-account)挂不挂。bootstrapEngine 与界面台架共用这一份。
 *  有账号能力(accountBridgeAvailable)就挂;没有 Extend 时,头像面板里有本机多 Unit 也挂(unitPanelForcesMenu:只在主窗、
 *  不在设备页 / 网页主入口 / 手机)—— 新建的文件夹 Unit 没装 Extend、没登录,不挂卡就回不到这台电脑,也加不了 Unit。
 *  委托管理员:这一页的「账号」是那台设备,不是来访的管理员 —— 恒不挂。 */
export function accountCardWanted(delegatedAdmin: boolean): boolean {
  if (delegatedAdmin) return false
  return accountBridgeAvailable() || unitPanelForcesMenu()
}

export const AccountCard: React.FC<{
  onToast?: (text: string, error?: boolean) => void
  onAuthChange?: () => void
  /** ribbon 紧凑态:只渲染头像钮(点击→个人中心/登录),无昵称/徽章/登出行。 */
  compact?: boolean
}> = ({ onToast, onAuthChange, compact }) => {
  const { t, locale } = useI18n()
  const [auth, setAuth] = useState<AuthStatusInfo | null>(null)
  const [loggingIn, setLoggingIn] = useState(false)
  const [imgError, setImgError] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; anchorTop: number } | null>(null)
  const [quota, setQuota] = useState<AccountQuotaView | null>(null)
  const [quotaErr, setQuotaErr] = useState(false)
  const [rewards, setRewards] = useState<AccountRewards>(emptyAccountRewards)
  const rewardsRequest = useRef(0)
  const pages = usePluginStore(useShallow((s) => {
    const active = s.activeIds.includes('forsion-extend')
    const hasSettingsPage = (id: string) => active &&
      s.settingsViews.some((v) => v.pluginId === 'forsion-extend' && v.item.id === id && v.item.category === 'forsion')
    return {
      account: hasSettingsPage('account'),
      quota: hasSettingsPage('quota'),
      backpack: hasSettingsPage('backpack'),
      points: hasSettingsPage('points'),
      membership: active && s.plugins.some((p) => p.id === 'forsion-extend' && p.locked) &&
        s.storeViews.some((v) => v.pluginId === 'forsion-extend' && v.item.id === 'membership'),
    }
  }))
  const [quotaOpen, setQuotaOpen] = useState(false)
  const [confirmCard, setConfirmCard] = useState(false)
  const [usingCard, setUsingCard] = useState(false)
  const authRequest = useRef(0)
  const authAction = useRef(0)
  const actionBusy = useRef(false)
  const quotaRequest = useRef(0)
  /** 账号代次:只在登录 / 切号 / 登出时变。用卡结果只在换了账号时才丢 —— 关掉再开菜单不能丢(会按旧张数再点、多耗一张)。 */
  const accountGen = useRef(0)
  // 本机多 Unit:头像角标要在面板没开时就知道「我在不在文件夹 Unit 里」,挂载就拉一次快照(之后跟 onChanged)。
  // 只在主窗拉(unitPanelForcesMenu 含主窗判定):主进程只接主窗的调用,Unit 窗里那枚隐藏的账号卡不白问。
  const localSelf = useLocalUnits((s) => s.snapshot?.self)
  useEffect(() => { if (unitPanelForcesMenu()) void useLocalUnits.getState().refresh() }, [])

  const clearRewards = (): void => { ++rewardsRequest.current; setRewards(emptyAccountRewards()) }
  const refreshRewards = useCallback(async (): Promise<AccountRewards> => {
    const request = ++rewardsRequest.current
    const gen = accountGen.current
    const next = await loadAccountRewards()
    if (request === rewardsRequest.current && gen === accountGen.current) setRewards(next)
    return next
  }, [])

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
      clearRewards()
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
      ++rewardsRequest.current
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
    clearRewards()
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
    clearRewards()
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
  /** 这次菜单锚在哪(缺省账号卡;设备页的框里是宿主画的那枚头像,见 accountChip.activate(anchor))。 */
  const menuAnchorRef = useRef<HTMLElement | null>(null)
  const openMenu = (el: HTMLElement): void => {
    menuAnchorRef.current = el
    const r = el.getBoundingClientRect()
    // 往哪边开、高度封多少都交给 OverlayAt(下面 menuEl):先试锚点下方,放不下翻到上方 —— 侧栏底部的账号卡往上开,
    // Chat 头像资料卡里点「账号」(锚在消息头像上)锚在顶上时往下开。别在这里自己拿窗口高度算(overlayPlacement.guard)。
    // 原来一律往上开、Unit 段高度按锚点上方算:锚在顶上时只剩几十 px,菜单被压扁、各行叠在一起。
    setMenu({ x: r.left, y: r.bottom + 4, anchorTop: r.top })
    setQuotaOpen(false) // 同 09-28 前:每次打开从收起的一行摘要起步
    setConfirmCard(false)
    setQuotaErr(false)
    setQuota(null) // 每次打开都从「加载中」起步,别让上一次的旧数据把失败盖成正常(codex#10)
    const request = ++quotaRequest.current
    clearRewards()
    if (!auth?.loggedIn) return
    void refreshRewards()
    const pointsToken = pointsReadToken()
    void window.tangu?.accountQuota?.()
      .then((res) => {
        if (request !== quotaRequest.current) return
        if (res?.status === 200 && res.json) {
          const next = reconcilePointsRead(res.json as AccountQuotaView, pointsToken)
          setQuota(next)
          publishAccountQuota(next)
        } else setQuotaErr(true)
      })
      .catch(() => { if (request === quotaRequest.current) setQuotaErr(true) })
  }
  // 液滴(2026-11-05 水滴复用第一批,DESIGN §3):卡片从头像里流出来;点别处 / Esc / 失焦 / 再点头像 = 倒放缩回。
  // 登录、退出、用卡这些动作照旧直接 setMenu(null)(马上有别的事要发生),液滴在下面的 layout effect 里清场。
  const popRef = useRef<HTMLDivElement | null>(null)
  const drop = useRef<Droplet | null>(null)
  const dropClosing = useRef(false)
  const dismissMenu = (): void => {
    const d = drop.current
    if (!d) { setMenu(null); return }
    if (dropClosing.current) return
    dropClosing.current = true
    void d.retract().then(() => { if (drop.current === d) setMenu(null) })
  }
  const menuOpen = !!menu
  // 匿名遥测 v3:头像菜单里的额度详情展开 = 额度提示露出一次(展开 / 收起来回点各算一次;同一次展开里重渲染不算)
  const quotaShown = menuOpen && quotaOpen
  useEffect(() => { if (quotaShown) quotaPromptTelemetry('avatar-menu', 'shown') }, [quotaShown])
  useEffect(() => {
    if (!menuOpen || !auth?.loggedIn) return
    const changed = (): void => { void refreshRewards() }
    window.addEventListener('focus', changed)
    window.addEventListener(ACCOUNT_REWARDS_CHANGED, changed)
    return () => { window.removeEventListener('focus', changed); window.removeEventListener(ACCOUNT_REWARDS_CHANGED, changed) }
  }, [menuOpen, auth?.loggedIn, refreshRewards])
  const pour = (el: HTMLElement): void => {
    drop.current?.cancel(); drop.current = null; dropClosing.current = false
    const anchor = menuAnchorRef.current?.isConnected ? menuAnchorRef.current : anchorRef.current
    const src = anchor?.querySelector<HTMLElement>('.account-avatar') ?? anchor
    if (src) drop.current = openPanel(src, el) // 按动效主题:液滴 / 拉伸 / 淡入微缩
  }
  // OverlayAt 在自己的 layout effect 里量完定位、同步写进 DOM(useClampedMenu),父组件这一个在它之后跑 —— 量到的就是最终位置
  useLayoutEffect(() => {
    const el = popRef.current
    if (!menuOpen || !el) { drop.current?.cancel(); drop.current = null; dropClosing.current = false; return }
    if (!drop.current) pour(el)
  }, [menuOpen])
  useEffect(() => () => { drop.current?.cancel() }, [])
  useEffect(() => {
    if (!menu) return
    // 按在头像上不算「点别处」:那一下的 click 自己会收(见 activate)
    const onDown = (e: PointerEvent): void => { if (!(e.target instanceof Node && (anchorRef.current?.contains(e.target) || menuAnchorRef.current?.contains(e.target)))) dismissMenu() }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') dismissMenu() }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', dismissMenu)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', dismissMenu)
    }
  }, [menu]) // eslint-disable-line react-hooks/exhaustive-deps

  // 两击确认(防误耗);成功就关菜单、弹用卡动画。失败不一定没核销(服务端先核销再读额度,回包可能丢)→ 关菜单,
  // 下次打开重拉张数,免得照旧张数再点一次多用一张。在途期间 usingCard 一直锁着按钮(关掉再开菜单也锁着),
  // 结果只在换了账号时丢;菜单这时开着就顺手换上回包里的新额度(Codex 评审 P1)
  const useCard = async (): Promise<void> => {
    if (usingCard || !quota) return
    if (!confirmCard) { setConfirmCard(true); return }
    setUsingCard(true)
    quotaPromptTelemetry('avatar-menu', 'card')
    const gen = accountGen.current
    const before = quota
    const pointsToken = pointsReadToken()
    try {
      const r = await window.tangu?.accountUseResetCard?.('both', 'avatar-menu')
      if (gen !== accountGen.current) return
      ++quotaRequest.current // 在途的额度 GET 作废:它可能比用卡早读到旧张数
      setMenu(null)
      if (r?.status === 200 && r.json?.success) {
        const next = reconcilePointsRead(mergeQuotaView(before, r.json.quota, { resetCards: r.json.resetCards }), pointsToken)
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
  // 登录通道住在 Extend:没装(本机多 Unit 的文件夹 Unit 常见)就不写「登录 Forsion / 点击登录」,也不放点了没反应的登录行,只说「未登录」。
  const canLogin = !!window.tangu?.forsionLogin
  const hasQuota = !!window.tangu?.accountQuota
  // Extend registers pages in the official Web app without exposing desktop IPC.
  const desktopCloud = !!window.tangu?.cloudInvoke
  const publicWeb = !!window.tangu?.unitPublicEntry
  const cloudPages = desktopCloud || (!!window.tangu?.cloudFetch && (pages.points || pages.backpack))
  const hasAccountPage = cloudPages || (publicWeb && pages.account)
  const hasQuotaPage = cloudPages || (publicWeb && pages.quota)
  const hasBackpackPage = (cloudPages || publicWeb) && pages.backpack
  const hasPointsPage = (cloudPages || publicWeb) && pages.points
  const openPayCenter = window.tangu?.openPayCenter
  const upgrade = openPayCenter ? () => { quotaPromptTelemetry('avatar-menu', 'upgrade'); void openPayCenter({ entry: 'avatar-menu' }) }
    : publicWeb && pages.membership && window.tangu?.marketList
      ? () => useApp.getState().openMarket(undefined, { storeView: 'forsion-extend:membership', nonce: Date.now() })
      : null
  // 过期 = token 仍在(loggedIn)但 whoami 判定失效(tokenValid:false)。此时绝不当「已登录」对待。
  const expired = loggedIn && auth?.tokenValid === false
  // 引擎轴(managed 才有,external/纯 Amadeus 形态 backendState=null):与「登没登录」正交。
  // 引擎没 ready 时绝不能只亮「已登录」绿灯——那正是「显示登录了但后端没启动」的老 bug。
  const engineDown = auth?.backendState === 'stopped' || auth?.backendState === 'crashed'
  const engineStarting = auth?.backendState === 'starting'
  const display = auth?.nickname || auth?.username || 'Forsion'
  const initial = display.trim().charAt(0).toUpperCase() || 'F'
  // ── 菜单条目的唯一一份:Web 浮层(下方 JSX)与 Android 原生半屏(lcl nativeSheet 可选宿主)都从这里渲染 ──
  const fmtPoints = (n: number): string => t('sidebar.account.menu.points', { n: n.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US') })
  /**
   * 积分余额:背包那次读到的优先(积分变动事件会刷新它,和背包那行永远是同一个数),没有再用额度视图带的;
   * 都不知道 = null,别当 0。不夹到 0:后台能调成负数,和背包那行一样照实写。
   */
  const pointsOf = (q: AccountQuotaView | null, r: AccountRewards = rewards): number | null => {
    if (r.balance !== null) return r.balance
    const n = q?.pointsBalance
    return typeof n === 'number' && Number.isFinite(n) ? n : null
  }
  /**
   * 额度一行摘要:只列有上限的那几档(11-20 用户定:不限的不写「不限」);
   * 两档都不限 → 改列积分(额度用完可用积分继续),积分也不知道就留空。
   */
  const quotaSummary = (q: AccountQuotaView, r: AccountRewards = rewards): string => {
    const parts = [
      ['sidebar.account.menu.quotaToday', remainingPercent(q.dailyLimit, q.dailyRemaining, q.dailyPercent)],
      ['sidebar.account.menu.quotaWeek', remainingPercent(q.weeklyLimit, q.weeklyRemaining, q.weeklyPercent)],
    ] as const
    const limited = parts.filter(([, pct]) => pct !== null).map(([key, pct]) => t(key, { pct: formatRemaining(pct, '') }))
    if (limited.length) return limited.join(' · ')
    const points = pointsOf(q, r)
    return points === null ? '' : fmtPoints(points)
  }
  const quotaText = (q: AccountQuotaView | null, failed: boolean, r: AccountRewards = rewards): string => q
    ? quotaSummary(q, r)
    : failed ? t('sidebar.account.menu.quotaFail') : t('sidebar.account.menu.loading')
  const pointsText = (r: AccountRewards): string => r.balance === null ? (r.balanceFailed ? '—' : '…') : fmtPoints(r.balance)
  const accountItems = (q: AccountQuotaView | null, failed: boolean, r = rewards): Record<'head' | 'login' | 'restart' | 'quota' | 'backpack' | 'invite' | 'upgrade' | 'logout', SheetMenuItem | null> => ({
    // 头部 = 进「Forsion 云端 → 账号」(资料、会员、安全都在那);没有那几页的宿主只是个标题
    head: loggedIn && hasAccountPage ? { id: 'account', label: display, detail: t('sidebar.account.menu.openAccount'), run: () => { setMenu(null); openCloudPage('account') } } : null,
    login: !loggedIn && !engineDown && canLogin ? { id: 'login', label: t('sidebar.account.login'), icon: <LogIn size={14} />, disabled: loggingIn, run: () => { setMenu(null); void login() } } : null,
    restart: engineDown ? { id: 'engine-restart', label: t('sidebar.account.engineDown'), icon: <RotateCcw size={14} />, run: () => { setMenu(null); void window.tangu?.backendRestart?.().finally(refresh) } } : null,
    // 一行 AI 额度摘要(口径同全端:剩余向下取整、不足 1% 写 <1%)→「额度与积分」
    quota: loggedIn && hasQuota ? { id: 'quota', label: t('sidebar.account.menu.quota'), detail: quotaText(q, failed, r), icon: <Gauge size={14} />, disabled: !hasQuotaPage, run: () => { setMenu(null); openCloudPage('quota') } } : null,
    // 背包 / 升级:Web 浮层里住在别处(背包一行、升级在额度展开区),原生半屏不能就地展开 → 各占一行,免得安卓静默少入口。
    backpack: loggedIn && hasBackpackPage ? { id: 'backpack', label: t('sidebar.account.menu.backpack'), detail: pointsText(r), icon: <Backpack size={14} />, run: () => { setMenu(null); openCloudPage('backpack') } } : null,
    invite: loggedIn && hasPointsPage && r.invite !== 'hidden' ? { id: 'invite', label: t('sidebar.account.menu.invite'), icon: <Gift size={14} />, run: () => { setMenu(null); openCloudPage('points#invite') } } : null,
    upgrade: loggedIn && upgrade ? { id: 'upgrade', label: t('sidebar.account.menu.upgrade'), icon: openPayCenter ? <ExternalLink size={14} /> : <ChevronRight size={14} />, run: () => { setMenu(null); upgrade() } } : null,
    logout: loggedIn ? { id: 'logout', label: t('sidebar.account.logout'), icon: <LogOut size={14} />, danger: true, run: () => { setMenu(null); void logout() } } : null,
  })

  /** 菜单的几节:额度、已存账号、积分先取回(各自最多等 3 秒),再按 accountItems 排成几节。原生半屏(openNativeMenu)和
   *  手机「我」页(经 accountChip.sections)同一份。期间登录态变了 / 又要了一次 → null(这一份作废)。 */
  const loadSections = (): Promise<{ sections: SheetMenuSection[]; title?: string } | null> => {
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
    clearRewards()
    const rewardsP = auth?.loggedIn ? within(refreshRewards(), emptyAccountRewards()) : Promise.resolve(emptyAccountRewards())
    return Promise.all([quotaP, accountsP, rewardsP]).then(([qr, ar, rr]) => {
      if (request !== quotaRequest.current) return null // 期间登录态变了 / 又点了一次:这一份作废
      if (qr.q) { setQuota(qr.q); publishAccountQuota(qr.q) } else if (qr.failed) setQuotaErr(true)
      const it = accountItems(qr.q, qr.failed, rr)
      const switcher = accountSwitcherModel({ ...ar, busy: loggingIn, onSelect: (id) => void login(id), onAdd: () => void login(), t })
      const sections: SheetMenuSection[] = [
        { items: [it.head, it.login, it.restart, it.quota, it.backpack, it.invite, it.upgrade].filter((x): x is SheetMenuItem => !!x) },
        { items: accountMenuRows() }, // Android 原生外壳:设置、互联设备(左栏没有底部那一排,见 lcl 的 accountMenuRows);其余宿主为空
        ...(switcher ? [{ title: switcher.title, items: switcher.items, ...(switcher.failedNote ? { footer: switcher.failedNote } : {}) }] : []),
        { items: it.logout ? [it.logout] : [] },
      ]
      return { sections, ...(it.head ? {} : { title: loggedIn ? display : t('sidebar.account.notSignedIn') }) }
    })
  }
  /** Android:额度与已存账号先取回(各自最多等 3 秒,与 Web 菜单同一套口径),再呈现原生半屏。
   *  原生菜单不能就地刷新,所以等一下而不是先画「加载中」;超时就照实写「加载中」/「无法加载已登录账号」,不丢行。
   *  没有原生宿主 → false(调用方开 Web 浮层);宿主呈现失败 → 回落 Web 浮层。 */
  const openNativeMenu = (el: HTMLElement): boolean => {
    if (!nativeSheetPresenter()) return false
    void loadSections()
      .then((menu) => (menu ? runNativeSheetMenu({ ...(menu.title ? { title: menu.title } : {}), sections: menu.sections }) : true))
      .then((handled) => { if (!handled) openMenu(el) })
    return true
  }
  const showMenu = (el: HTMLElement): void => { if (!openNativeMenu(el)) openMenu(el) }

  // 引擎未运行 → 点击重启引擎;过期 → 重新登录;已登录(有效)→ 弹账号菜单(无 IPC 则直开账号中心);未登录 → 登录。
  const activateOn = (el: HTMLElement): void => {
    // 菜单里带着设置 / 互联设备时(Android 原生外壳)恒开菜单:未登录、登录过期也得进得了设置 —— 登录是菜单里的一行。
    // 本机多 Unit 同理:新建的文件夹 Unit 没登录,点头像得开得出 Unit 段,才回得到这台电脑(unitPanelForcesMenu)。
    if (window.tangu?.authAccounts || accountMenuRows().length || unitPanelForcesMenu()) { showMenu(el); return }
    if (engineDown) { void window.tangu?.backendRestart?.().finally(refresh); return }
    if (!loggedIn || expired) { void login(); return }
    if (window.tangu?.accountQuota || window.tangu?.forsionLogin) showMenu(el)
    else if (hasAccountPage) openCloudPage('account')
  }
  // 菜单开着时再点头像 = 收起(倒放);正倒放着又点 = 从这一帧掉头、停在打开(同悬浮目录)
  const toggleFrom = (el: HTMLElement): void => {
    if (!menu) { activateOn(el); return }
    if (dropClosing.current && drop.current?.reopen?.()) dropClosing.current = false
    else if (dropClosing.current && popRef.current) pour(popRef.current)
    else dismissMenu()
  }
  const activate = (e: React.MouseEvent | React.KeyboardEvent): void => toggleFrom(e.currentTarget as HTMLElement)
  const stateClass = engineDown ? ' engine-down' : expired ? ' expired' : engineStarting ? ' engine-starting' : ''
  const subText = engineDown ? t('sidebar.account.engineDown')
    : engineStarting ? t('sidebar.account.engineStarting')
    : expired ? t('sidebar.account.expired')
    : loggedIn || !canLogin ? '' : t('sidebar.account.loginSub')

  // 头像的宿主接缝(services/accountChip.ts):Android 原生顶栏把账号入口画成头像,点它 = 点这张卡。
  const stateLabel = engineDown ? t('sidebar.account.engineDown') : engineStarting ? t('sidebar.account.engineStarting') : expired ? t('sidebar.account.expired') : loggedIn ? display : canLogin ? t('sidebar.account.login') : t('sidebar.account.notSignedIn')
  const picture = loggedIn && auth?.avatar && !imgError ? auth.avatar : undefined
  const anchorRef = useRef<HTMLElement | null>(null)
  const activateRef = useRef(toggleFrom)
  activateRef.current = toggleFrom
  const sectionsRef = useRef(loadSections)
  sectionsRef.current = loadSections
  useEffect(() => {
    const mine: AccountChip = {
      label: stateLabel, loggedIn, initial, ...(picture ? { avatar: picture } : {}),
      activate: (anchor) => { const el = anchor ?? anchorRef.current; if (el) activateRef.current(el) },
      sections: () => sectionsRef.current().then((menu) => menu?.sections ?? null),
    }
    publishAccountChip(mine)
    return () => { if (accountChip() === mine) publishAccountChip(null) }
  }, [stateLabel, loggedIn, initial, picture])
  // Tangu 界面(Chat 头像资料卡的「账号」)不能直引宿主的 accountChip(tangu-boundary:Tangu → 宿主的依赖只许减),
  // 走 window 事件:detail.anchor = 菜单锚在哪;preventDefault = 有人接了。事件名在 views/chat2/ProfileCard.tsx 同写一份。
  useEffect(() => {
    const on = (e: Event): void => {
      const anchor = (e as CustomEvent<{ anchor?: HTMLElement }>).detail?.anchor
      const el = anchor?.isConnected ? anchor : anchorRef.current
      if (!el) return
      e.preventDefault()
      activateRef.current(el)
    }
    window.addEventListener('forsion:account-activate', on)
    return () => window.removeEventListener('forsion:account-activate', on)
  }, [])

  const avatarEl = picture ? (
    <img className="account-avatar" src={picture} alt="" onError={() => setImgError(true)} />
  ) : (
    <span className="account-avatar fallback">{loggingIn ? <Loader2 size={14} className="spin" /> : initial}</span>
  )
  // 文件夹 Unit 里(本机多 Unit):左下角头像右下角叠这台 Unit 的图标(同远端 Unit 的角标 .unitfr-badge);默认那台不画。
  // 只叠在侧栏 / Ribbon 那枚上,面板头部那枚是账号本身,不叠。
  const badgedAvatarEl = localSelf?.kind === 'folder' ? (
    <span className="account-avatar-slot" data-local-badge="">
      {avatarEl}
      <span className="unitfr-badge" aria-hidden="true"><LocalUnitIcon icon={localSelf.icon} size={9} /></span>
    </span>
  ) : avatarEl

  const webItems = accountItems(quota, quotaErr)
  // Unit 段(只在真桌面主窗,排在最上面):面板加宽到 320,Unit 多了会比窗口还高 → OverlayAt 带上 boundary(整个窗口),
  // 按锚点上下两侧里空间大的那侧封顶 max-height(既不出窗口、也不压头像),多出来的只滚 Unit 那一段(base.css .account-pop--units)。
  const units = !!menu && unitPanelAvailable()
  // Keep a single fade target, including rows that mount while the panel is animating.
  const menuContent = menu && <div className={units ? 'ap-body' : undefined}>
      {/* Unit 段在最上面(方案图 ②):这台电脑 / 我的设备 / 管理 Unit…,分隔线以下才是账号头部和账号项 */}
      {units && <AccountUnitSection onClose={() => setMenu(null)} onToast={onToast} />}
      {/* 头部 = 进「Forsion 云端 → 账号」(资料、会员、安全都在那);没有那几页的宿主只是个标题 */}
      <div
        className={`ap-head${webItems.head ? ' ap-head--link' : ''}`}
        {...(webItems.head ? {
          role: 'button', tabIndex: 0, title: t('sidebar.account.menu.openAccount'),
          onClick: webItems.head?.run,
          onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); webItems.head?.run?.() } },
        } : {})}
      >
        {avatarEl}
        {/* 没登录时别把品牌名当账号名写在头部 —— 看着像「已用名为 Forsion 的账号登录」(W-01) */}
        <span className="ap-name">{loggedIn ? display : t('sidebar.account.notSignedIn')}</span>
        {loggedIn && <TierBadge tier={auth?.membershipTier} />}
        {webItems.head && <ChevronRight size={13} className="ap-head-go" aria-hidden="true" />}
      </div>
      {!loggedIn && !engineDown && canLogin && <button className="ap-item" disabled={loggingIn} onClick={() => { setMenu(null); void login() }}>
        <LogIn size={14} /><span>{t('sidebar.account.login')}</span>
      </button>}
      {engineDown && <button className="ap-item" onClick={() => { setMenu(null); void window.tangu?.backendRestart?.().finally(refresh) }}>
        <RotateCcw size={14} /><span>{t('sidebar.account.engineDown')}</span>
      </button>}
      {/* AI 额度:收起时一行摘要,点开看各项、用卡、升级(数字口径同全端 formatRemaining,每个数字只出现一次) */}
      {loggedIn && hasQuota && (() => {
        const unlimited = t('sidebar.account.menu.unlimited')
        const points = pointsOf(quota)
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
                ? quotaSummary(quota)
                : quotaErr ? t('sidebar.account.menu.quotaFail') : t('sidebar.account.menu.loading')}
            </span>}
            {quotaOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
          {quotaOpen && <div className="ap-usage" data-testid="account-quota-detail">
            {quota ? <>
              {/* 不限的那档不画(11-20 用户定);积分跟在后面 */}
              {daily !== null && <div className="ap-row" data-row="daily"><span>{t('sidebar.account.menu.daily')}</span><span className="grow" /><b>{formatRemaining(daily, unlimited)}</b></div>}
              {weekly !== null && <div className="ap-row" data-row="weekly">
                <span>{t('sidebar.account.menu.weekly')}</span><span className="grow" /><b>{formatRemaining(weekly, unlimited)}</b>
                {!!resetDate && <span className="ap-dim">{t('sidebar.account.menu.resetOn', { date: resetDate })}</span>}
              </div>}
              {/* 后台额度:Muse 只在桌面本地引擎跑;服务端没配计入模型 / 两轴都不限 → 不显示 */}
              {museAvailable() && !!bg?.modelId && bgPct !== null && (
                <div className="ap-row" data-row="background" title={t('sidebar.account.menu.backgroundHint')}>
                  <span>{t('sidebar.account.menu.background')}</span><span className="grow" /><b>{formatRemaining(bgPct, unlimited)}</b>
                </div>
              )}
              {/* 背包那行已经写着积分就不重复(每个数字只出现一次);没有背包页的宿主才在这里补 */}
              {points !== null && !webItems.backpack && (
                <div className="ap-row" data-row="points">
                  <span>{t('sidebar.account.menu.pointsLabel')}</span><span className="grow" /><b>{points.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US')}</b>
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
            {webItems.upgrade && (
              <button className="ap-item ap-sub-item" onClick={webItems.upgrade.run}>
                <span>{webItems.upgrade.label}</span><span className="grow" />{openPayCenter ? <ExternalLink size={12} /> : <ChevronRight size={12} />}
              </button>
            )}
            {hasQuotaPage && (
              <button className="ap-item ap-sub-item" onClick={() => { quotaPromptTelemetry('avatar-menu', 'more'); setMenu(null); openCloudPage('quota') }}>
                <span>{t('sidebar.account.menu.more')}</span><span className="grow" /><ChevronRight size={12} />
              </button>
            )}
          </div>}
        </>
      })()}
      {webItems.backpack && (
        <button className="ap-item" onClick={() => { setMenu(null); openCloudPage('backpack') }}>
          <Backpack size={14} /><span>{t('sidebar.account.menu.backpack')}</span><span className="grow" /><span className="ap-dim" data-testid="account-points">{pointsText(rewards)}</span>
        </button>
      )}
      {webItems.invite && <button className="ap-item" onClick={webItems.invite.run}>
        <Gift size={14} /><span>{webItems.invite.label}</span><span className="grow" /><ChevronRight size={12} />
      </button>}
      {/* 原生半屏呈现失败时的回落也得有这两行(设置不能两头都没有);桌面 / Web 上 accountMenuRows() 恒空 */}
      {accountMenuRows().map((row) => (
        <button key={row.id} className="ap-item" onClick={() => { setMenu(null); row.run?.() }}>
          {row.icon}<span>{row.label}</span>
        </button>
      ))}
      <AccountSwitcher menu busy={loggingIn} onSelect={(id) => void login(id)} onAdd={() => void login()} />
      {webItems.logout && <button className="ap-item ap-danger" onClick={webItems.logout.run}>
        {webItems.logout.icon}<span>{webItems.logout.label}</span>
      </button>}
  </div>
  const menuEl = menu ? createPortal(
    <OverlayAt
      className={`account-pop${units ? ' account-pop--units' : ''}`}
      innerRef={(el) => { popRef.current = el }}
      x={menu.x}
      y={menu.y}
      anchorTop={menu.anchorTop}
      prefer="below"
      boundary={units ? document.documentElement : undefined}
      margin={8}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {menuContent}
    </OverlayAt>,
    document.body,
  ) : null

  if (compact) {
    return (
      <>
        <button
          ref={(el) => { anchorRef.current = el }}
          className={`ribbon-account${stateClass}`}
          title={stateLabel}
          onClick={activate}
        >
          {badgedAvatarEl}
        </button>
        {menuEl}
        <LocalUnitDialogHost onToast={onToast} />
      </>
    )
  }

  return (
    <>
      <div
        ref={(el) => { anchorRef.current = el }}
        className={`account-card${stateClass}`}
        role="button"
        tabIndex={0}
        title={engineDown ? t('sidebar.account.engineDown') : engineStarting ? t('sidebar.account.engineStarting') : expired ? t('sidebar.account.expired') : loggedIn ? display : canLogin ? t('sidebar.account.loginHint') : t('sidebar.account.notSignedIn')}
        onClick={activate}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(e) } }}
      >
        {badgedAvatarEl}
        <span className="account-meta">
          <span className="account-name-row">
            <span className="account-name">{loggedIn ? display : loggingIn ? t('sidebar.account.loggingIn') : canLogin ? t('sidebar.account.login') : t('sidebar.account.notSignedIn')}</span>
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
      <LocalUnitDialogHost onToast={onToast} />
    </>
  )
}
