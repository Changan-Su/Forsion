/**
 * Forsion Unit 切换器(Ribbon 命令区常驻件,仅真桌面)。吸收原「本地 | 云端」胶囊(VaultSideSwitch
 * 桌面分支):胶囊显示当前面,Ribbon 折叠态只显图标。
 * 10-17 用户定:点胶囊 = 打开 设置 › 设备(UnitSettings)—— 原弹出菜单会随 Ribbon 收回被关掉,整页搬进设置;
 * 设置在桌面是独立浮窗,去处经 `unit-route` 主窗动作交回主窗执行(runUnitRoute)。
 *
 * v2(B 端渲染,方案 §11):
 *   本地 / 云端 = 原胶囊语义原样搬家(只切 vault side,勾选态跟 vaultSide);
 *   设备 X     = **整个主区切过去**(UnitRemoteSurface:portal 盖满 .shell-work 的远程面,
 *                webview 承载对方曝出的网页;Authorization 由主进程在浏览器分区对隧道前缀注入。
 *                2026-08-25 用户拍板:不再开内置浏览器标签 —— 观感必须是「切换到那台设备」,
 *                ribbon 和 mac 标题条留在外面,胶囊显示当前设备、也是回来的路);
 *                **一台设备按通路拆成多行**(直连 / 中转各一行,2026-08-25 用户拍板):
 *                原先一行 + 自动择路,LAN 一探通就把中转那条路顶掉,界面上等于没有;
 *   通过地址连接… = T1 局域网直连:手输 http://<ip>:<端口>,配对验证在对方页面里走。
 * 设备行图标可自定义 emoji(右键行);下半页 = 「允许其他设备连接本机」开关 + 本机直连地址 +
 * 已配对来访设备回收(无回收的配对不许上线;缺省折起)。
 */
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { Check, ChevronDown, Cloud, Globe, Laptop, Monitor, MonitorSmartphone, Smartphone, X } from 'lucide-react'
import { OverlayAt } from '@lcl/engine'
import { useApp } from '../stores/appStore'
import { usePageStore } from '../amadeus/store/pageStore'
import { notifyApp } from '../stores/notificationStore'
import { askString } from '../amadeus/components/askString'
import { Webview } from '../builtins/browserView'
import { BROWSER_PARTITION } from '../../../shared/browser'
import { registerMessages, translate, useI18n } from '../i18n'
import { windowKind } from '../windowKind'
import { SettingsPanel, SettingsRow, SettingsSwitch } from './SettingsPrimitives'
import { ipcErrorText } from '../ipcError'
import { SecretStorageNotice } from './SecretStorageNotice' // P1-K5
import { remoteSessionsApi } from '../services/remoteSessionsApi' // P1-K4
import { SECRET_STORE_INSECURE, type RemoteSessionsView } from '../../../shared/remoteSessions' // P1-K4
import './remoteSessionsCopy' // P1-K4
import type { UnitInfo, UnitPairedDevice } from '../types'
import { accountChip, subscribeAccountChip } from '../services/accountChip'
import { rememberVia, type UnitVia } from './unitPanelModel'
import { useUnitRoster } from './unitRoster'
import { setPopupsBlocked } from '../stores/popupQueue'
import '../styles/unitSwitcher.css'

