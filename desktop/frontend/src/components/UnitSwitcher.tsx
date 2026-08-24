/**
 * Forsion Unit 切换器(Ribbon head 常驻件,仅真桌面)。吸收原「本地 | 云端」胶囊(VaultSideSwitch
 * 桌面分支),列表式切换 —— 参考 ChatGPT/Codex 顶部切换器:当前项胶囊 + 展开列表(图标+名称+描述),
 * Ribbon 折叠态只显图标。
 *
 * v2(B 端渲染,方案 §11):
 *   本地 / 云端 = 原胶囊语义原样搬家(只切 vault side,勾选态跟 vaultSide);
 *   设备 X     = **打开这台设备曝出来的网页**(server 隧道页,内置浏览器标签承载;
 *                Authorization 由主进程在浏览器分区对隧道前缀注入);
 *   通过地址连接… = T1 局域网直连:手输 http://<ip>:<端口>,配对验证在对方页面里走。
 * 设备行图标可自定义 emoji(右键行);菜单脚部 = 「允许其他设备连接本机」开关 + 本机直连地址 +
 * 已配对来访设备回收(无回收的配对不许上线)。
 */
import React, { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Cloud, Globe, Laptop, Monitor, Smartphone, X } from 'lucide-react'
import { OverlayAt } from '@lcl/engine'
import { useApp } from '../stores/appStore'
import { usePageStore } from '../amadeus/store/pageStore'
import { notifyApp } from '../stores/notificationStore'
import { askString } from '../amadeus/components/askString'
import { openBrowser } from '../builtins'
import { registerMessages, useI18n } from '../i18n'
import type { UnitInfo, UnitPairedDevice } from '../types'
import '../styles/unitSwitcher.css'

registerMessages({
  'unit.local': { zh: '本地', en: 'Local' },
  'unit.cloud': { zh: '云端', en: 'Cloud' },
  'unit.localDesc': { zh: '本机引擎与本地笔记库', en: 'Local engine and vault' },
  'unit.cloudDesc': { zh: '云端笔记库(引擎照旧)', en: 'Cloud vault (engine unchanged)' },
  'unit.deviceDesc': { zh: '打开这台设备的 Forsion(远程页面)', en: "Open this device's Forsion (remote page)" },
  'unit.deviceLanDesc': { zh: '同一局域网:直连打开(更快)', en: 'Same LAN: opens via direct connection (faster)' },
  'unit.menuEditIcon': { zh: '自定义图标(emoji)', en: 'Set icon (emoji)' },
  'unit.menuViaTunnel': { zh: '经云端中转打开', en: 'Open via cloud relay' },
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
  'unit.opened': { zh: '已在新标签页打开「{name}」', en: 'Opened "{name}" in a new tab' },
})

function deviceIcon(u: UnitInfo, size = 15): React.ReactNode {
  if (u.icon) return <span className="unitsw-emoji" aria-hidden>{u.icon}</span>
  if (u.platform === 'android' || u.platform === 'ios') return <Smartphone size={size} />
  if (u.platform === 'win32' || u.platform === 'linux') return <Monitor size={size} />
  return <Laptop size={size} />
}

/** 设备的隧道页地址:经 server 通用隧道回到该设备的 unitWeb(尾斜杠必须留 —— 页面用相对 base)。 */
function tunnelPageUrl(cloudUrl: string | undefined, unitId: string): string {
  return `${(cloudUrl || '').replace(/\/+$/, '')}/api/units/${unitId}/proxy/`
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

  const current: { key: 'local' | 'cloud'; name: string; icon: React.ReactNode } =
    vaultSide === 'cloud'
      ? { key: 'cloud', name: t('unit.cloud'), icon: <Cloud size={15} /> }
      : { key: 'local', name: t('unit.local'), icon: <Laptop size={15} /> }

  const guard = (fn: () => Promise<void>): void => {
    if (busy) return
    setBusy(true)
    void fn().catch((e) => say(String((e as Error)?.message || e))).finally(() => setBusy(false))
  }

  const pickLocalSide = (side: 'local' | 'cloud'): void => {
    setOpen(false)
    guard(async () => {
      if (window.amadeusSync && usePageStore.getState().vaultSide !== side) await usePageStore.getState().switchVaultSide(side)
    })
  }

  /** 打开设备页:LAN 探通优先直连,否则走隧道(via 显式指定时不择路 —— 右键「经云端中转」的逃生口)。 */
  const openUnit = (u: UnitInfo, via?: 'lan' | 'tunnel'): void => {
    const mode = via ?? (u.lanUrl && lanOk[u.id] ? 'lan' : 'tunnel')
    if (mode === 'lan' && u.lanUrl) {
      setOpen(false)
      openBrowser(u.lanUrl.endsWith('/') ? u.lanUrl : `${u.lanUrl}/`)
      say(t('unit.opened', { name: u.name }))
      return
    }
    if (!u.online) { say(t('unit.offlineNote', { name: u.name })); return }
    setOpen(false)
    openBrowser(tunnelPageUrl(cloudUrl, u.id))
    say(t('unit.opened', { name: u.name }))
  }

  const openByAddress = (): void => {
    setOpen(false)
    void askString(t('unit.byAddressAsk'), 'http://').then((v) => {
      const raw = v?.trim()
      if (!raw) return
      const url = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
      openBrowser(url.endsWith('/') ? url : `${url}/`)
    })
  }

  // 设备行右键 → 小菜单:改图标 / 经云端中转(LAN 自动择路的逃生口,对面没人点配对框时用)/
  // 系统浏览器(server 的 /open 引导页换 cookie 进隧道页,v2.1 浏览器直开 T2)。
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
              {units?.filter((u) => u.id !== host?.unitId).map((u) => {
                const lan = !!(u.lanUrl && lanOk[u.id])
                const reachable = u.online || lan // 隧道离线但 LAN 探通(如 B 未登录)照样能点
                return (
                  <button
                    key={u.id}
                    className={`unitsw-row${reachable ? '' : ' off'}`}
                    onClick={() => openUnit(u)}
                    onContextMenu={openCtxMenu(u)}
                  >
                    <span className="unitsw-ic">{deviceIcon(u)}</span>
                    <span className="unitsw-col">
                      <span className="unitsw-title">{u.name}{!reachable && <em className="unitsw-off">{t('unit.offline')}</em>}</span>
                      <span className="unitsw-desc">{lan ? t('unit.deviceLanDesc') : t('unit.deviceDesc')}</span>
                    </span>
                  </button>
                )
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
            <button className="unitsw-row" onClick={() => { const u = ctxMenu.u; setCtxMenu(null); openUnit(u, 'tunnel') }}>
              <span className="unitsw-col"><span className="unitsw-title">{t('unit.menuViaTunnel')}</span></span>
            </button>
            <button
              className="unitsw-row"
              onClick={() => {
                const u = ctxMenu.u
                setCtxMenu(null)
                setOpen(false)
                // server /open 引导页:同源 localStorage 的 forsion_token 换 HttpOnly cookie 再进隧道页。
                void window.tangu?.openExternal?.(`${(cloudUrl || '').replace(/\/+$/, '')}/api/units/${u.id}/open`)
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
