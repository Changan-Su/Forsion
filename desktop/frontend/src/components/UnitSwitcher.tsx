/**
 * Forsion Unit 切换器(Ribbon head 常驻件,仅真桌面)。吸收原「本地 | 云端」胶囊(VaultSideSwitch
 * 桌面分支),列表式切换 —— 参考 ChatGPT/Codex 顶部切换器:当前项胶囊 + 展开列表(图标+名称+描述),
 * Ribbon 折叠态只显图标。
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
 * 设备行图标可自定义 emoji(右键行);菜单脚部 = 「允许其他设备连接本机」开关 + 本机直连地址 +
 * 已配对来访设备回收(无回收的配对不许上线)。
 */
import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { Check, ChevronDown, Cloud, Globe, Laptop, Monitor, Smartphone, X } from 'lucide-react'
import { OverlayAt } from '@lcl/engine'
import { useApp } from '../stores/appStore'
import { usePageStore } from '../amadeus/store/pageStore'
import { notifyApp } from '../stores/notificationStore'
import { askString } from '../amadeus/components/askString'
import { Webview } from '../builtins/browserView'
import { BROWSER_PARTITION } from '../../../shared/browser'
import { registerMessages, useI18n } from '../i18n'
import type { UnitInfo, UnitPairedDevice } from '../types'
import '../styles/unitSwitcher.css'

registerMessages({
  'unit.local': { zh: '本地', en: 'Local' },
  'unit.cloud': { zh: '云端', en: 'Cloud' },
  'unit.localDesc': { zh: '本机引擎与本地笔记库', en: 'Local engine and vault' },
  'unit.cloudDesc': { zh: '云端笔记库(引擎照旧)', en: 'Cloud vault (engine unchanged)' },
  'unit.deviceDesc': { zh: '经云端中转,异地也能用', en: 'Via cloud relay — works anywhere' },
  'unit.deviceLanDesc': { zh: '同一局域网直连,更快', en: 'Direct over LAN — faster' },
  'unit.viaLan': { zh: '直连', en: 'Direct' },
  'unit.viaP2p': { zh: 'P2P', en: 'P2P' },
  'unit.viaTunnel': { zh: '中转', en: 'Relay' },
  'unit.deviceP2pDesc': { zh: '打洞直连,流量不过服务器', en: 'Hole-punched direct — no relay traffic' },
  'unit.p2pConnecting': { zh: '正在与「{name}」打洞直连…', en: 'Hole-punching to "{name}"…' },
  'unit.p2pFallback': { zh: 'P2P 未接通({why}),已回落云端中转', en: 'P2P failed ({why}) — fell back to cloud relay' },
  'unit.menuEditIcon': { zh: '自定义图标(emoji)', en: 'Set icon (emoji)' },
  'unit.menuInBrowser': { zh: '在系统浏览器打开', en: 'Open in system browser' },
  'unit.offline': { zh: '离线', en: 'Offline' },
  'unit.offlineNote': { zh: '「{name}」不在线:需在那台设备上开着 Forsion 并启用互联', en: '"{name}" is offline — open Forsion on that device with connect enabled' },
  'unit.byAddress': { zh: '通过地址连接…', en: 'Connect by address…' },
  'unit.byAddressDesc': { zh: '同一局域网直连:http://<IP>:<端口>', en: 'Same-LAN direct: http://<ip>:<port>' },
  'unit.byAddressAsk': { zh: '对方设备的直连地址(在其切换器脚部可见)', en: "The device's direct address (shown in its switcher footer)" },
  'unit.hostToggle': { zh: '允许其他设备连接本机', en: 'Allow other devices to connect' },
  'unit.hostConnected': { zh: '互联通道已连接', en: 'Connect channel online' },
  'unit.hostStarting': { zh: '通道连接中…(需登录 Forsion;局域网直连不受影响)', en: 'Channel connecting… (login required; LAN direct unaffected)' },
  'unit.lanAddr': { zh: '本机直连地址:{addr}', en: 'Direct address: {addr}' },
  'unit.paired': { zh: '已配对设备', en: 'Paired devices' },
  'unit.pairedRemove': { zh: '移除「{name}」的连接权限?', en: 'Revoke access for "{name}"?' },
  'unit.setEmoji': { zh: '设备图标(输入一个 emoji,留空恢复默认)', en: 'Device icon (one emoji; empty = default)' },
  'unit.switcher': { zh: 'Forsion Unit 切换', en: 'Switch Forsion Unit' },
  'unit.notLoggedIn': { zh: '登录 Forsion 账号后可见你的其他设备', en: 'Sign in to see your other devices' },
})

