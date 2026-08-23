/**
 * Forsion Unit 切换器(Ribbon head 常驻件,仅真桌面):吸收原「本地 | 云端」胶囊(VaultSideSwitch
 * 桌面分支),推广为列表式 Unit 切换 —— 参考 ChatGPT/Codex 顶部切换器:当前项胶囊 + 展开列表
 * (每行 图标 + 名称 + 描述 + 选中勾),Ribbon 折叠态只显图标。
 *
 * 条目语义(方案 §4.5「三元组塌缩」,勿重开):
 *   本地 / 云端 = 原胶囊语义原样搬家(只切 vault side,引擎不动);
 *   设备 X     = 引擎 + 插件整体 attach 对方(mode='unit' 经 server 隧道);**笔记库暂不跟随**,
 *               行描述里写明(P1.5 远程库接上后摘掉)。
 * 设备行图标可自定义 emoji(右键行 → 输入,落名册 PATCH /units/:id)。
 * 菜单脚部内联「允许其他设备连接本机」开关(B 侧启用入口,P1 不进设置页)。
 */
import React, { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Cloud, Laptop, Monitor, RefreshCw, Smartphone } from 'lucide-react'
import { OverlayAt } from '@lcl/engine'
import { useApp } from '../stores/appStore'
import { usePageStore } from '../amadeus/store/pageStore'
import { usePluginStore } from '../amadeus/plugins/pluginStore'
import { notifyApp } from '../stores/notificationStore'
import { askString } from '../amadeus/components/askString'
import { registerMessages, useI18n } from '../i18n'
import type { StoredDesktopConfig, UnitInfo } from '../types'
import '../styles/unitSwitcher.css'

registerMessages({
  'unit.local': { zh: '本地', en: 'Local' },
  'unit.cloud': { zh: '云端', en: 'Cloud' },
  'unit.localDesc': { zh: '本机引擎与本地笔记库', en: 'Local engine and vault' },
  'unit.cloudDesc': { zh: '云端笔记库(引擎照旧)', en: 'Cloud vault (engine unchanged)' },
  'unit.deviceDesc': { zh: '远程引擎与插件(笔记库暂不跟随)', en: 'Remote engine & plugins (vault stays local)' },
  'unit.offline': { zh: '离线', en: 'Offline' },
  'unit.self': { zh: '本机', en: 'This device' },
  'unit.offlineNote': { zh: '「{name}」不在线:需在那台设备上开着 Forsion 并启用互联', en: '"{name}" is offline — open Forsion on that device with connect enabled' },
  'unit.attached': { zh: '已切换到「{name}」', en: 'Switched to "{name}"' },
  'unit.detached': { zh: '已切回本地', en: 'Back to local' },
  'unit.attachFailed': { zh: '切换失败:{msg}', en: 'Switch failed: {msg}' },
  'unit.hostToggle': { zh: '允许其他设备连接本机', en: 'Allow other devices to connect' },
  'unit.hostConnected': { zh: '互联通道已连接', en: 'Connect channel online' },
  'unit.hostStarting': { zh: '通道连接中…', en: 'Channel connecting…' },
  'unit.setEmoji': { zh: '设备图标(输入一个 emoji,留空恢复默认)', en: 'Device icon (one emoji; empty = default)' },
  'unit.switcher': { zh: 'Forsion Unit 切换', en: 'Switch Forsion Unit' },
  'unit.notLoggedIn': { zh: '登录 Forsion 账号后可连接其他设备', en: 'Sign in to connect your other devices' },
})

const PREV_MODE_KEY = 'tangu.unit.prevMode'

/** setConfig 之后的统一收尾:回填 appStore.cfg、接引擎、重载插件面。
 *  插件来源不在这里指定 —— pluginStore.loadExternal 按 desktopConfig 现场派生(冷启动同一条路)。 */
function applyCfg(c: StoredDesktopConfig): void {
  useApp.setState({ desktopConfig: c, desktopMode: c.mode, cfg: { backendUrl: c.backendUrl, token: c.token, modelId: c.modelId } })
  if (c.mode === 'unit') {
    void useApp.getState().connect({ backendUrl: c.backendUrl, token: c.token, modelId: c.modelId })
  } else if (c.mode === 'external' && c.token) {
    // managed 由 onBackendStatus 的 ready 分支自动接管(引擎正在被主进程拉起);external 直接连。
    void useApp.getState().connect({ backendUrl: c.backendUrl, token: c.token, modelId: c.modelId })
  }
  void usePluginStore.getState().reloadExternal()
}

async function attachUnit(unitId: string): Promise<void> {
  const cur = await window.tangu!.getConfig()
  if (cur.mode !== 'unit') { try { localStorage.setItem(PREV_MODE_KEY, cur.mode) } catch { /* ignore */ } }
  applyCfg(await window.tangu!.setConfig({ mode: 'unit', unitId }))
}

async function detachToLocal(): Promise<void> {
  const cur = await window.tangu!.getConfig()
  if (cur.mode !== 'unit') return
  let prev: 'managed' | 'external' = 'managed'
  try { const v = localStorage.getItem(PREV_MODE_KEY); if (v === 'external') prev = 'external' } catch { /* ignore */ }
  applyCfg(await window.tangu!.setConfig({ mode: prev }))
}

function deviceIcon(u: UnitInfo, size = 15): React.ReactNode {
  if (u.icon) return <span className="unitsw-emoji" aria-hidden>{u.icon}</span>
  if (u.platform === 'android' || u.platform === 'ios') return <Smartphone size={size} />
  if (u.platform === 'win32' || u.platform === 'linux') return <Monitor size={size} />
  return <Laptop size={size} />
}