registerMessages({
  'unit.local': { zh: '本地', en: 'Local' },
  'unit.cloud': { zh: '云端', en: 'Cloud' },
  'unit.localDesc': { zh: '本机引擎与本地智库', en: 'Local engine and vault' },
  'unit.cloudDesc': { zh: '云端智库（引擎照旧）', en: 'Cloud vault (engine unchanged)' },
  'unit.deviceDesc': { zh: '经云端中转，异地也能用', en: 'Via cloud relay — works anywhere' },
  'unit.deviceLanDesc': { zh: '同一局域网直连，更快', en: 'Direct over LAN — faster' },
  'unit.viaLan': { zh: '直连', en: 'Direct' },
  'unit.viaP2p': { zh: 'P2P', en: 'P2P' },
  'unit.viaTunnel': { zh: '中转', en: 'Relay' },
  'unit.deviceP2pDesc': { zh: '打洞直连，流量不过服务器', en: 'Hole-punched direct — no relay traffic' },
  'unit.p2pConnecting': { zh: '正在与「{name}」打洞直连…', en: 'Hole-punching to "{name}"…' },
  'unit.p2pFallback': { zh: 'P2P 未接通（{why}），已回落云端中转', en: 'P2P failed ({why}) — fell back to cloud relay' },
  'unit.menuEditIcon': { zh: '自定义图标（emoji）', en: 'Set icon (emoji)' },
  'unit.menuInBrowser': { zh: '在系统浏览器打开', en: 'Open in system browser' },
  'unit.offline': { zh: '离线', en: 'Offline' },
  'unit.offlineGroup': { zh: '离线设备', en: 'Offline devices' },
  'unit.offlineNote': { zh: '「{name}」不在线：需在那台设备上开着 Forsion 并启用互联', en: '"{name}" is offline — open Forsion on that device with connect enabled' },
  'unit.byAddress': { zh: '通过地址连接…', en: 'Connect by address…' },
  'unit.byAddressDesc': { zh: '同一局域网直连：http://<IP>:<端口>', en: 'Same-LAN direct: http://<ip>:<port>' },
  'unit.byAddressAsk': { zh: '对方设备的直连地址（在其「设置 › 设备」里可见）', en: "The device's direct address (shown in its Settings › Devices)" },
  'unit.hostToggle': { zh: '允许其他设备连接本机', en: 'Allow other devices to connect' },
  'unit.hostConnected': { zh: '互联通道已连接', en: 'Connect channel online' },
  'unit.hostStarting': { zh: '通道连接中…（需登录 Forsion；局域网直连不受影响）', en: 'Channel connecting… (login required; LAN direct unaffected)' },
  'unit.hostHint': { zh: '打开后，你的其他设备可以经局域网或云端中转连接这台电脑。', en: 'When on, your other devices can connect to this computer over LAN or the cloud relay.' },
  'unit.tab': { zh: '设备', en: 'Devices' },
  'unit.page': { zh: '切换到你的其他设备，并管理谁能连接这台电脑。', en: 'Switch to your other devices and manage who can connect to this computer.' },
  'unit.switchTitle': { zh: '切换到', en: 'Switch to' },
  'unit.switchHint': { zh: '在本机、云端和你的其他设备之间切换。选中设备后，整个主区会切到那台设备。', en: 'Switch between this computer, the cloud and your other devices. Picking a device switches the whole main area to it.' },
  'unit.lanAddr': { zh: '本机直连地址：{addr}', en: 'Direct address: {addr}' },
  'unit.paired': { zh: '来访设备', en: 'Visiting devices' },
  'unit.pairedRemove': { zh: '移除「{name}」的连接权限？', en: 'Revoke access for "{name}"?' },
  'unit.setEmoji': { zh: '设备图标（输入一个 emoji，留空恢复默认）', en: 'Device icon (one emoji; empty = default)' },
  'unit.switcher': { zh: 'Forsion Unit 切换', en: 'Switch Forsion Unit' },
  'unit.notLoggedIn': { zh: '登录以查看你的其他设备', en: 'Sign in to see your other devices' },
  'unit.frame.kind': { zh: '我的设备', en: 'My device' },
  'unit.frame.back': { zh: '回到这台电脑', en: 'Back to this computer' },
  'unit.frame.unreachable': { zh: '连不上这台设备', en: "Can't reach this device" },
  'unit.frame.crashed': { zh: '这台设备的页面停止响应了', en: "This device's page stopped responding" },
  'unit.frame.retry': { zh: '重试', en: 'Retry' },
  'unit.frame.relayFallback': { zh: '「{name}」这条路没接通，已改走中转', en: 'Couldn\'t connect to "{name}" that way — switched to relay' },
  'unit.frame.lanDown': { zh: '「{name}」这次直连不通，改走中转', en: '"{name}" isn\'t reachable directly right now — using relay' },
})

export function deviceIcon(u: { icon?: string | null; platform?: string | null }, size = 15): React.ReactNode {
  if (u.icon) return <span className="unitsw-emoji" aria-hidden>{u.icon}</span>
  if (u.platform === 'android' || u.platform === 'ios') return <Smartphone size={size} />
  if (u.platform === 'win32' || u.platform === 'linux') return <Monitor size={size} />
  return <Laptop size={size} />
}

/** 设备的隧道页地址:经 server 通用隧道回到该设备的 unitWeb(尾斜杠必须留 —— 页面用相对 base)。 */
function tunnelPageUrl(cloudUrl: string | undefined, unitId: string): string {
  return `${(cloudUrl || '').replace(/\/+$/, '')}/api/units/${unitId}/proxy/`
}

/** 当前远程面目标。key = `<设备 id>:<lan|p2p|tunnel>` 或 `addr:<url>`(手输地址)——
 *  同一台设备的几条通路是几个目标,勾选态才落得到点中的那一行;hide 不清 target —— webview
 *  保活在暗处,切回来免重载(换目标才按 url 重挂)。 */
export interface UnitRemoteTarget {
  key: string
  name: string
  icon?: string | null
  platform?: string | null
  url: string
  /** 名册里的设备(手输地址没有)。 */
  unitId?: string
  via?: UnitVia
  /** 用户在 设置 › 设备 里明确点的这条通路:加载成功后记下来(rememberVia),面板下次按它走。 */
  remember?: boolean
}
export const useUnitRemote = create<{
  target: UnitRemoteTarget | null
  active: boolean
  open: (t: UnitRemoteTarget) => void
  hide: () => void
}>((set) => ({
  target: null,
  active: false,
  open: (t) => set({ target: t, active: true }),
  hide: () => set({ active: false }),
}))

/**
 * 远程面两种形态的**唯一**开关(组织 Agent 管理第三轮 · 切过去以后的框):
 *   true  = 整窗:从 Ribbon 到主区都是那台画的;宿主只留顶上一条标题条(中间胶囊带「回到这台电脑」)和左下角自己的头像。
 *   false = 08-25 那版:portal 进 .shell-work 盖主区,本机 Ribbon 留着,点 Ribbon 的视图槽 = 回本机。
 * 两种形态的差别(portal 目标、CSS 类、点 Ribbon 回本机那段监听、远端账号卡的隐藏)只走这里。
 */
export const UNIT_SURFACE_WHOLE = true
/** 台架开关(harness `&surface=part`):产品里不设,恒等于 UNIT_SURFACE_WHOLE。 */
export function unitSurfaceWhole(): boolean {
  return UNIT_SURFACE_WHOLE && !(window as unknown as { __forsionUnitSurfacePart?: boolean }).__forsionUnitSurfacePart
}