function deviceIcon(u: { icon?: string | null; platform?: string | null }, size = 15): React.ReactNode {
  if (u.icon) return <span className="unitsw-emoji" aria-hidden>{u.icon}</span>
  if (u.platform === 'android' || u.platform === 'ios') return <Smartphone size={size} />
  if (u.platform === 'win32' || u.platform === 'linux') return <Monitor size={size} />
  return <Laptop size={size} />
}

/** 设备的隧道页地址:经 server 通用隧道回到该设备的 unitWeb(尾斜杠必须留 —— 页面用相对 base)。 */
function tunnelPageUrl(cloudUrl: string | undefined, unitId: string): string {
  return `${(cloudUrl || '').replace(/\/+$/, '')}/api/units/${unitId}/proxy/`
}

/** 当前远程面目标。key = `<设备 id>:<lan|tunnel>` 或 `addr:<url>`(手输地址)——
 *  同一台设备的两条通路是两个目标,勾选态才落得到点中的那一行;hide 不清 target —— webview
 *  保活在暗处,切回来免重载(换目标才按 url 重挂)。 */
export interface UnitRemoteTarget {
  key: string
  name: string
  icon?: string | null
  platform?: string | null
  url: string
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

/** 设备远程面:portal 进 .shell-work,盖满「tab 栏 + 内容 + 侧栏 + 状态栏」而留下 ribbon 与
 *  mac 标题条 —— 观感 = 整个主区切换到那台设备,胶囊(显示当前设备)就是回来的路。
 *  ⚠️ 根必须 no-drag 且 DOM 晚于被盖的拖窗条(拖窗区按 DOM 顺序几何合成、无视 z-index,
 *  见 base.css「Electron 拖窗区兜底」);portal 追加在 .shell-work 末尾天然满足。 */
export function UnitRemoteSurface(): React.ReactElement | null {
  const target = useUnitRemote((s) => s.target)
  const active = useUnitRemote((s) => s.active)
  const webRef = useRef<HTMLElement>(null)
  // 切进来把键盘直接交给对方页面(不点一下打不了字)。
  useEffect(() => { if (active) webRef.current?.focus() }, [active, target?.url])
  // 点了本机 ribbon 的视图槽(视图图标 / Space)= 用户要回本机 —— Space 切换语义,自动退场。
  // 头部胶囊与尾部账号/设置不算:它们开的是浮层,盖在远程面之上,关掉还该在设备页里。
  useEffect(() => {
    if (!active) return
    const onClick = (e: MouseEvent): void => {
      if ((e.target as HTMLElement | null)?.closest?.('.rb-slot')) useUnitRemote.getState().hide()
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [active])
  if (!target) return null
  // 渲染期查询而非挂载期缓存:target/active 每变一次都重查,Shell 罕见重挂后切一次设备即自愈。
  const host = document.querySelector('.shell-work')
  // 无 Shell 的 fixed 兜底必须量 ribbon 实宽:展开态 ribbon 远宽于 44px,写死会把胶囊(回来的路)盖死。
  const freeLeft = host ? undefined : (document.querySelector('.rb') as HTMLElement | null)?.offsetWidth
  const node = (
    <div className={`unitrs${active ? '' : ' unitrs-hidden'}`} style={freeLeft != null ? { left: freeLeft } : undefined}>
      <Webview ref={webRef} key={target.url} className="unitrs-web" src={target.url} partition={BROWSER_PARTITION} allowpopups="true" />
    </div>
  )
  return host ? createPortal(node, host) : node // 无 Shell(harness/web)→ 原地渲染,CSS 退化为 fixed 覆盖层
}

export function UnitSwitcher({ expanded }: { expanded: boolean }): React.ReactElement {
  const { t } = useI18n()
  const cloudUrl = useApp((s) => s.desktopConfig?.cloudUrl)
  const hostEnabled = useApp((s) => !!s.desktopConfig?.unitHostEnabled)
  const vaultSide = usePageStore((s) => s.vaultSide)
  const initSide = usePageStore((s) => s.initVaultSide)
  const [open, setOpen] = useState(false)
  const [units, setUnits] = useState<UnitInfo[] | null>(null)
  const [host, setHost] = useState<{ running: boolean; connected: boolean; unitId: string | null; lanUrl: string | null } | null>(null)
  const [paired, setPaired] = useState<UnitPairedDevice[]>([])
  const [busy, setBusy] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)
  /** LAN 探针结果(菜单每次展开时重探;true = 该设备的 lanUrl 此刻可达)。 */
  const [lanOk, setLanOk] = useState<Record<string, boolean>>({})
  const [ctxMenu, setCtxMenu] = useState<{ u: UnitInfo; x: number; y: number } | null>(null)

  // 原 VaultSideSwitch 桌面分支负责的 vaultSide 初始化,随胶囊迁到这里。
  useEffect(() => { if (window.amadeusSync) void initSide() }, [initSide])

  const say = (text: string): void => { notifyApp({ text, event: 'system.unit' }) }

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
    // LAN 优先自动择路(方案 §11.2):对报了直连地址的设备逐台探(1.2s 封顶,渐进点亮)。
    // 不看 online:B 未登录时隧道离线但局域网照样可达 —— 探通了行就能点。
    setLanOk({})
    for (const u of us ?? []) {
      if (!u.lanUrl) continue
      void window.tangu?.unitsProbeLan?.(u.lanUrl)
        .then((meta) => { if (meta) setLanOk((m) => ({ ...m, [u.id]: true })) })
        .catch(() => {})
    }
  }

  const toggleOpen = (): void => {
    if (!open) {
      const r = btnRef.current?.getBoundingClientRect()
      setAnchor(r ? { x: r.right + 8, y: r.top } : { x: 52, y: 48 })
      void refresh()
    }
    setOpen(!open)
  }

  // 远程面激活时,胶囊当前项 = 那台设备(它同时是回来的路);否则照旧跟 vaultSide。
  const remote = useUnitRemote()
  const current: { key: 'local' | 'cloud' | 'unit'; name: string; icon: React.ReactNode } =
    remote.active && remote.target
      ? { key: 'unit', name: remote.target.name, icon: deviceIcon(remote.target) }
      : vaultSide === 'cloud'
        ? { key: 'cloud', name: t('unit.cloud'), icon: <Cloud size={15} /> }
        : { key: 'local', name: t('unit.local'), icon: <Laptop size={15} /> }

  const guard = (fn: () => Promise<void>): void => {
    if (busy) return
    setBusy(true)
    void fn().catch((e) => say(String((e as Error)?.message || e))).finally(() => setBusy(false))
  }

  const pickLocalSide = (side: 'local' | 'cloud'): void => {
    setOpen(false)
    useUnitRemote.getState().hide() // 从设备页切回本机(target 保留 = webview 保活,再切回去免重载)
    guard(async () => {
      if (window.amadeusSync && usePageStore.getState().vaultSide !== side) await usePageStore.getState().switchVaultSide(side)
    })
  }

  /** 切到设备页(整个主区切过去)。via 必填:走哪条路由行本身决定,不再自动择路
   *  —— 择路会让被顶掉的那条通路在界面上消失。不发通知:切换本身就是可见结果。
   *  p2p 档特殊:打洞是异步的,失败**出声回落**中转(拆行拍板管的是选项可见性,不禁优雅降级)。 */
  const openUnit = (u: UnitInfo, via: 'lan' | 'p2p' | 'tunnel'): void => {
    const to = (url: string, key = `${u.id}:${via}`): void => {
      setOpen(false)
      useUnitRemote.getState().open({ key, name: u.name, icon: u.icon, platform: u.platform, url })
    }
    if (via === 'lan' && u.lanUrl) return to(u.lanUrl.endsWith('/') ? u.lanUrl : `${u.lanUrl}/`)
    if (!u.online) { say(t('unit.offlineNote', { name: u.name })); return }
    if (via === 'p2p') {
      setOpen(false)
      say(t('unit.p2pConnecting', { name: u.name }))
      guard(async () => {
        try {
          const r = await window.tangu!.unitsP2pOpen!(u.id)
          to(r.url)
        } catch (e) {
          say(t('unit.p2pFallback', { why: String((e as Error)?.message || e) }))
          to(tunnelPageUrl(cloudUrl, u.id), `${u.id}:tunnel`) // 回落即中转:key 归中转行,勾选态如实
        }
      })
      return
    }
    to(tunnelPageUrl(cloudUrl, u.id))
  }

  const openByAddress = (): void => {
    setOpen(false)
    void askString(t('unit.byAddressAsk'), 'http://').then((v) => {
      const raw = v?.trim()
      if (!raw) return
      const base = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
      const url = base.endsWith('/') ? base : `${base}/`
      // 手输地址没有名册条目:key 带 addr: 前缀防与设备 id 撞,名字就用主机段。
      useUnitRemote.getState().open({ key: `addr:${url}`, name: base.replace(/^https?:\/\//i, ''), url })
    })
  }

  // 设备行右键 → 小菜单:改图标 / 系统浏览器(server 的 /open 引导页换 cookie 进隧道页,
  // v2.1 浏览器直开 T2)。原「经云端中转打开」已退役 —— 中转是列表里的一等行,不必再藏右键。
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
      useApp.setState({ desktopConfig: next }) // 开关立刻反映到胶囊脚部(boot 之外没人回填 desktopConfig)
      // 服务与通道要一两秒才起来,稍等再刷状态(菜单开着就能看到地址与点亮)。
      setTimeout(() => { void refresh() }, 1500)
      void refresh()
    })
  }

  const removePaired = (d: UnitPairedDevice): void => {
    guard(async () => {
      await window.tangu?.unitsPairedRemove?.(d.id)
      void refresh()
    })
  }

  return (
    <>
      <button
        ref={btnRef}
        className={`rb-btn unitsw-pill${open ? ' on' : ''}`}
        title={expanded ? undefined : `${t('unit.switcher')} · ${current.name}`}
        onClick={toggleOpen}
        data-busy={busy || undefined}
      >
        <span className="unitsw-ic">{current.icon}</span>
        {expanded && <span className="rb-label unitsw-name">{current.name}</span>}
        {expanded && <ChevronDown size={12} className="unitsw-chev" />}
      </button>
      {open && anchor && (
        <div className="unitsw-backdrop" onMouseDown={() => setOpen(false)} onContextMenu={(e) => { e.preventDefault(); setOpen(false) }}>
          <OverlayAt className="unitsw-menu" x={anchor.x} y={anchor.y} onMouseDown={(e) => e.stopPropagation()}>
            <div className="unitsw-row-group">
              <button className={`unitsw-row${current.key === 'local' ? ' on' : ''}`} onClick={() => pickLocalSide('local')}>
                <span className="unitsw-ic"><Laptop size={15} /></span>
                <span className="unitsw-col">
                  <span className="unitsw-title">{t('unit.local')}</span>
                  <span className="unitsw-desc">{t('unit.localDesc')}</span>
                </span>
                {current.key === 'local' && <Check size={14} className="unitsw-check" />}
              </button>
              {!!window.amadeusSync && (
                <button className={`unitsw-row${current.key === 'cloud' ? ' on' : ''}`} onClick={() => pickLocalSide('cloud')}>
                  <span className="unitsw-ic"><Cloud size={15} /></span>
                  <span className="unitsw-col">
                    <span className="unitsw-title">{t('unit.cloud')}</span>
                    <span className="unitsw-desc">{t('unit.cloudDesc')}</span>
                  </span>
                  {current.key === 'cloud' && <Check size={14} className="unitsw-check" />}
                </button>
              )}
              {units === null && <div className="unitsw-empty">{t('unit.notLoggedIn')}</div>}
              {units?.filter((u) => u.id !== host?.unitId).flatMap((u) => {
                // 一台设备 = 每条通路各一行。此前是一行 + 自动择路:LAN 探通就把「中转」那条路
                // 悄悄顶掉,界面上等于不存在(用户找了两轮没找到)。拆开显式列,想走哪条点哪条。
                // 直连行只在探通时出现(探不通的地址点了也是白点);中转行恒在,离线灰显 + 就地提示。
                // P2P 行:对端在线(信令要走隧道)且本端有桥就出——不支持的旧对端点了会 501,
                // openUnit 出声回落中转(advisor 裁决:不做名册能力探测,失败面即协商面)。
                const vias: Array<'lan' | 'p2p' | 'tunnel'> = [
                  ...(u.lanUrl && lanOk[u.id] ? ['lan' as const] : []),
                  ...(u.online && window.tangu?.unitsP2pOpen ? ['p2p' as const] : []),
                  'tunnel' as const,
                ]
                return vias.map((via) => {
                  const reachable = via === 'lan' || u.online // 隧道离线但 LAN 探通(如 B 未登录)照样能点
                  const on = remote.active && remote.target?.key === `${u.id}:${via}`
                  return (
                    <button
                      key={`${u.id}:${via}`}
                      className={`unitsw-row${reachable ? '' : ' off'}${on ? ' on' : ''}`}
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
                      {on && <Check size={14} className="unitsw-check" />}
                    </button>
                  )
                })
              })}
              <button className="unitsw-row" onClick={openByAddress}>
                <span className="unitsw-ic"><Globe size={15} /></span>
                <span className="unitsw-col">
                  <span className="unitsw-title">{t('unit.byAddress')}</span>
                  <span className="unitsw-desc">{t('unit.byAddressDesc')}</span>
                </span>
              </button>
            </div>
            <div className="unitsw-foot">
              <button className="unitsw-hosttoggle" onClick={toggleHost} data-on={hostEnabled || undefined}>
                <span className={`unitsw-dot${host?.connected ? ' live' : hostEnabled ? ' wait' : ''}`} />
                <span className="unitsw-foot-label">{t('unit.hostToggle')}</span>
                <span className="unitsw-switch" aria-hidden />
              </button>
              {hostEnabled && (
                <div className="unitsw-foot-hint">
                  {host?.lanUrl ? t('unit.lanAddr', { addr: host.lanUrl }) : host?.connected ? t('unit.hostConnected') : t('unit.hostStarting')}
                </div>
              )}
              {hostEnabled && paired.length > 0 && (
                <div className="unitsw-pairedbox">
                  <div className="unitsw-paired-head">{t('unit.paired')}</div>
                  {paired.map((d) => (
                    <div key={d.id} className="unitsw-paired-row">
                      <span className="unitsw-paired-name">{d.name}</span>
                      <button className="unitsw-paired-x" title={t('unit.pairedRemove', { name: d.name })} onClick={() => removePaired(d)}>
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </OverlayAt>
        </div>
      )}
      {ctxMenu && (
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
                setOpen(false)
                // server /open 引导页换 cookie 进隧道页。首选 main 代拼 `#token=`(登录态递交:系统浏览器
                // 多半没登录过网页版,同源 localStorage 读不到 token;forsion_token 不下发渲染层故须 IPC)。
                // 旧 preload / harness 无该桥 → 退回裸 /open(引导页自会读 localStorage,行为同旧)。
                void (window.tangu?.unitsOpenInBrowser?.(u.id)
                  ?? window.tangu?.openExternal?.(`${(cloudUrl || '').replace(/\/+$/, '')}/api/units/${u.id}/open`))
              }}
            >
              <span className="unitsw-col"><span className="unitsw-title">{t('unit.menuInBrowser')}</span></span>
            </button>
          </OverlayAt>
        </div>
      )}
    </>
  )
}