export function UnitSwitcher({ expanded }: { expanded: boolean }): React.ReactElement {
  const { t } = useI18n()
  const mode = useApp((s) => s.desktopConfig?.mode)
  const unitId = useApp((s) => s.desktopConfig?.unitId)
  const vaultSide = usePageStore((s) => s.vaultSide)
  const initSide = usePageStore((s) => s.initVaultSide)
  const [open, setOpen] = useState(false)
  const [units, setUnits] = useState<UnitInfo[] | null>(null)
  const [host, setHost] = useState<{ running: boolean; connected: boolean; unitId: string | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)

  // 原 VaultSideSwitch 桌面分支负责的 vaultSide 初始化,随胶囊迁到这里。
  useEffect(() => { if (window.amadeusSync) void initSide() }, [initSide])
  // unit 模式冷启动:名册没拉之前胶囊只能显示占位名 —— 主动拉一次,让当前设备的名字/emoji 上位。
  useEffect(() => { if (mode === 'unit') void refresh() }, [mode]) // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = async (): Promise<void> => {
    const [list, hs] = await Promise.all([
      window.tangu?.unitsList?.().catch(() => null) ?? null,
      window.tangu?.unitHostStatus?.().catch(() => null) ?? null,
    ])
    setUnits(list?.status === 200 ? (list.json?.units ?? []) : list?.status === 401 ? null : [])
    if (hs) setHost(hs)
  }

  const toggleOpen = (): void => {
    if (!open) {
      const r = btnRef.current?.getBoundingClientRect()
      setAnchor(r ? { x: r.right + 8, y: r.top } : { x: 52, y: 48 })
      void refresh()
    }
    setOpen(!open)
  }

  // 当前条目
  const current: { key: string; name: string; icon: React.ReactNode } = (() => {
    if (mode === 'unit' && unitId) {
      const u = units?.find((x) => x.id === unitId)
      return { key: `unit:${unitId}`, name: u?.name || t('unit.switcher'), icon: u ? deviceIcon(u) : <Laptop size={15} /> }
    }
    if (vaultSide === 'cloud') return { key: 'cloud', name: t('unit.cloud'), icon: <Cloud size={15} /> }
    return { key: 'local', name: t('unit.local'), icon: <Laptop size={15} /> }
  })()

  const say = (text: string): void => { notifyApp({ text, event: 'system.unit' }) }
  const guard = (fn: () => Promise<void>): void => {
    if (busy) return
    setBusy(true)
    void fn().catch((e) => say(t('unit.attachFailed', { msg: String((e as Error)?.message || e) }))).finally(() => setBusy(false))
  }

  const pickLocalSide = (side: 'local' | 'cloud'): void => {
    setOpen(false)
    guard(async () => {
      if (mode === 'unit') await detachToLocal()
      if (window.amadeusSync && usePageStore.getState().vaultSide !== side) await usePageStore.getState().switchVaultSide(side)
      if (mode === 'unit') say(t('unit.detached'))
    })
  }

  const pickUnit = (u: UnitInfo): void => {
    if (!u.online) { say(t('unit.offlineNote', { name: u.name })); return }
    setOpen(false)
    guard(async () => {
      await attachUnit(u.id)
      say(t('unit.attached', { name: u.name }))
    })
  }

  const editIcon = (u: UnitInfo) => (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    void askString(t('unit.setEmoji'), u.icon || '').then(async (v) => {
      if (v == null) return
      await window.tangu?.unitsUpdate?.(u.id, { icon: v.trim().slice(0, 8) })
      void refresh()
    })
  }

  const toggleHost = (): void => {
    guard(async () => {
      const cur = await window.tangu!.getConfig()
      await window.tangu!.setConfig({ unitHostEnabled: !cur.unitHostEnabled })
      // 通道要一两秒才挂上,稍等再刷状态(菜单开着就能看到点亮)。
      setTimeout(() => { void refresh() }, 1500)
      void refresh()
    })
  }

  const hostEnabled = useApp((s) => !!s.desktopConfig?.unitHostEnabled)

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
              {units?.filter((u) => u.id !== host?.unitId).map((u) => (
                <button
                  key={u.id}
                  className={`unitsw-row${current.key === `unit:${u.id}` ? ' on' : ''}${u.online ? '' : ' off'}`}
                  onClick={() => pickUnit(u)}
                  onContextMenu={editIcon(u)}
                >
                  <span className="unitsw-ic">{deviceIcon(u)}</span>
                  <span className="unitsw-col">
                    <span className="unitsw-title">{u.name}{!u.online && <em className="unitsw-off">{t('unit.offline')}</em>}</span>
                    <span className="unitsw-desc">{t('unit.deviceDesc')}</span>
                  </span>
                  {current.key === `unit:${u.id}` && <Check size={14} className="unitsw-check" />}
                </button>
              ))}
            </div>
            <div className="unitsw-foot">
              <button className="unitsw-hosttoggle" onClick={toggleHost} data-on={hostEnabled || undefined}>
                <span className={`unitsw-dot${host?.connected ? ' live' : hostEnabled ? ' wait' : ''}`} />
                <span className="unitsw-foot-label">{t('unit.hostToggle')}</span>
                <span className="unitsw-switch" aria-hidden />
              </button>
              {hostEnabled && (
                <div className="unitsw-foot-hint">
                  {host?.connected ? t('unit.hostConnected') : t('unit.hostStarting')}
                  <button className="unitsw-refresh" title="refresh" onClick={() => void refresh()}><RefreshCw size={11} /></button>
                </div>
              )}
            </div>
          </OverlayAt>
        </div>
      )}
    </>
  )
}
