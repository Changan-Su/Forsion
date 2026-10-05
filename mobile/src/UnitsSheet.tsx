/**
 * 互联设备(Forsion Unit)移动端弹层 —— P1-K8 起是「在哪运行」:把这台手机上的会话交给账号名下的某台电脑跑。
 * 规格:docs/ToBeImproved/设备能力MCP_P1规格_2026-09-28/K8-mobile-native.md §3.7;K8 独占本文件(INTEGRATION R-28 / R-29)。
 *
 * 自上而下四段:
 *   1. 智库:本地 / 云端 —— 原左栏顶部的「本地 | 云端」胶囊(VaultSideSwitch 的手机分支)。桌面 2026-08-23 就把它并进了
 *      Unit 切换器,手机 2026-10-05 跟上(用户实报「胶囊怎么还在」),排最前 = 桌面的顺序(用户同日拍板)。只有 App 有这座桥
 *      (window.amadeusVaultMode:两个库桥运行时互换);它只换笔记库,与下一段的「在哪运行」是两根轴。
 *   2. 在哪运行:Forsion 云端(缺省)+ 每台电脑一行、带状态(services/deviceStatus.ts 的口径,R-22)。
 *      点一台电脑 = unitsSheetModel.runOn:懒登记本机 → 问那台电脑认不认这台手机(需要就发起确认、轮询)→ 探一次引擎 → 生效。
 *      **生效只走本文件唯一的 selectRunLocation** = K7 的 setDraftLocation(loc, {explicit:true})(R-21:K6-S4 起焦点 = 新会话建在哪)。
 *   3. 打开设备界面(折叠,次要):P0 起的直连 / 中转行与手输地址,行为不变 —— 设备页开在 app 内 WebView(mobileShim.openUnitPage)。
 *   4. 本机:登记状态与「移除本机登记」。P1 起手机登记为 Unit(调用方,kind='phone');P2a 起可作被调用方。
 * 手机(kind='phone')与本机不出现在 2、3 两段:手机没有引擎也没有设备页。kind 缺席的老名册按电脑处理。
 *
 * ⚠️ 本组件也被 web 手机形态经 @mobile/mobileEntry 复用:不许 import capacitor(capacitor-stub-gate,build-unit-web 实翻),
 *    原生能力一律走 window.tangu 上的可选方法(unitsList / unitSelf / unitEnsureSelf / unitForgetSelf / openUnitPage)。
 */
