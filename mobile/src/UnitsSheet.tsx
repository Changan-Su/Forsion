/**
 * 互联设备(Forsion Unit)移动端弹层 —— P1-K8 起是「在哪运行」:把这台手机上的会话交给账号名下的某台电脑跑。
 * 规格:docs/ToBeImproved/设备能力MCP_P1规格_2026-09-28/K8-mobile-native.md §3.7;K8 独占本文件(INTEGRATION R-28 / R-29)。
 *
 * 自上而下三段:
 *   1. 在哪运行:Forsion 云端(缺省)+ 每台电脑一行、带状态(services/deviceStatus.ts 的口径,R-22)。
 *      点一台电脑 = unitsSheetModel.runOn:懒登记本机 → 问那台电脑认不认这台手机(需要就发起确认、轮询)→ 探一次引擎 → 生效。
 *      **生效只走本文件唯一的 selectRunLocation**:今天是空操作,TODO(K6-S2) 接 setFocusTarget(R-21)。
 *   2. 打开设备界面(折叠,次要):P0 起的直连 / 中转行与手输地址,行为不变 —— 设备页开在 app 内 WebView(mobileShim.openUnitPage)。
 *   3. 本机:登记状态与「移除本机登记」。P1 起手机登记为 Unit(调用方,kind='phone');P2a 起可作被调用方。
 * 手机(kind='phone')与本机不出现在 1、2 两段:手机没有引擎也没有设备页。kind 缺席的老名册按电脑处理。
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
import type { UnitInfo } from '@/types'
import { cloudApiBase } from '@/services/engine/targets'
import { HOME_REF, type TargetRef } from '@/services/engine/target'
import type { DeviceStatus, ProbeResult, StickyRefusal } from '@/services/deviceStatus'
import { isRunnableUnit, runOn, runRows, statusKey, type PhoneIssue, type RunRow } from './unitsSheetModel'
import './unitsSheet.css'

/**
 * 「在哪运行」生效 —— 整个弹层只有这一个出口(单测钉住:scripts/units-sheet-model.test.cjs)。
 * TODO(K6-S2):setFocusTarget(ref)(K6-S2 与本包并行,集成时补这一行);K7 之后改 setDraftLocation(ref, { explicit: true })(INTEGRATION R-21)。
 * 今天是空操作:请求仍发往云端,所以 currentRunLocation 也如实恒为云端,界面不假装已经切过去。
 */
export function selectRunLocation(ref: TargetRef): void {
  void ref
}