/** 整窗形态下远端页面自己的账号卡(AccountCard 渲染的这两个类)藏起来、占位留着:左下角那枚是宿主画的。
 *  只往对面注样式,不从对面读任何东西。AccountCard 改类名要同步这里(AccountCard.test 钉着)。 */
export const REMOTE_ACCOUNT_SELECTORS = ['.rb .ribbon-account', '.rb .account-card'] as const
const HIDE_REMOTE_ACCOUNT_CSS = `${REMOTE_ACCOUNT_SELECTORS.join(', ')} { visibility: hidden !important; }`

type WebviewEl = HTMLElement & { insertCSS?: (css: string) => Promise<string>; reload?: () => void }
type SurfaceFail = null | 'unreachable' | 'crashed'

/** 加载失败:不是中转、这台在线(名册说不准就当在线)→ 出声改走中转;否则交给宿主画失败态。 */
function fallBackToRelay(): boolean {
  const t = useUnitRemote.getState().target
  if (!t?.unitId || !t.via || t.via === 'tunnel') return false
  const u = useUnitRoster.getState().units?.find((x) => x.id === t.unitId)
  if (u && !u.online) return false
  sayUnit(translate('unit.frame.relayFallback', { name: t.name }))
  runUnitRoute({ kind: 'unit', id: t.unitId, name: t.name, icon: t.icon, platform: t.platform, via: 'tunnel' })
  return true
}

/** 设备远程面。整窗形态:portal 到 Shell 根(.shell)的末尾、fixed 盖满窗口;
 *  旧形态:portal 进 .shell-work,盖满「tab 栏 + 内容 + 侧栏 + 状态栏」而留下 ribbon 与 mac 标题条。
 *  ⚠️ 根必须 no-drag 且 DOM 晚于被盖的拖窗条(拖窗区按 DOM 顺序几何合成、无视 z-index,
 *  见 base.css「Electron 拖窗区兜底」);portal 追加在容器末尾天然满足。整窗形态的标题条在根里面再把 drag 补回来。 */