import React, { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { ArrowRight, Check, ChevronDown, Cloud, Laptop, Monitor, MonitorSmartphone, Smartphone, X } from 'lucide-react'
import { addRibbonIcon } from '@lcl/engine'
import { registerMessages, useI18n } from '@/i18n'
import { useApp } from '@/stores/appStore'
import { usePageStore } from '@/amadeus/store/pageStore'
import type { UnitInfo } from '@/types'
import { cloudApiBase, focusRef, onFocusChange } from '@/services/engine/targets'
import { installRunLocationChooser, setDraftLocation } from '@/stores/runLocationStore' // P1-K7a
import { clearDeviceSticky, noteDeviceProbe, noteDeviceSticky } from '@/services/deviceMarks' // P1-K7a
import { HOME_REF, type TargetRef } from '@/services/engine/target'
import { beginAttempt, endAttempts, isRunnableUnit, noteAttempt, NO_MARKS, removeThisPhone, rosterNameOf, rowTone, runOn, runRows, statusKey, type PhoneIssue, type RowMarks, type RunRow } from './unitsSheetModel'
import './unitsSheet.css'

/**
 * 「在哪运行」生效 —— 整个弹层只有这一个出口(单测钉住:scripts/units-sheet-model.test.cjs)。
 * = K7 的 setDraftLocation(ref, { explicit: true })(INTEGRATION R-21):K6-S4 起焦点 = 新会话建在哪,它走 setFocusTarget 并记住
 * 这是用户亲手选的(下次新对话只在那台 ready 时默认回到它,K7 U3)。返回它的 Promise —— 「移除本机」要等切回云端真正生效
 * (旧目标的轮询 / SSE 收掉)后才删身份,见 unitsSheetModel.removeThisPhone。
 * 焦点展示名 = 最近一次拉到的名册里那台的名字(M1B:审批结局行写「在执行的电脑上(名字)」;之前一直没带名字 → 只剩兜底「你的电脑」)。
 */
export function selectRunLocation(ref: TargetRef): Promise<void> {
  return setDraftLocation(ref, { explicit: true, name: rosterNameOf(lastRoster, ref) })
}

/** 最近一次拉到的名册(只给 selectRunLocation 取展示名;弹层关掉后仍留着 —— 「移除本机」切回云端不需要它)。 */
let lastRoster: UnitInfo[] = []

/** 当前运行位置 = 整端焦点(K6-S2)。 */
function currentRunLocation(): TargetRef {
  return focusRef()
}

/** 引导页 = cloudApiBase(含 /api)下的 /units/<id>/open。
 *  `#token=`:App 登录态递交面 —— 系统浏览器没登录过 Forsion 网页版,同源 localStorage 读不到
 *  token(用户实报「明明登录了却提示没登录」)。fragment 不出网络/不进 server 日志(≠ query),
 *  引导页用完即 replaceState 剥掉、不落 localStorage,进隧道仍靠 HttpOnly cookie。 */
const guideUrl = (unitId: string): string => {
  const base = `${cloudApiBase()}/units/${unitId}/open`
  const token = useApp.getState().cfg.token
  return token ? `${base}#token=${encodeURIComponent(token)}` : base
}

registerMessages({
  'unit.mobileNone': { zh: '名下还没有可连的设备：在电脑上登录同一 Forsion 账号，并开启「允许其他设备连接本机」', en: 'No devices yet — sign in with this Forsion account on a computer and enable "Allow other devices to connect".' },
  'unit.mobileTunnel': { zh: '经云端中转打开（自动使用本机登录态）', en: 'Opens via cloud relay (uses this device’s login automatically)' },
  'unitm.runOn': { zh: '在哪运行', en: 'Run on' },
  'unitm.cloud': { zh: 'Forsion 云端', en: 'Forsion cloud' },
  'unitm.cloudDesc': { zh: '默认', en: 'Default' },
  'unitm.current': { zh: '当前', en: 'Current' },
  'unitm.checking': { zh: '正在连接…', en: 'Connecting…' },
  'unitm.ready': { zh: '可用', en: 'Available' },
  'unitm.unknown': { zh: '状态未知', en: 'Status unknown' },
  'unitm.starting': { zh: '引擎正在启动', en: 'Engine is starting' },
  'unitm.engineOff': { zh: '电脑在线，但 Forsion 引擎没有运行', en: "Online, but the Forsion engine isn't running" },
  'unitm.noEngine': { zh: '这台电脑上的 Forsion 没有 Agent 引擎', en: 'Forsion on this computer has no agent engine' },
  'unitm.offline': { zh: '离线', en: 'Offline' },
  'unitm.unreachable': { zh: '暂时连不上，稍后重试', en: "Can't reach it right now. Try again shortly" },
  'unitm.confirmPending': { zh: '请在「{name}」上允许这台手机', en: 'Allow this phone on "{name}"' },
  // 只有用户在那台电脑上点了「不允许」才有 10 分钟冷却;带 reason 的拒绝(严格档 / 名册缺失 …)各用下面的 unitm.reason.*,不许诺它(P1-KF)
  'unitm.confirmDenied': { zh: '「{name}」拒绝了这台手机，10 分钟后可以再次请求', en: '"{name}" declined this phone. You can ask again in 10 minutes' },
  'unitm.confirmNotAsked': { zh: '「{name}」还没有允许这台手机，点按再次请求', en: '"{name}" hasn\'t allowed this phone yet. Tap to ask again' },
  // P1-KF:拒绝体带 reason = 那台电脑上不会弹框 —— 按 reason 说出路,不说「请允许」(shared/remoteSessions.ts TrustReason)
  'unitm.reason.strict': { zh: '「{name}」只允许这类连接查看，不会再询问；请在那台电脑的「设置 › 远程会话」中允许', en: '"{name}" only lets connections like this one view sessions and won\'t ask again. Allow it in Settings › Remote sessions there' },
  'unitm.reason.neverPrompts': { zh: '「{name}」不会为这类连接弹框询问；请在那台电脑的「设置 › 远程会话」中允许', en: '"{name}" doesn\'t ask for connections like this one. Allow it in Settings › Remote sessions there' },
  'unitm.reason.notSignedIn': { zh: '「{name}」没有登录 Forsion，请先在那台电脑上登录', en: '"{name}" isn\'t signed in to Forsion. Sign in there first' },
  'unitm.reason.rosterMiss': { zh: '「{name}」的账号里找不到这台手机，请确认两台设备登录的是同一个账号', en: '"{name}" can\'t find this phone in its account. Make sure both devices use the same account' },
  'unitm.reason.rosterUnreachable': { zh: '「{name}」暂时无法核对这台手机，请稍后再试', en: '"{name}" can\'t check this phone right now. Try again shortly' },
  'unitm.reason.noAnswer': { zh: '「{name}」上没有人回应确认，请稍后再试', en: 'No one answered on "{name}". Try again in a minute' },
  'unitm.reason.busy': { zh: '「{name}」上待确认的请求太多，请稍后再试', en: '"{name}" has too many requests waiting. Try again shortly' },
  'unitm.remoteOff': { zh: '请在「{name}」上开启「允许远程会话」', en: 'Turn on "Allow remote sessions" on "{name}"' },
  'unitm.callerUnavailable': { zh: '这台手机暂时无法证明自己的身份，请稍后重试', en: "This phone couldn't verify its identity. Try again later" },
  'unitm.callerUnsupported': { zh: '服务器版本过旧，暂不支持从手机运行', en: 'The server is too old to run from a phone' },
  'unitm.network': { zh: '暂时连不上 Forsion，请检查网络后重试', en: "Can't reach Forsion right now. Check your connection and try again" },
  'unitm.signedOut': { zh: '登录已失效，请重新登录后再试', en: 'Your sign-in has expired. Sign in again and retry' },
  'unitm.nativeOnly': { zh: '仅在 Forsion 安卓 App 中可用', en: 'Only available in the Forsion Android app' },
  'unitm.vault': { zh: '智库', en: 'Vault' },
  'unitm.vaultLocalDesc': { zh: '笔记存在这台手机上', en: 'Notes are stored on this phone' },
  'unitm.vaultCloudDesc': { zh: '笔记存在云端，各设备都能打开', en: 'Notes are stored in the cloud for all your devices' },
  'unitm.openScreen': { zh: '打开设备界面', en: 'Open device screen' },
  'unitm.thisPhone': { zh: '本机', en: 'This phone' },
  'unitm.registeredAs': { zh: '已登记为「{name}」', en: 'Registered as "{name}"' },
  'unitm.notRegistered': { zh: '尚未登记（首次在电脑上运行时自动登记）', en: 'Not registered yet (happens the first time you run on a computer)' },
  'unitm.forget': { zh: '移除本机登记', en: 'Remove this phone' },
  'unitm.forgetConfirm': { zh: '移除后，各电脑对这台手机的授权都会失效', en: 'Computers will stop trusting this phone after removal' },
  'unitm.forgetDo': { zh: '移除', en: 'Remove' },
})

export const useUnitsSheet = create<{ open: boolean; setOpen: (v: boolean) => void }>((set) => ({
  open: false,
  setOpen: (v) => set({ open: v }),
}))

/** 左抽屉底部常驻入口(设置钮左侧,mobileFoot;曾住「⋯」菜单被用户报太隐蔽 2026-08-30)。
 *  Android 原生外壳下没有那一排:它与设置一起进顶栏头像的菜单(用户 2026-10-05 拍板,见 lcl 的 accountMenuRows)。
 *  数据桥在才上架:App=mobileShim.unitsList;设备页(unitShim)/Tangu Web(webShim)无此桥 → 自然隐藏。
 *  ⚠️ 上架条件同时是 VaultSideSwitch 手机分支「胶囊让位给本弹层」的条件(window.tangu.unitsList):改一处要改两处。 */
export function installUnitsEntry(): void {
  if (!window.tangu?.unitsList) return
  // P1-K7a:新对话的「在哪运行」药丸点开的就是本弹层(同一套状态与首次确认流程)
  installRunLocationChooser(() => useUnitsSheet.getState().setOpen(true))
  addRibbonIcon({
    id: 'rb-units-mobile',
    side: 'bottom',
    mobileFoot: true,
    icon: MonitorSmartphone,
    tooltip: () => useApp.getState().tr('unit.switcher'),
    onClick: () => useUnitsSheet.getState().setOpen(true),
  })
}

/** 设备页一律开在**本 app 内的 WebView**(mobileShim.openUnitPage):被弹去系统浏览器观感上就是
 *  离开了 App,与桌面「整个主区切过去」不是一回事(用户 2026-09-03 实报)。三级回落:
 *  app 内 WebView → 系统浏览器 → 新标签页,任一档缺席或失败都不至于「点了没反应」。
 *
 *  ⚠️ 必须逐级 **await**,不能写成 `a?.(url) ?? b?.(url) ?? c()`:`??` 判的是**同步返回值**,而这些
 *  桥返回的是 Promise —— 永远非空,后面两档等于死代码;桥一旦 reject 还会变成未处理拒绝,表现正好
 *  就是「点了没反应」(Codex 评审 medium)。 */
const openUrl = (url: string): void => {
  void (async () => {
    for (const open of [window.tangu?.openUnitPage, window.tangu?.openExternal]) {
      if (!open) continue
      try { await open(url); return } catch { /* 这一档不成,落下一档 */ }
    }
    window.open(url, '_blank', 'noopener')
  })()
}
/** 设备页直连地址必须带尾斜杠(页面用相对 base,同桌面口径)。⚠️只用于 lanUrl/手输地址 ——
 *  引导页 /open 加了尾斜杠反而把页内相对路径(../session、./proxy/)整个解歪。 */
const withSlash = (u: string): string => (u.endsWith('/') ? u : `${u}/`)

const rowIcon = (u: Pick<UnitInfo, 'icon' | 'platform'>): React.ReactNode => {
  if (u.icon) return <span style={{ fontSize: 18 }} aria-hidden>{u.icon}</span>
  if (u.platform === 'android' || u.platform === 'ios') return <Smartphone size={18} />
  if (u.platform === 'win32' || u.platform === 'linux') return <Monitor size={18} />
  return <Laptop size={18} />
}

type Self = { registered: boolean; unitId: string | null; name: string | null; relay?: 'ready' | 'unsupported' | 'native_only' }

/** App 的库桥切换(mobile/src/main.tsx 挂的;web 手机形态没有 → 「智库」一段不画)。选中态读 pageStore.vaultSide:
 *  这个对象的 side 是普通属性,变了不触发重渲染(同 VaultSideSwitch 的注释)。 */
type VaultSide = 'local' | 'cloud'
const vaultBridge = (): { switch(next: VaultSide): void | Promise<void> } | undefined =>
  (window as unknown as { amadeusVaultMode?: { switch(next: VaultSide): void | Promise<void> } }).amadeusVaultMode

const ISSUE_KEY: Record<PhoneIssue, string> = {
  nativeOnly: 'unitm.nativeOnly',
  callerUnavailable: 'unitm.callerUnavailable',
  callerUnsupported: 'unitm.callerUnsupported',
  network: 'unitm.network',
  signedOut: 'unitm.signedOut',
}

export function MobileUnitsSheet(): React.ReactElement | null {
  const { t } = useI18n()
  const open = useUnitsSheet((s) => s.open)
  const setOpen = useUnitsSheet((s) => s.setOpen)
  /** null=未登录(401);undefined=加载中。 */
  const [units, setUnits] = useState<UnitInfo[] | null | undefined>(undefined)
  const [self, setSelf] = useState<Self | null>(null)
  // 每行的探针 / 粘滞拒绝:只经 beginAttempt / noteAttempt / endAttempts 改(谁新听谁,P1-KF 评审;组件关弹层时不卸载,表会留着)
  const [marks, setMarks] = useState<RowMarks>(NO_MARKS)
  const [busy, setBusy] = useState<string | null>(null)
  const [issue, setIssue] = useState<PhoneIssue | null>(null)
  const [devicesOpen, setDevicesOpen] = useState(false)
  const [confirmForget, setConfirmForget] = useState(false)
  const [addr, setAddr] = useState('')
  const flight = useRef<AbortController | null>(null)
  const vaultSide = usePageStore((s) => s.vaultSide)
  const [vaultBusy, setVaultBusy] = useState(false)

  const loadSelf = (): void => {
    void (window.tangu?.unitSelf?.() ?? Promise.resolve(null))
      .then((s) => {
        setSelf(s)
        if (s?.relay === 'native_only') setIssue('nativeOnly')
        else if (s?.relay === 'unsupported') setIssue('callerUnsupported')
      })
      .catch(() => setSelf(null))
  }

  useEffect(() => {
    if (!open) return
    setUnits(undefined)
    setIssue(null)
    setConfirmForget(false)
    void window.tangu?.unitsList?.()
      .then((r) => {
        const list = r?.status === 200 ? ((r.json as { units?: UnitInfo[] } | null)?.units ?? []) : r?.status === 401 ? null : []
        if (list) lastRoster = list
        setUnits(list)
      })
      .catch(() => setUnits([]))
    loadSelf()
    return () => { flight.current?.abort(); flight.current = null; setBusy(null); setMarks(endAttempts) } // 没人轮询了:不留「请允许」
  }, [open])

  // Android 系统返回:弹层开着时接管并关闭(同 SingleColumnHost 两个 sheet 的语义,事件可取消),
  // 否则全局返回把底下视图切走/最小化 App 而弹层还悬着(Codex 四轮 P2)。
  useEffect(() => {
    if (!open) return
    const onBack = (e: Event): void => { e.preventDefault(); setOpen(false) }
    window.addEventListener('forsion:mobile-back', onBack)
    return () => window.removeEventListener('forsion:mobile-back', onBack)
  }, [open, setOpen])

  // 整端焦点变了(本弹层切的、别处切的,或切换失败回落云端)→ 重渲染「当前」标记
  const [, bumpFocus] = useState(0)
  useEffect(() => onFocusChange(() => bumpFocus((n) => n + 1)), [])

  if (!open) return null

  const current = currentRunLocation()
  const rows: RunRow[] = runRows(units || [], self?.unitId ?? null, current, marks.probes, marks.sticky)
  const devices = (units || []).filter((u) => isRunnableUnit(u, self?.unitId ?? null))

  const pick = (row: RunRow): void => {
    flight.current?.abort()
    const ac = new AbortController()
    flight.current = ac
    setBusy(row.id)
    setIssue(null)
    setMarks((m) => beginAttempt(m, row.id)) // 上一轮的「连不上」不许盖住这一轮的回答(评审 P2)
    const note = (p: Parameters<typeof noteAttempt>[2]): void => {
      if (ac.signal.aborted) return
      setMarks((m) => noteAttempt(m, row.id, p))
    }
    void runOn(cloudApiBase(), row.id, {
      // 懒登记一完成就刷新「本机」一行(M1B):runOn 接下来可能在「请在那台电脑上允许」里等上几十秒,
      // 等它整个结束才刷新 = 这段时间一直写着「尚未登记」,而本机其实已经登记好了
      ensureSelf: async () => {
        const r = await (window.tangu?.unitEnsureSelf?.() ?? Promise.resolve({ ok: false as const, code: 'native_only' }))
        if (r.ok && !ac.signal.aborted) loadSelf()
        return r
      },
      fetchJson: async (url, init) => {
        const r = await fetch(url, init)
        let json: unknown = null
        try { json = await r.json() } catch { /* 空体 / 非 JSON */ }
        return { status: r.status, json }
      },
      select: selectRunLocation,
      sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
      now: () => Date.now(),
      progress: note,
    }, ac.signal).then((out) => {
      if (ac.signal.aborted || out.kind === 'cancelled') return
      // P1-K7a:结果同步进共享的设备状态表(侧栏「我的电脑」分组与「在哪运行」药丸读它)
      if (out.kind === 'selected') { noteDeviceProbe(row.id, { ok: true }); clearDeviceSticky(row.id) }
      else if (out.kind === 'device') { if (out.probe) noteDeviceProbe(row.id, out.probe); if (out.sticky) noteDeviceSticky(row.id, out.sticky) }
      if (out.kind === 'phone') setIssue(out.issue)
      else if (out.kind === 'device') note(out)
      loadSelf() // 首次选电脑会顺带登记本机:「本机」段跟着刷新
    }).finally(() => {
      if (flight.current === ac) { flight.current = null; setBusy(null) }
    })
  }

  const pickCloud = (): void => {
    flight.current?.abort()
    flight.current = null
    setBusy(null)
    setMarks(endAttempts)
    void selectRunLocation(HOME_REF)
  }

  // 移除本机:先收掉在途的「点电脑」流程(它可能在移除之后才 select 那台电脑),再切回云端并等它生效,最后才删身份(评审 P2)。
  const forget = (): void => {
    setConfirmForget(false)
    flight.current?.abort()
    flight.current = null
    setBusy(null)
    void removeThisPhone({
      current: currentRunLocation,
      select: selectRunLocation,
      forget: () => window.tangu?.unitForgetSelf?.() ?? Promise.resolve({ ok: false }),
    }).catch(() => ({ ok: false })).then(() => {
      setMarks(NO_MARKS)
      loadSelf()
    })
  }

  const openByAddress = (): void => {
    const raw = addr.trim()
    if (!raw) return
    openUrl(withSlash(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`))
  }

  const homeSelected = current.kind === 'home'

  const vault = vaultBridge()
  const pickVault = (next: VaultSide): void => {
    if (!vault || vaultBusy || next === vaultSide) return
    setVaultBusy(true)
    void Promise.resolve().then(() => vault.switch(next))
      .catch((e) => useApp.getState().toast(String((e as Error)?.message || e), true))
      .finally(() => setVaultBusy(false))
  }

  return (
    <div className="mb-sheet-scrim us-scrim" onClick={() => setOpen(false)} data-units-sheet>
      <div className="mb-sheet us-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="mb-sheet-grip" />
        <div className="us-head">
          <span className="us-head-title">{t('unit.switcher')}</span>
          <button className="us-icon-btn" aria-label={t('common.close')} onClick={() => setOpen(false)}><X size={18} /></button>
        </div>
        <div className="us-body">
          {/* ① 智库:本地 / 云端(原左栏顶部的胶囊;只换笔记库)。排最前 = 桌面 Unit 切换器的顺序(用户 2026-10-05 拍板) */}
          {vault && (
            <section className="us-section" data-vault-side={vaultSide}>
              <div className="us-section-title">{t('unitm.vault')}</div>
              {(['local', 'cloud'] as const).map((side) => (
                <button key={side} className="mb-sheet-row us-row" data-vault-row={side} aria-pressed={vaultSide === side} aria-busy={vaultBusy || undefined} onClick={() => pickVault(side)}>
                  <span className="us-row-icon">{side === 'local' ? <Smartphone size={18} /> : <Cloud size={18} />}</span>
                  <span className="us-row-main">
                    <span className="us-row-title"><span className="us-row-name">{t(side === 'local' ? 'notes.cloud.local' : 'notes.cloud.cloud')}</span></span>
                    <span className="us-row-sub">{t(side === 'local' ? 'unitm.vaultLocalDesc' : 'unitm.vaultCloudDesc')}</span>
                  </span>
                  <span className="us-row-end">{vaultSide === side && <><em className="us-pill">{t('unitm.current')}</em><Check size={16} /></>}</span>
                </button>
              ))}
            </section>
          )}

          {/* ② 在哪运行 */}
          <section className="us-section" data-run-on>
            <div className="us-section-title">{t('unitm.runOn')}</div>
            {issue && <div className="us-banner" role="status" data-phone-issue={issue}>{t(ISSUE_KEY[issue])}</div>}
            <button className="mb-sheet-row us-row" data-run-row="home" aria-pressed={homeSelected} onClick={pickCloud}>
              <span className="us-row-icon"><Cloud size={18} /></span>
              <span className="us-row-main">
                <span className="us-row-title"><span className="us-row-name">{t('unitm.cloud')}</span></span>
                <span className="us-row-sub">{t('unitm.cloudDesc')}</span>
              </span>
              <span className="us-row-end">{homeSelected && <><em className="us-pill">{t('unitm.current')}</em><Check size={16} /></>}</span>
            </button>
            {units === undefined && <div className="us-empty">…</div>}
            {units === null && <div className="us-empty">{t('unit.notLoggedIn')}</div>}
            {units && rows.length === 0 && <div className="us-empty">{t('unit.mobileNone')}</div>}
            {rows.map((row) => {
              const probing = busy === row.id
              const dim = row.status === 'offline'
              return (
                <button
                  key={row.id}
                  className="mb-sheet-row us-row"
                  data-run-row={row.id}
                  data-status={row.status}
                  data-reason={row.refusal?.reason}
                  aria-pressed={row.selected}
                  aria-disabled={dim || undefined}
                  aria-busy={probing || undefined}
                  onClick={() => pick(row)}
                >
                  <span className="us-row-icon">{rowIcon(row)}</span>
                  <span className="us-row-main">
                    <span className="us-row-title"><span className="us-row-name">{row.name}</span></span>
                    <span className="us-row-sub" role="status">
                      <i className={`settings-status-dot ${rowTone(row, probing)}`} aria-hidden />
                      <span>{t(statusKey(row, probing), { name: row.name })}</span>
                    </span>
                  </span>
                  <span className="us-row-end">{row.selected ? <><em className="us-pill">{t('unitm.current')}</em><Check size={16} /></> : <ArrowRight size={15} />}</span>
                </button>
              )
            })}
          </section>

          {/* ③ 打开设备界面(次要,缺省折叠;行为同 P0) */}
          <section className="us-section" data-open-screen>
            <button className="us-section-title us-section-toggle" aria-expanded={devicesOpen} onClick={() => setDevicesOpen((v) => !v)}>
              <span style={{ flex: 1 }}>{t('unitm.openScreen')}</span>
              <ChevronDown size={14} />
            </button>
            {devicesOpen && (
              <>
                {devices.flatMap((u) => {
                  const lanUrl = u.lanUrl
                  const vias: Array<'lan' | 'tunnel'> = lanUrl ? ['lan', 'tunnel'] : ['tunnel']
                  return vias.map((via) => {
                    const dim = via === 'tunnel' && !u.online // 中转要 server 通道在;直连与登录态无关
                    return (
                      <button
                        key={`${u.id}:${via}`}
                        className="mb-sheet-row us-row"
                        aria-disabled={dim || undefined}
                        onClick={() => openUrl(via === 'lan' ? withSlash(lanUrl!) : guideUrl(u.id))}
                      >
                        <span className="us-row-icon">{rowIcon(u)}</span>
                        <span className="us-row-main">
                          <span className="us-row-title">
                            <span className="us-row-name">{u.name}</span>
                            <em className="us-pill muted">{t(via === 'lan' ? 'unit.viaLan' : 'unit.viaTunnel')}</em>
                            {dim && <em className="us-pill muted">{t('unit.offline')}</em>}
                          </span>
                          <span className="us-row-sub">{t(via === 'lan' ? 'unit.deviceLanDesc' : 'unit.mobileTunnel')}</span>
                        </span>
                        <span className="us-row-end"><ArrowRight size={15} /></span>
                      </button>
                    )
                  })
                })}
                {/* 手输地址直连(T1):对方切换器脚部可见,如 http://192.168.1.5:8791 */}
                <div className="us-addr">
                  <div className="us-addr-desc">{t('unit.byAddressDesc')}</div>
                  <div className="us-addr-row">
                    <input
                      value={addr}
                      onChange={(e) => setAddr(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') openByAddress() }}
                      placeholder="http://<ip>:<port>"
                      inputMode="url"
                    />
                    <button className="us-btn" onClick={openByAddress}>{t('unit.byAddress')}</button>
                  </div>
                </div>
              </>
            )}
          </section>

          {/* ④ 本机 */}
          <section className="us-section" data-this-phone>
            <div className="us-section-title">{t('unitm.thisPhone')}</div>
            <div className="us-self">
              <span className="us-row-icon"><Smartphone size={18} /></span>
              <span className="us-self-text">
                {self?.relay === 'native_only'
                  ? t('unitm.nativeOnly')
                  : self?.registered
                    ? t('unitm.registeredAs', { name: self.name || '' })
                    : t('unitm.notRegistered')}
              </span>
              {self?.registered && !confirmForget && <button className="us-btn danger" onClick={() => setConfirmForget(true)}>{t('unitm.forget')}</button>}
            </div>
            {confirmForget && (
              <div className="us-confirm" role="alertdialog">
                <span>{t('unitm.forgetConfirm')}</span>
                <span className="us-confirm-actions">
                  <button className="us-btn" onClick={() => setConfirmForget(false)}>{t('common.cancel')}</button>
                  <button className="us-btn danger" onClick={forget}>{t('unitm.forgetDo')}</button>
                </span>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
