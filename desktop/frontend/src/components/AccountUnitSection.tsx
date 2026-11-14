/**
 * 账号面板上半的「Unit」段:
 *   这台电脑 → 我的设备(在线在前、离线折成「离线 N 台」、正在看的那台掉线了也不折)→ 管理 Unit…
 * 一台设备一行;点下去走哪条路只由 pickUnitRoute 决定(unitPanelModel.ts:记住的通路 → 中转 → 只剩直连通时走直连),切换复用 runUnitRoute。
 * 只在真桌面的主窗出现(unitPanelAvailable):网页、手机壳、Android 原生半屏、独立窗都不画。
 */
import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AppWindow, Check, ChevronDown, ChevronRight, Globe, Laptop, Settings2 } from 'lucide-react'
import { OverlayAt, UI_MODE, nativeSheetPresenter } from '@lcl/engine'
import { registerMessages, useI18n, translate } from '../i18n'
import { windowKind } from '../windowKind'
import { useApp } from '../stores/appStore'
import { askString } from '../amadeus/components/askString'
import { deviceIcon, leaveUnitRemote, runUnitRoute, sayUnit, useUnitRemote } from './UnitSwitcher'
import { readRememberedVia, unitPanelModel, type UnitPanelRow } from './unitPanelModel'
import { useUnitRoster } from './unitRoster'
import type { UnitInfo } from '../types'
import { addUnitToDesktop } from '../unitShortcut'

registerMessages({
  'unit.panel.thisComputer': { zh: '这台电脑', en: 'This computer' },
  'unit.panel.myDevices': { zh: '我的设备', en: 'My devices' },
  'unit.panel.manage': { zh: '管理 Unit…', en: 'Manage Units…' },
  'unit.panel.online': { zh: '在线 · {via}', en: 'Online · {via}' },
  'unit.panel.offlineCount': { zh: '离线 {n} 台', en: '{n} offline' },
  'unit.panel.offlineNote': { zh: '那台没开 Forsion', en: "That device isn't running Forsion" },
  'unit.panel.switchTo': { zh: '切换到这台', en: 'Switch to this device' },
  'unit.panel.rename': { zh: '改名字', en: 'Rename' },
  'unit.panel.changeIcon': { zh: '改图标', en: 'Change icon' },
  'unit.panel.renameAsk': { zh: '设备名字', en: 'Device name' },
  'unit.panel.editFailed': { zh: '没改成：{error}', en: "Couldn't save: {error}" },
  'unit.panel.openWindow': { zh: '在新窗口打开', en: 'Open in new window' },
  'unit.panel.addToDesktop': { zh: '添加到桌面', en: 'Add to desktop' },
})

/** 账号面板里出不出 Unit 段。判别式照 bootstrapEngine 注册 rb-unit 那套(有设备桥、不是单列壳),
 *  再加:只在主窗(windowKind)、不在设备页 / 网页主入口(unitPage / unitPublicEntry)、不在 Android 原生半屏宿主。 */
export function unitPanelAvailable(): boolean {
  if (windowKind() !== 'main') return false
  const t = window.tangu
  if (!t || t.mobile || t.unitPage || t.unitPublicEntry) return false
  if (!t.unitsList && !t.unitHostStatus) return false
  return UI_MODE !== 'mobile' && !nativeSheetPresenter()
}

const VIA_KEY = { lan: 'unit.viaLan', p2p: 'unit.viaP2p', tunnel: 'unit.viaTunnel' } as const