export function UnitRemoteSurface(): React.ReactElement | null {
  const { t } = useI18n()
  const target = useUnitRemote((s) => s.target)
  const active = useUnitRemote((s) => s.active)
  const whole = unitSurfaceWhole()
  const webRef = useRef<WebviewEl>(null)
  const [fail, setFail] = useState<SurfaceFail>(null)
  const [nonce, setNonce] = useState(0)
  useEffect(() => { setFail(null) }, [target?.url])
  // 切进来把键盘直接交给对方页面(不点一下打不了字)。
  useEffect(() => { if (active) webRef.current?.focus() }, [active, target?.url, nonce])
  // 旧形态:点了本机 ribbon 的视图槽(视图图标 / Space)= 用户要回本机 —— Space 切换语义,自动退场。
  // 胶囊自己与尾部账号/设置不算:它们开的是浮层,盖在远程面之上,关掉还该在设备页里。
  // ⚠️ 10-02 起胶囊住进命令区,自己也在 .rb-slot 里 —— 不排除它,点胶囊想换设备就先被踢回本机(check:unitswitcher 勾选态那条)。
  // 整窗形态 Ribbon 被盖住,够不着这段:回来的路是标题条胶囊和头像面板里的「这台电脑」。
  useEffect(() => {
    if (!active || whole) return
    const onClick = (e: MouseEvent): void => {
      const el = e.target as HTMLElement | null
      if (el?.closest?.('.rb-slot') && !el.closest('.unitsw-pill')) useUnitRemote.getState().hide()
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [active, whole])
  // 看着别的设备时,本机自己弹出来的弹窗和上手提示(guideTips 认 popupQueue.blocked)先排着,别浮在对面的页面上;回到本机再出
  useEffect(() => {
    if (!active) return
    setPopupsBlocked(true, 'unit-remote')
    return () => setPopupsBlocked(false, 'unit-remote')
  }, [active])
  // 整窗时给 Windows 原生按钮区对高度(tabTitleBar.ts 认这个标记,按标题条的高度调 titleBarOverlay)
  useEffect(() => {
    if (!active || !whole) return
    const root = document.documentElement
    root.dataset.unitFrame = '1'
    return () => { delete root.dataset.unitFrame }
  }, [active, whole])
  // webview 事件:主框架加载失败(-3 ABORTED 不算)→ 回落中转或画失败态;渲染进程没了 → 失败态;
  // 加载成功 → 用户明确选的通路记下来;每次主框架 dom-ready 都重新注入「藏远端账号卡」的样式。
  useEffect(() => {
    const el = webRef.current
    if (!el || !target) return
    let failed = false
    const onStart = (): void => { failed = false }
    const onFail = (e: Event): void => {
      const ev = e as Event & { errorCode?: number; isMainFrame?: boolean }
      if (ev.isMainFrame === false || ev.errorCode === -3) return
      failed = true
      if (!fallBackToRelay()) setFail('unreachable')
    }
    const onFinish = (): void => {
      if (failed) return
      setFail(null)
      const cur = useUnitRemote.getState().target
      if (cur?.remember && cur.unitId && cur.via && cur.url === target.url) rememberVia(cur.unitId, cur.via)
    }
    const onReady = (): void => { if (whole) void el.insertCSS?.(HIDE_REMOTE_ACCOUNT_CSS)?.catch?.(() => {}) }
    const onGone = (): void => setFail('crashed')
    const on: Array<[string, (e: Event) => void]> = [['did-start-loading', onStart], ['did-fail-load', onFail], ['did-finish-load', onFinish], ['dom-ready', onReady], ['render-process-gone', onGone], ['crashed', onGone]]
    for (const [n, f] of on) el.addEventListener(n, f)
    return () => { for (const [n, f] of on) el.removeEventListener(n, f) }
  }, [target, nonce, whole])
  if (!target) return null
  const retry = (): void => { setFail(null); setNonce((n) => n + 1) }
  const back = (): void => useUnitRemote.getState().hide()
  const web = <Webview ref={webRef} key={`${target.url}#${nonce}`} className="unitrs-web" src={target.url} partition={BROWSER_PARTITION} allowpopups="true" />

  if (whole) {
    // 渲染期查询而非挂载期缓存:target/active 每变一次都重查,Shell 罕见重挂后切一次设备即自愈。无 Shell(harness)→ 原地渲染。
    const host = document.querySelector('.shell')
    const isAddr = target.key.startsWith('addr:')
    const node = (
      <div className={`unitrs unitrs--whole${active ? '' : ' unitrs-hidden'}`} data-unit-frame="">
        <div className="unitfr-bar">
          <div className="unitfr-pill" data-unitfr-pill="">
            <span className="unitfr-pill-ic">{isAddr ? <Globe size={13} /> : deviceIcon(target, 13)}</span>
            <span className="unitfr-pill-text">
              <span className="unitfr-pill-name">{target.name}</span>
              {!isAddr && <span className="unitfr-pill-kind">{t('unit.frame.kind')}</span>}
            </span>
            <span className="unitfr-pill-sep" aria-hidden="true" />
            <button type="button" className="unitfr-back" onClick={back}>{t('unit.frame.back')}</button>
          </div>
        </div>
        <div className="unitfr-body">
          {web}
          {fail && (
            <div className="unitfr-fail" role="alert">
              <div className="unitfr-fail-title">{t(fail === 'crashed' ? 'unit.frame.crashed' : 'unit.frame.unreachable')}</div>
              <div className="unitfr-fail-actions">
                <button type="button" className="btn primary" onClick={retry}>{t('unit.frame.retry')}</button>
                <button type="button" className="btn" onClick={back}>{t('unit.frame.back')}</button>
              </div>
            </div>
          )}
        </div>
        <UnitFrameAvatar target={target} />
      </div>
    )
    return host ? createPortal(node, host) : node
  }

  const host = document.querySelector('.shell-work')
  // 无 Shell 的 fixed 兜底必须量 ribbon 实宽:展开态 ribbon 远宽于 44px,写死会把胶囊(回来的路)盖死。
  const freeLeft = host ? undefined : (document.querySelector('.rb') as HTMLElement | null)?.offsetWidth
  const node = (
    <div className={`unitrs${active ? '' : ' unitrs-hidden'}`} style={freeLeft != null ? { left: freeLeft } : undefined}>
      {web}
    </div>
  )
  return host ? createPortal(node, host) : node // 无 Shell(harness/web)→ 原地渲染,CSS 退化为 fixed 覆盖层
}

/** 整窗形态左下角:本机用户自己的头像(数据走 services/accountChip 的接缝),右下角叠那台的小图标。
 *  盖在远端账号卡的位置上(Ribbon 折叠态账号槽的几何,见 unitSwitcher.css .unitfr-rail);点它 = 开本机账号面板,锚在这枚头像上。 */
function UnitFrameAvatar({ target }: { target: UnitRemoteTarget }): React.ReactElement | null {
  const chip = useSyncExternalStore(subscribeAccountChip, accountChip, accountChip)
  const [imgError, setImgError] = useState(false)
  if (!chip) return null
  return (
    <div className="unitfr-rail">
      <button
        type="button"
        className="ribbon-account unitfr-avatar"
        title={chip.label}
        aria-label={chip.label}
        // 面板开着时按在这里不算「点别处」:交给 click 去开合
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => accountChip()?.activate(e.currentTarget)}
      >
        {chip.avatar && !imgError
          ? <img className="account-avatar" src={chip.avatar} alt="" onError={() => setImgError(true)} />
          : <span className="account-avatar fallback">{chip.initial}</span>}
        <span className="unitfr-badge" aria-hidden="true">{target.key.startsWith('addr:') ? <Globe size={9} /> : deviceIcon(target, 9)}</span>
      </button>
    </div>
  )
}

/** 设置页里点中的去处。设置在桌面是独立浮窗(独立 store),远程面 / vaultSide 都在主窗 ——
 *  浮窗把去处序列化成 `unit-route` 主窗动作,由主窗执行(打洞也在主窗跑:浮窗随即关掉,等不到结果)。 */
export type UnitRoute =
  | { kind: 'side'; side: 'local' | 'cloud' }
  /** explicit:设置 › 设备里点的通路行(用户明确选的;加载成功后记住)。面板行自己走出来的不算。 */
  | { kind: 'unit'; id: string; name: string; icon?: string | null; platform?: string | null; via: 'lan' | 'p2p' | 'tunnel'; lanUrl?: string | null; explicit?: boolean }
  | { kind: 'addr'; url: string }

function parseUnitRoute(raw: string): UnitRoute | null {
  try {
    const r = JSON.parse(raw) as UnitRoute
    if (r?.kind === 'side') return r.side === 'local' || r.side === 'cloud' ? r : null
    if (r?.kind === 'addr') return typeof r.url === 'string' && /^https?:\/\//i.test(r.url) ? r : null
    if (r?.kind === 'unit') return typeof r.id === 'string' && typeof r.name === 'string' && ['lan', 'p2p', 'tunnel'].includes(r.via) ? r : null
  } catch { /* 坏载荷:丢 */ }
  return null
}

export const sayUnit = (text: string): void => { notifyApp({ text, event: 'system.unit' }) }

/** 每次选去处 +1:迟到的打洞结果只在自己仍是最后一次选择时才落(否则会把用户后来选的面顶掉,Codex 评审)。 */
let routeSeq = 0

/** 在本窗口(主窗,或无浮窗的 harness / web)执行去处。 */
export function runUnitRoute(r: UnitRoute): void {
  const seq = ++routeSeq
  const remote = useUnitRemote.getState()
  if (r.kind === 'side') {
    remote.hide() // 从设备页切回本机(target 保留 = webview 保活,再切回去免重载)
    if (window.amadeusSync && usePageStore.getState().vaultSide !== r.side) {
      void usePageStore.getState().switchVaultSide(r.side).catch((e) => sayUnit(String((e as Error)?.message || e)))
    }
    return
  }
  if (r.kind === 'addr') {
    // 手输地址没有名册条目:key 带 addr: 前缀防与设备 id 撞,名字就用主机段。
    remote.open({ key: `addr:${r.url}`, name: r.url.replace(/^https?:\/\//i, '').replace(/\/+$/, ''), url: r.url })
    return
  }
  const cloudUrl = useApp.getState().desktopConfig?.cloudUrl
  const to = (url: string, via = r.via): void => {
    useUnitRemote.getState().open({ key: `${r.id}:${via}`, name: r.name, icon: r.icon, platform: r.platform, url, unitId: r.id, via, remember: !!r.explicit && via === r.via })
  }
  if (r.via === 'lan' && r.lanUrl) return to(r.lanUrl.endsWith('/') ? r.lanUrl : `${r.lanUrl}/`)
  if (r.via === 'p2p' && window.tangu?.unitsP2pOpen) {
    // p2p 档特殊:打洞是异步的,失败**出声回落**中转(拆行拍板管的是选项可见性,不禁优雅降级)。
    sayUnit(translate('unit.p2pConnecting', { name: r.name }))
    void window.tangu.unitsP2pOpen(r.id).then((res) => { if (seq === routeSeq) to(res.url) }).catch((e) => {
      if (seq !== routeSeq) return
      sayUnit(translate('unit.p2pFallback', { why: ipcErrorText(e) }))
      to(tunnelPageUrl(cloudUrl, r.id), 'tunnel') // 回落即中转:key 归中转行,勾选态如实
    })
    return
  }
  to(tunnelPageUrl(cloudUrl, r.id), 'tunnel')
}

/** 手输的设备地址规范化:没写协议补 http://;只给**路径**补尾斜杠(页面用相对 base),
 *  `#片段` / `?查询` 原样留着(`http://host:3260/#unit-owner=…` 不能被补成 `…/`)。解析不了 = null。 */
export function normalizeUnitAddress(raw: string): string | null {
  const s = raw.trim()
  if (!s || /^https?:\/\/?$/i.test(s)) return null
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `http://${s}`)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (!u.pathname.endsWith('/')) u.pathname = `${u.pathname}/`
    return u.toString()
  } catch { return null }
}

/** 主窗收 `unit-route` 动作(Root 的 onMainAction 调)。 */
export function runUnitRoutePayload(payload: string): void {
  const r = parseUnitRoute(payload)
  if (r) runUnitRoute(r)
}

/** Ribbon 命令区的胶囊:显示当前面(本地 / 云端 / 正在看的设备),点开 = 设置 › 设备。
 *  10-17 用户定:原弹出菜单会被 Ribbon 收回连带关掉,整页搬进设置。 */
export function UnitSwitcher({ expanded }: { expanded: boolean }): React.ReactElement {
  const { t } = useI18n()
  const vaultSide = usePageStore((s) => s.vaultSide)
  const initSide = usePageStore((s) => s.initVaultSide)
  // 原 VaultSideSwitch 桌面分支负责的 vaultSide 初始化,随胶囊迁到这里。
  useEffect(() => { if (window.amadeusSync) void initSide() }, [initSide])

  // 远程面激活时,胶囊当前项 = 那台设备(它同时是回来的路);否则照旧跟 vaultSide。
  const remote = useUnitRemote()
  const current: { name: string; icon: React.ReactNode } =
    remote.active && remote.target
      ? { name: remote.target.name, icon: deviceIcon(remote.target) }
      : vaultSide === 'cloud'
        ? { name: t('unit.cloud'), icon: <Cloud size={15} /> }
        : { name: t('unit.local'), icon: <Laptop size={15} /> }

  return (
    <button
      className="rb-btn unitsw-pill"
      title={expanded ? t('unit.switcher') : `${t('unit.switcher')} · ${current.name}`}
      onClick={() => useApp.getState().openSettings('units')}
    >
      <span className="unitsw-ic">{current.icon}</span>
      {expanded && <span className="rb-label unitsw-name">{current.name}</span>}
    </button>
  )
}

/** 设置 › 设备:原胶囊菜单整页搬家(切换列表 + 互联开关 + 远程会话子开关 + 来访设备)。 */
export function UnitSettings(): React.ReactElement {
  const { t } = useI18n()
  const hostEnabled = useApp((s) => !!s.desktopConfig?.unitHostEnabled)
  const cloudUrl = useApp((s) => s.desktopConfig?.cloudUrl)
  const vaultSide = usePageStore((s) => s.vaultSide)
  const initSide = usePageStore((s) => s.initVaultSide)
  const [units, setUnits] = useState<UnitInfo[] | null>(null)
  const [host, setHost] = useState<{ running: boolean; connected: boolean; unitId: string | null; selfUnitId?: string | null; lanUrl: string | null } | null>(null)
  const [paired, setPaired] = useState<UnitPairedDevice[]>([])
  const [busy, setBusy] = useState(false)
  /** 页内提示:本页可能在浮窗里,浮窗没有通知宿主 —— 出错 / 离线说明就地显示(Codex 评审)。 */
  const [note, setNote] = useState<string | null>(null)
  /** LAN 探针结果(进页时探;true = 该设备的 lanUrl 此刻可达)。 */
  const [lanOk, setLanOk] = useState<Record<string, boolean>>({})
  const [ctxMenu, setCtxMenu] = useState<{ u: UnitInfo; x: number; y: number } | null>(null)
  /** 离线设备缺省折起(10-14 用户定:列表主要看在线的)。 */
  const [offlineOpen, setOfflineOpen] = useState(false)
  /** 来访设备缺省折起(10-17 用户定)。 */
  const [pairedOpen, setPairedOpen] = useState(false)
  /** P1-K4:「允许远程会话」子开关的视图(主进程推送 remoteSessions:changed;没有这座桥的端 = null,不画那一行)。 */
  const [remoteView, setRemoteView] = useState<RemoteSessionsView | null>(null)
  useEffect(() => {
    const api = remoteSessionsApi()
    if (!api) return
    let live = true
    const off = api.onChanged((v) => { if (live) setRemoteView(v) })
    // 只在互联开着时主动取(同 K5 提示:取视图会问设备凭据状态 = 判定钥匙串等级);关着时子开关那行本就不画。
    if (hostEnabled) void api.get().then((v) => { if (live) setRemoteView(v) }).catch(() => {})
    return () => { live = false; off() }
  }, [hostEnabled])
  useEffect(() => { if (window.amadeusSync) void initSide() }, [initSide])

  /** 有云端中转(名册与设备通道都随 Forsion Extend 出现):没有时开关只起局域网面。 */
  const relay = !!window.tangu?.unitsList

  const refresh = async (): Promise<void> => {
    const [list, hs, pd] = await Promise.all([
      window.tangu?.unitsList?.().catch(() => null) ?? null,
      window.tangu?.unitHostStatus?.().catch(() => null) ?? null,
      window.tangu?.unitsPairedList?.().catch(() => []) ?? [],
    ])
    const us = list?.status === 200 ? (list.json?.units ?? []) : list?.status === 401 ? null : []
    setUnits(us)
    if (hs) setHost(hs)
    setPaired(pd || [])
    // LAN 优先(方案 §11.2):对报了直连地址的设备逐台探(1.2s 封顶,渐进点亮)。
    // 不看 online:B 未登录时隧道离线但局域网照样可达 —— 探通了行就能点。
    setLanOk({})
    for (const u of us ?? []) {
      if (!u.lanUrl) continue
      void window.tangu?.unitsProbeLan?.(u.lanUrl)
        .then((meta) => { if (meta) setLanOk((m) => ({ ...m, [u.id]: true })) })
        .catch(() => {})
    }
  }
  useEffect(() => { void refresh() }, [])

  const guard = (fn: () => Promise<void>): void => {
    if (busy) return
    setBusy(true)
    setNote(null)
    void fn().catch((e) => setNote(String((e as Error)?.message || e))).finally(() => setBusy(false))
  }

  /** 去处交给主窗执行并收起设置(浮窗);无浮窗的端就地执行。 */
  const go = (r: UnitRoute): void => {
    if (windowKind() === 'floating' && window.tangu?.requestMainAction) {
      window.tangu.requestMainAction('unit-route', JSON.stringify(r))
      window.tangu.closeSelf?.()
      return
    }
    runUnitRoute(r)
    useApp.getState().closeSettings()
  }

  /** 切到设备页(整个主区切过去)。via 必填:走哪条路由行本身决定,不自动择路
   *  —— 择路会让被顶掉的那条通路在界面上消失。 */
  const openUnit = (u: UnitInfo, via: 'lan' | 'p2p' | 'tunnel'): void => {
    if (via !== 'lan' && !u.online) { setNote(t('unit.offlineNote', { name: u.name })); return }
    go({ kind: 'unit', id: u.id, name: u.name, icon: u.icon, platform: u.platform, via, lanUrl: u.lanUrl, explicit: true })
  }

  const openByAddress = (): void => {
    void askString(t('unit.byAddressAsk'), 'http://').then((v) => {
      const url = normalizeUnitAddress(v ?? '')
      if (url) go({ kind: 'addr', url })
    })
  }

  // 设备行右键 → 小菜单:改图标 / 系统浏览器(server 的 /open 引导页换 cookie 进隧道页)。
  const openCtxMenu = (u: UnitInfo) => (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setCtxMenu({ u, x: e.clientX, y: e.clientY })
  }
  const editIcon = (u: UnitInfo): void => {
    void askString(t('unit.setEmoji'), u.icon || '').then(async (v) => {
      if (v == null) return
      await window.tangu?.unitsUpdate?.(u.id, { icon: v.trim().slice(0, 8) })
      void refresh()
    })
  }

  const toggleHost = (): void => {
    guard(async () => {
      const cur = await window.tangu!.getConfig()
      const next = await window.tangu!.setConfig({ unitHostEnabled: !cur.unitHostEnabled })
      useApp.setState({ desktopConfig: next })
      // 服务与通道要一两秒才起来,稍等再刷状态。
      setTimeout(() => { void refresh() }, 1500)
      void refresh()
    })
  }

  /** P1-K4:子开关只在本机改(主进程 IPC 校验发送方);设备凭据没加密时主进程拒绝,提示换成本地化那句。 */
  const toggleRemoteSessions = (): void => {
    const api = remoteSessionsApi()
    if (!api || !remoteView) return
    guard(async () => {
      try {
        setRemoteView(await api.setEnabled(!(remoteView.enabled && remoteView.permitted === true)))
      } catch (e) {
        const msg = ipcErrorText(e)
        setNote(msg.includes(SECRET_STORE_INSECURE) ? t('remoteSessions.insecure') : t('remoteSessions.actionFailed', { error: msg }))
      }
    })
  }
  const remoteOn = !!remoteView && remoteView.enabled && remoteView.permitted === true
  const remotePermitted = remoteView?.permitted === true

  // 本页可能在浮窗里:远程面状态在主窗,这里不知道正在看哪台 —— 勾选态只跟 vaultSide(本机笔记库在哪一侧)。
  // 本机:互联开着认 unitId;关着时 unitId 为 null,退到 selfUnitId(这次运行里读到过配对才有,没有就不滤)
  const selfId = host?.unitId ?? host?.selfUnitId ?? null
  const listed = units?.filter((u) => u.id !== selfId && u.kind !== 'phone') ?? []
  const isOffline = (u: UnitInfo): boolean => !u.online && !lanOk[u.id]
  const onlineUnits = listed.filter((u) => !isOffline(u))
  const offlineUnits = listed.filter(isOffline)
  const deviceRows = (us: UnitInfo[]): React.ReactElement[] => us.flatMap((u) => {
    // 一台设备 = 每条通路各一行(直连只在探通时出现;P2P = 对端在线且本端有桥;中转恒在,离线灰显)。
    const vias: Array<'lan' | 'p2p' | 'tunnel'> = [
      ...(u.lanUrl && lanOk[u.id] ? ['lan' as const] : []),
      ...(u.online && window.tangu?.unitsP2pOpen ? ['p2p' as const] : []),
      'tunnel' as const,
    ]
    return vias.map((via) => {
      const reachable = via === 'lan' || u.online
      return (
        <button
          key={`${u.id}:${via}`}
          className={`unitsw-row${reachable ? '' : ' off'}`}
          title={reachable ? undefined : t('unit.offlineNote', { name: u.name })}
          onClick={() => openUnit(u, via)}
          onContextMenu={openCtxMenu(u)}
        >
          <span className="unitsw-ic">{deviceIcon(u)}</span>
          <span className="unitsw-col">
            <span className="unitsw-title">
              {u.name}
              <em className="unitsw-via">{t(via === 'lan' ? 'unit.viaLan' : via === 'p2p' ? 'unit.viaP2p' : 'unit.viaTunnel')}</em>
              {!reachable && <em className="unitsw-off">{t('unit.offline')}</em>}
            </span>
            <span className="unitsw-desc">{t(via === 'lan' ? 'unit.deviceLanDesc' : via === 'p2p' ? 'unit.deviceP2pDesc' : 'unit.deviceDesc')}</span>
          </span>
        </button>
      )
    })
  })

  const removePaired = (d: UnitPairedDevice): void => {
    guard(async () => {
      await window.tangu?.unitsPairedRemove?.(d.id)
      void refresh()
    })
  }

  const hostHint = !hostEnabled ? t('unit.hostHint')
    : host?.lanUrl ? t('unit.lanAddr', { addr: host.lanUrl }) : host?.connected ? t('unit.hostConnected') : relay ? t('unit.hostStarting') : t('unit.hostHint')

  return (
    <div className="unitset-page" data-busy={busy || undefined}>
      {note !== null && <div className="rs-alert unitset-note" role="alert">{note}</div>}
      <SettingsPanel anchor="units-switch" icon={<Laptop size={16} />} title={t('unit.switchTitle')} description={t('unit.switchHint')}>
        <div className="unitsw-row-group unitset-list">
          <button className={`unitsw-row${vaultSide !== 'cloud' ? ' on' : ''}`} onClick={() => go({ kind: 'side', side: 'local' })}>
            <span className="unitsw-ic"><Laptop size={15} /></span>
            <span className="unitsw-col">
              <span className="unitsw-title">{t('unit.local')}</span>
              <span className="unitsw-desc">{t('unit.localDesc')}</span>
            </span>
            {vaultSide !== 'cloud' && <Check size={14} className="unitsw-check" />}
          </button>
          {!!window.amadeusSync && (
            <button className={`unitsw-row${vaultSide === 'cloud' ? ' on' : ''}`} onClick={() => go({ kind: 'side', side: 'cloud' })}>
              <span className="unitsw-ic"><Cloud size={15} /></span>
              <span className="unitsw-col">
                <span className="unitsw-title">{t('unit.cloud')}</span>
                <span className="unitsw-desc">{t('unit.cloudDesc')}</span>
              </span>
              {vaultSide === 'cloud' && <Check size={14} className="unitsw-check" />}
            </button>
          )}
          {/* 未登录:可点,直接去登录(W-02) */}
          {units === null && !!window.tangu?.forsionLogin && <button className="unitsw-row" onClick={() => useApp.getState().openSettings('forsion')}>
            {/* 空图标位:文字和上下两行的标题对齐(走查续五 W-57) */}
            <span className="unitsw-ic" aria-hidden="true" />
            <span className="unitsw-col"><span className="unitsw-desc">{t('unit.notLoggedIn')} ›</span></span>
          </button>}
          {/* 手机在 P1 不开设备通道(它是调用方,不是执行设备):滤掉(P1-K1)。
              离线 = 一条能点的通路都没有(隧道不在、直连也没探通);探针渐进点亮,设备会从折叠里「弹出来」。
              三段拼成一个扁平的 keyed 数组:探通后设备跨组时 React 只挪节点、不重挂。 */}
          {[
            ...deviceRows(onlineUnits),
            ...(offlineUnits.length > 0 ? [
              <button key="offline-fold" className="unitsw-row unitsw-fold" aria-expanded={offlineOpen} onClick={() => setOfflineOpen((v) => !v)}>
                <span className="unitsw-col"><span className="unitsw-title">{t('unit.offlineGroup')}<em className="unitsw-via">{offlineUnits.length}</em></span></span>
                <ChevronDown size={13} className="unitsw-fold-chev" />
              </button>,
            ] : []),
            ...(offlineOpen ? deviceRows(offlineUnits) : []),
          ]}
          <button className="unitsw-row" onClick={openByAddress}>
            <span className="unitsw-ic"><Globe size={15} /></span>
            <span className="unitsw-col">
              <span className="unitsw-title">{t('unit.byAddress')}</span>
              <span className="unitsw-desc">{t('unit.byAddressDesc')}</span>
            </span>
          </button>
        </div>
      </SettingsPanel>

      <SettingsPanel anchor="units-host" icon={<MonitorSmartphone size={16} />}
        title={t('unit.hostToggle')} description={<span className="unitset-hint">{hostHint}</span>}
        actions={<SettingsSwitch checked={hostEnabled} disabled={busy} label={t('unit.hostToggle')} onChange={toggleHost} />}>
        {/* P1-K5:设备凭据降级 / 锁定提示(只在互联开着时才问状态 —— 问状态会判定钥匙串等级) */}
        {hostEnabled && <SecretStorageNotice onChange={() => { void refresh() }} className="secnotice-inpanel" />}
        <div className="settings-control-list unitset-rows">
          {/* P1-K4:父开关 → K5 提示 → 远程会话子开关;设备凭据没加密时置灰(K5 提示在上面说明原因) */}
          {hostEnabled && remoteView && (
            <SettingsRow anchor="units-remote" className={remotePermitted ? undefined : 'is-locked'}
              label={t('remoteSessions.switch')}
              description={<button type="button" className="unitsw-sublink" onClick={() => useApp.getState().openSettings('remote-sessions')} data-unitsw-remote-settings="">{t('remoteSessions.openSettings')} ›</button>}
              control={<SettingsSwitch checked={remoteOn} disabled={!remotePermitted || busy} label={t('remoteSessions.switch')} onChange={toggleRemoteSessions} />} />
          )}
          {/* 来访设备(本机已配对、可回收):缺省折起,开头带台数 */}
          {hostEnabled && paired.length > 0 && (
            <div className="unitset-paired" data-setting-anchor="units-paired">
              <button className="unitsw-row unitsw-fold" aria-expanded={pairedOpen} onClick={() => setPairedOpen((v) => !v)}>
                <span className="unitsw-col"><span className="unitsw-title">{t('unit.paired')}<em className="unitsw-via">{paired.length}</em></span></span>
                <ChevronDown size={13} className="unitsw-fold-chev" />
              </button>
              {pairedOpen && paired.map((d) => (
                <div key={d.id} className="unitsw-paired-row">
                  <span className="unitsw-paired-name">{d.name}</span>
                  <button className="unitsw-paired-x" title={t('unit.pairedRemove', { name: d.name })} aria-label={t('unit.pairedRemove', { name: d.name })} onClick={() => removePaired(d)}>
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </SettingsPanel>

      {ctxMenu && createPortal(
        <div className="unitsw-backdrop" onMouseDown={() => setCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null) }}>
          <OverlayAt className="unitsw-menu unitsw-ctx" x={ctxMenu.x} y={ctxMenu.y} onMouseDown={(e) => e.stopPropagation()}>
            <button className="unitsw-row" onClick={() => { const u = ctxMenu.u; setCtxMenu(null); editIcon(u) }}>
              <span className="unitsw-col"><span className="unitsw-title">{t('unit.menuEditIcon')}</span></span>
            </button>
            <button
              className="unitsw-row"
              onClick={() => {
                const u = ctxMenu.u
                setCtxMenu(null)
                // server /open 引导页换 cookie 进隧道页。首选 main 代拼 `#token=`(登录态递交);
                // 旧 preload / harness 无该桥 → 退回裸 /open(引导页自会读 localStorage)。
                void (window.tangu?.unitsOpenInBrowser?.(u.id)
                  ?? window.tangu?.openExternal?.(`${(cloudUrl || '').replace(/\/+$/, '')}/api/units/${u.id}/open`))
              }}
            >
              <span className="unitsw-col"><span className="unitsw-title">{t('unit.menuInBrowser')}</span></span>
            </button>
          </OverlayAt>
        </div>, document.body
      )}
    </div>
  )
}