/** 当前运行位置。TODO(K6-S2):focusRef()。 */
function currentRunLocation(): TargetRef {
  return HOME_REF
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
  'unitm.confirmDenied': { zh: '「{name}」拒绝了这台手机', en: '"{name}" declined this phone' },
  'unitm.remoteOff': { zh: '请在「{name}」上开启「允许远程会话」', en: 'Turn on "Allow remote sessions" on "{name}"' },
  'unitm.callerUnavailable': { zh: '这台手机暂时无法证明自己的身份，请稍后重试', en: "This phone couldn't verify its identity. Try again later" },
  'unitm.callerUnsupported': { zh: '服务器版本过旧，暂不支持从手机运行', en: 'The server is too old to run from a phone' },
  'unitm.nativeOnly': { zh: '仅在 Forsion 安卓 App 中可用', en: 'Only available in the Forsion Android app' },
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
 *  数据桥在才上架:App=mobileShim.unitsList;设备页(unitShim)/Tangu Web(webShim)无此桥 → 自然隐藏。 */
export function installUnitsEntry(): void {
  if (!window.tangu?.unitsList) return
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

const DOT: Record<DeviceStatus, '' | 'ok' | 'warn' | 'err'> = {
  checking: '', ready: 'ok', starting: 'warn', engineStopped: 'warn', noEngine: 'err', offline: '',
  unreachable: 'err', remoteOff: 'warn', awaitingConfirm: 'warn', denied: 'err',
}

type Self = { registered: boolean; unitId: string | null; name: string | null; relay?: 'ready' | 'unsupported' | 'native_only' }

const ISSUE_KEY: Record<PhoneIssue, string> = {
  nativeOnly: 'unitm.nativeOnly',
  callerUnavailable: 'unitm.callerUnavailable',
  callerUnsupported: 'unitm.callerUnsupported',
}

export function MobileUnitsSheet(): React.ReactElement | null {
  const { t } = useI18n()
  const open = useUnitsSheet((s) => s.open)
  const setOpen = useUnitsSheet((s) => s.setOpen)
  /** null=未登录(401);undefined=加载中。 */
  const [units, setUnits] = useState<UnitInfo[] | null | undefined>(undefined)
  const [self, setSelf] = useState<Self | null>(null)
  const [probes, setProbes] = useState<Record<string, ProbeResult>>({})
  const [sticky, setSticky] = useState<Record<string, StickyRefusal>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [issue, setIssue] = useState<PhoneIssue | null>(null)
  const [devicesOpen, setDevicesOpen] = useState(false)
  const [confirmForget, setConfirmForget] = useState(false)
  const [addr, setAddr] = useState('')
  const flight = useRef<AbortController | null>(null)

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
      .then((r) => setUnits(r?.status === 200 ? ((r.json as { units?: UnitInfo[] } | null)?.units ?? []) : r?.status === 401 ? null : []))
      .catch(() => setUnits([]))
    loadSelf()
    return () => { flight.current?.abort(); flight.current = null; setBusy(null) }
  }, [open])

  // Android 系统返回:弹层开着时接管并关闭(同 SingleColumnHost 两个 sheet 的语义,事件可取消),
  // 否则全局返回把底下视图切走/最小化 App 而弹层还悬着(Codex 四轮 P2)。
  useEffect(() => {
    if (!open) return
    const onBack = (e: Event): void => { e.preventDefault(); setOpen(false) }
    window.addEventListener('forsion:mobile-back', onBack)
    return () => window.removeEventListener('forsion:mobile-back', onBack)
  }, [open, setOpen])

  if (!open) return null

  const current = currentRunLocation()
  const rows: RunRow[] = runRows(units || [], self?.unitId ?? null, current, probes, sticky)
  const devices = (units || []).filter((u) => isRunnableUnit(u, self?.unitId ?? null))

  const pick = (row: RunRow): void => {
    flight.current?.abort()
    const ac = new AbortController()
    flight.current = ac
    setBusy(row.id)
    setIssue(null)
    const note = (p: { probe?: ProbeResult; sticky?: StickyRefusal }): void => {
      if (ac.signal.aborted) return
      if (p.probe) setProbes((m) => ({ ...m, [row.id]: p.probe! }))
      if (p.sticky) setSticky((m) => ({ ...m, [row.id]: p.sticky! }))
      else if (p.probe?.ok) setSticky((m) => { const n = { ...m }; delete n[row.id]; return n })
    }
    void runOn(cloudApiBase(), row.id, {
      ensureSelf: () => window.tangu?.unitEnsureSelf?.() ?? Promise.resolve({ ok: false as const, code: 'native_only' }),
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
    selectRunLocation(HOME_REF)
  }

  const forget = (): void => {
    setConfirmForget(false)
    void (window.tangu?.unitForgetSelf?.() ?? Promise.resolve({ ok: false })).then(() => {
      if (currentRunLocation().kind === 'unit') selectRunLocation(HOME_REF) // 当前目标是某台电脑 → 切回云端
      setProbes({})
      setSticky({})
      loadSelf()
    })
  }

  const openByAddress = (): void => {
    const raw = addr.trim()
    if (!raw) return
    openUrl(withSlash(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`))
  }

  const homeSelected = current.kind === 'home'

  return (
    <div className="mb-sheet-scrim us-scrim" onClick={() => setOpen(false)} data-units-sheet>
      <div className="mb-sheet us-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="mb-sheet-grip" />
        <div className="us-head">
          <span className="us-head-title">{t('unit.switcher')}</span>
          <button className="us-icon-btn" aria-label={t('common.close')} onClick={() => setOpen(false)}><X size={18} /></button>
        </div>
        <div className="us-body">
          {/* ① 在哪运行 */}
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
                  aria-pressed={row.selected}
                  aria-disabled={dim || undefined}
                  aria-busy={probing || undefined}
                  onClick={() => pick(row)}
                >
                  <span className="us-row-icon">{rowIcon(row)}</span>
                  <span className="us-row-main">
                    <span className="us-row-title"><span className="us-row-name">{row.name}</span></span>
                    <span className="us-row-sub" role="status">
                      <i className={`settings-status-dot ${row.status !== 'checking' ? DOT[row.status] : !probing && row.capsReady ? 'ok' : ''}`} aria-hidden />
                      <span>{t(statusKey(row, probing), { name: row.name })}</span>
                    </span>
                  </span>
                  <span className="us-row-end">{row.selected ? <><em className="us-pill">{t('unitm.current')}</em><Check size={16} /></> : <ArrowRight size={15} />}</span>
                </button>
              )
            })}
          </section>

          {/* ② 打开设备界面(次要,缺省折叠;行为同 P0) */}
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

          {/* ③ 本机 */}
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