export function AccountUnitSection({ onClose, onToast }: {
  /** 关面板(切换成功、去设置、改名前)。 */
  onClose: () => void
  onToast?: (text: string, error?: boolean) => void
}): React.ReactElement {
  const { t } = useI18n()
  const units = useUnitRoster((s) => s.units)
  const hostUnitId = useUnitRoster((s) => s.hostUnitId)
  const lanOk = useUnitRoster((s) => s.lanOk)
  const target = useUnitRemote((s) => s.target)
  const active = useUnitRemote((s) => s.active)
  const [offlineOpen, setOfflineOpen] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [ctx, setCtx] = useState<{ row: Extract<UnitPanelRow, { kind: 'unit' }>; x: number; y: number } | null>(null)

  // 先画缓存,同时后台刷新(内容变高后 OverlayAt 的 ResizeObserver 会重新夹位置)
  useEffect(() => { void useUnitRoster.getState().refresh() }, [])

  // 右键菜单开着:点它外面只收它(捕获阶段,赶在账号面板的「点别处关面板」之前);Esc 也只收它。
  useEffect(() => {
    if (!ctx) return
    const onDown = (e: PointerEvent): void => {
      if (!(e.target instanceof Element && e.target.closest('.ap-unit-ctx'))) setCtx(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setCtx(null)
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [ctx])

  const model = unitPanelModel({
    units, hostUnitId, lanOk,
    p2p: !!window.tangu?.unitsP2pOpen,
    remote: { active, key: target?.key ?? null, name: target?.name },
    remembered: readRememberedVia,
  })

  const backHome = (): void => {
    leaveUnitRemote() // 只收远程面(并作废还没落地的切换),不动智库的「本地 / 云端」
    onClose()
  }
  const openRow = (row: UnitPanelRow): void => {
    if (row.current) { onClose(); return }
    if (row.kind !== 'unit') return
    if (!row.via) { setNote(t('unit.panel.offlineNote')); return }
    const u = row.unit
    if (row.downgraded) sayUnit(translate('unit.frame.lanDown', { name: u.name })) // 记住的是直连,这次探不通
    runUnitRoute({ kind: 'unit', id: u.id, name: u.name, icon: u.icon, platform: u.platform, via: row.via, lanUrl: u.lanUrl })
    onClose()
  }
  /** 在新窗口打开(一台设备一扇,主进程去重);离线的也开,窗里自己画「不在线」。 */
  const canWindow = !!window.tangu?.unitsOpenWindow
  const canDesktop = !!window.tangu?.unitsAddToDesktop
  const openWindow = (u: UnitInfo): void => {
    onClose()
    void window.tangu?.unitsOpenWindow?.(u.id).catch(() => {})
  }
  /** 改名字 / 改图标各弹各的输入框,只带改了的那一个字段。 */
  const editUnit = async (u: UnitInfo, field: 'name' | 'icon'): Promise<void> => {
    onClose()
    const patch: { name?: string; icon?: string } = {}
    if (field === 'name') {
      const name = (await askString(t('unit.panel.renameAsk'), u.name))?.trim()
      if (!name || name === u.name) return
      patch.name = name
    } else {
      const icon = (await askString(t('unit.setEmoji'), u.icon || ''))?.trim().slice(0, 8)
      if (icon == null || icon === (u.icon || '')) return
      patch.icon = icon
    }
    const r = await window.tangu?.unitsUpdate?.(u.id, patch)
      .catch((e: unknown) => ({ status: 0, json: { detail: String((e as Error)?.message || e) } }))
    if (!r || r.status !== 200) {
      onToast?.(translate('unit.panel.editFailed', { error: String(r?.json?.detail || r?.json?.error || r?.status || '') }), true)
    } else {
      // 正看着的就是它:胶囊上的名字 / 图标跟着换
      const cur = useUnitRemote.getState().target
      if (cur && cur.key.startsWith(`${u.id}:`)) useUnitRemote.setState({ target: { ...cur, name: patch.name ?? cur.name, icon: patch.icon ?? cur.icon } })
    }
    void useUnitRoster.getState().refresh()
  }

  const rowEl = (row: UnitPanelRow): React.ReactElement => {
    if (row.kind === 'addr') {
      return (
        <button key={row.key} className="ap-item ap-unit ap-unit--current" aria-current="true" onClick={() => openRow(row)}>
          <span className="ap-unit-ic"><Globe size={14} /></span>
          <span className="ap-unit-name">{row.name}</span>
          <span className="grow" />
          <Check size={14} className="ap-unit-check" />
        </button>
      )
    }
    const u = row.unit
    const off = !row.via && !row.current
    const btn = (
      <button
        className={`ap-item ap-unit${off ? ' ap-unit--off' : ''}${row.current ? ' ap-unit--current' : ''}`}
        data-unit-id={u.id}
        aria-current={row.current || undefined}
        onClick={() => openRow(row)}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCtx({ row, x: e.clientX, y: e.clientY }) }}
      >
        <span className="ap-unit-ic">{deviceIcon(u, 14)}</span>
        <span className="ap-unit-name">{u.name}</span>
        <span className="grow" />
        {row.current
          ? <Check size={14} className="ap-unit-check" />
          : <span className="ap-dim ap-unit-state">{row.via ? t('unit.panel.online', { via: t(VIA_KEY[row.via]) }) : t('unit.offline')}</span>}
      </button>
    )
    // 在线行:悬停 / 键盘聚焦时行尾冒出「在新窗口打开」(不常驻;按钮不能套在行按钮里,两者是兄弟)
    if (!row.via || !canWindow) return <React.Fragment key={row.key}>{btn}</React.Fragment>
    return (
      <div key={row.key} className="ap-unit-wrap">
        {btn}
        <button
          type="button"
          className="ap-unit-newwin"
          title={t('unit.panel.openWindow')}
          aria-label={`${t('unit.panel.openWindow')} · ${u.name}`}
          onClick={(e) => { e.stopPropagation(); openWindow(u) }}
        >
          <AppWindow size={13} />
        </button>
      </div>
    )
  }

  const hasDevices = model.rows.length > 0 || model.offline.length > 0
  return (
    <div className="ap-units" data-testid="account-units">
      <div className="ap-units-list">
        <div className="ap-sec">{t('unit.panel.thisComputer')}</div>
        <button className={`ap-item ap-unit${model.localCurrent ? ' ap-unit--current' : ''}`} data-unit-local="" aria-current={model.localCurrent || undefined} onClick={backHome}>
          <span className="ap-unit-ic"><Laptop size={14} /></span>
          <span className="ap-unit-name">{t('unit.panel.thisComputer')}</span>
          <span className="grow" />
          {model.localCurrent && <Check size={14} className="ap-unit-check" />}
        </button>
        {hasDevices && <div className="ap-sec">{t('unit.panel.myDevices')}</div>}
        {model.rows.map(rowEl)}
        {model.offline.length > 0 && (
          <button className="ap-item ap-unit ap-unit-fold" aria-expanded={offlineOpen} onClick={() => setOfflineOpen((v) => !v)}>
            <span className="ap-unit-ic" aria-hidden="true" />
            <span className="ap-unit-name">{t('unit.panel.offlineCount', { n: String(model.offline.length) })}</span>
            <span className="grow" />
            {offlineOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
        )}
        {offlineOpen && model.offline.map(rowEl)}
      </div>
      {note !== null && <div className="ap-unit-note" role="status">{note}</div>}
      <button className="ap-item ap-unit-manage" onClick={() => { onClose(); useApp.getState().openSettings('units') }}>
        <span className="ap-unit-ic"><Settings2 size={14} /></span>
        <span>{t('unit.panel.manage')}</span>
      </button>
      {ctx && createPortal(
        <OverlayAt className="ctx-menu ap-unit-ctx" role="menu" x={ctx.x} y={ctx.y} onPointerDown={(e) => e.stopPropagation()}>
          <button role="menuitem" onClick={() => { const row = ctx.row; setCtx(null); openRow(row) }}>{t('unit.panel.switchTo')}</button>
          {canWindow && <button role="menuitem" data-unit-act="window" onClick={() => { const u = ctx.row.unit; setCtx(null); openWindow(u) }}>{t('unit.panel.openWindow')}</button>}
          {canDesktop && <button role="menuitem" data-unit-act="desktop" onClick={() => { const u = ctx.row.unit; setCtx(null); onClose(); void addUnitToDesktop(u) }}>{t('unit.panel.addToDesktop')}</button>}
          <button role="menuitem" onClick={() => { const u = ctx.row.unit; setCtx(null); void editUnit(u, 'name') }}>{t('unit.panel.rename')}</button>
          <button role="menuitem" onClick={() => { const u = ctx.row.unit; setCtx(null); void editUnit(u, 'icon') }}>{t('unit.panel.changeIcon')}</button>
        </OverlayAt>,
        document.body,
      )}
    </div>
  )
}
