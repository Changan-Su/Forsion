/**
 * 侧栏的「我的电脑」分组(P1-K7a;方案 §4.7 b1 / b5、D6,规格 K7 §3.5)。
 *
 * 每台电脑一段:组头 = 图标 + 名字(纯文本,截 60)+ 状态说明(离线 / 引擎没起 / 未开启远程会话 … 各是各的,
 * services/deviceStatus 的口径)+ 折叠;组内 = 那台现拉的会话(只在内存)∪ 已在本页打开过、这次列表还没带上的那几条。
 * 离线的电脑只剩组头(D6:它的会话不可见)。点一行 = adoptRemoteSession(先绑定、再注入、再打开,R-17)。
 * 行菜单只有「重命名 / 归档」(远端硬删是 deny-remote);触屏菜单常显(DESIGN §6「工作区共享列表」)。
 * 名字、标题、状态都是设备自报:一律进文本节点,不作任何判断依据。
 * 闸:runLocationsAvailable()(手机 App;桌面主窗口 / 网页版 / 设备页恒不渲染)。名册里没有电脑 → 什么都不画。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Archive, ChevronRight, Laptop, MessageSquare, Monitor, MoreHorizontal, Pencil } from 'lucide-react'
import { OverlayAt } from '@lcl/engine'
import { SidebarRow } from '../../components/SidebarRow'
import { AnimatedCollapse } from '../../components/AnimatedUI'
import { registerMessages, useI18n } from '../../i18n'
import { displaySessionTitle } from '../../sessionTitle'
import { folderPadLeft } from '@amadeus/lib/treeIndent'
import type { SessionRecord, UnitInfo } from '../../types'
import { useApp } from '../../stores/appStore'
import { adoptRemoteSession, archiveRemote, renameRemote, statusOfUnit, useDeviceSessions } from '../../stores/deviceSessionsStore'
import { useDeviceMarks } from '../../services/deviceMarks'
import type { DeviceStatus } from '../../services/deviceStatus'
import { runLocationsAvailable } from '../../features/runtime'
import { sessionActivityAt } from './SidebarPane'
import './deviceSessions.css'

registerMessages({
  'devstatus.checking': { zh: '正在连接…', en: 'Connecting…' },
  'devstatus.ready': { zh: '在线', en: 'Online' },
  'devstatus.starting': { zh: '引擎正在启动', en: 'Engine is starting' },
  'devstatus.engineStopped': { zh: '引擎没有运行', en: "Engine isn't running" },
  'devstatus.noEngine': { zh: '没有 Agent 引擎', en: 'No agent engine' },
  'devstatus.offline': { zh: '离线', en: 'Offline' },
  'devstatus.unreachable': { zh: '暂时连不上', en: "Can't reach it" },
  'devstatus.remoteOff': { zh: '未开启远程会话', en: 'Remote sessions off' },
  'devstatus.awaitingConfirm': { zh: '等待那台电脑允许', en: 'Waiting for approval there' },
  'devstatus.denied': { zh: '拒绝了这台手机', en: 'Declined this phone' },
  'devstatus.callerBlocked': { zh: '不允许这台手机运行', en: "Doesn't allow this phone" },
  // 悬停 / 读屏用的完整说明
  'devstatus.long.checking': { zh: '正在连接这台电脑…', en: 'Connecting to this computer…' },
  'devstatus.long.ready': { zh: '在线，可以在上面运行会话', en: 'Online. Sessions can run here' },
  'devstatus.long.starting': { zh: '这台电脑在线，Agent 引擎正在启动', en: 'This computer is online and its agent engine is starting' },
  'devstatus.long.engineStopped': { zh: 'Forsion 已打开，但 Agent 引擎没有运行', en: "Forsion is open, but its agent engine isn't running" },
  'devstatus.long.noEngine': { zh: '这台设备上的 Forsion 没有 Agent 引擎', en: 'Forsion on this device has no agent engine' },
  'devstatus.long.offline': { zh: '离线，重新上线后这里会显示它的会话', en: "Offline. Its sessions show up here when it's back" },
  'devstatus.long.unreachable': { zh: '暂时连不上，稍后重试', en: "Can't reach it right now. Try again shortly" },
  'devstatus.long.remoteOff': { zh: '这台电脑没有开启「允许远程会话」', en: 'Remote sessions are turned off on this computer' },
  'devstatus.long.awaitingConfirm': { zh: '请在那台电脑上允许这台手机', en: 'Allow this phone on that computer to continue' },
  'devstatus.long.denied': { zh: '那台电脑拒绝了这台手机', en: 'That computer declined this phone' },
  'devstatus.long.callerBlocked': { zh: '那台电脑不允许这台手机运行会话，请在它的「设置 › 远程会话」中调整', en: "That computer doesn't let this phone run sessions. Change it in Settings › Remote sessions there" },
  'sidebar.device.label': { zh: '{name} 上的会话', en: 'Sessions on {name}' },
  'sidebar.device.empty': { zh: '还没有会话', en: 'No sessions yet' },
  'sidebar.device.menu': { zh: '更多操作', en: 'More actions' },
})

/** 设备名 / 标题的纯文本截断(不可信串:进文本节点,且不让超长名把一行撑爆)。 */
export function clampText(s: unknown, n: number): string {
  const x = typeof s === 'string' ? s.trim() : ''
  return x.length > n ? `${x.slice(0, n - 1)}…` : x
}

const COLLAPSE_KEY = 'forsion_device_sections_collapsed'
function loadCollapsed(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]')
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 200) : [])
  } catch { return new Set() }
}
function saveCollapsed(s: Set<string>): void {
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...s])) } catch { /* 隐私模式 */ }
}

/** 组头图标:名册自带 emoji 优先,否则按平台。 */
function DeviceIcon({ u }: { u: Pick<UnitInfo, 'icon' | 'platform'> }): React.ReactElement {
  if (u.icon) return <span className="t2d-emoji" aria-hidden>{clampText(u.icon, 4)}</span>
  return u.platform === 'win32' || u.platform === 'linux' ? <Monitor className="t2s-lead-icon" /> : <Laptop className="t2s-lead-icon" />
}

/** 刷新节奏:挂载时、回到前台、连上时、在前台每 30s(后台不计时)。 */
export function useDeviceSessionsLive(): void {
  const connState = useApp((s) => s.connState)
  useEffect(() => {
    if (!runLocationsAvailable()) return
    const refresh = (): void => { void useDeviceSessions.getState().refresh() }
    refresh()
    let timer: ReturnType<typeof setInterval> | null = null
    const arm = (): void => {
      if (timer) { clearInterval(timer); timer = null }
      if (typeof document === 'undefined' || document.visibilityState === 'visible') timer = setInterval(refresh, 30_000)
    }
    const onVis = (): void => { if (document.visibilityState === 'visible') refresh(); arm() }
    arm()
    document.addEventListener('visibilitychange', onVis)
    return () => { document.removeEventListener('visibilitychange', onVis); if (timer) clearInterval(timer) }
  }, [])
  useEffect(() => {
    if (connState === 'ok' && runLocationsAvailable()) void useDeviceSessions.getState().refresh()
  }, [connState])
}

interface Props {
  /** Chat / Work 模式过滤(同 SidebarPane 的 sessionsInMode)。 */
  filter?: (rows: SessionRecord[]) => SessionRecord[]
  activeId: string | null
  runningIds: Set<string>
  unreadIds: Set<string>
  /** 行角标插槽(审批送达包:等你处理的点)。 */
  rowBadge?: (s: SessionRecord) => React.ReactNode
}

interface MenuState { unitId: string; id: string; x: number; y: number }

export function DeviceSessionSections(p: Props): React.ReactElement | null {
  const { t } = useI18n()
  useDeviceSessionsLive()
  const units = useDeviceSessions((s) => s.units)
  const byUnit = useDeviceSessions((s) => s.byUnit)
  useDeviceMarks((s) => s.probes)
  useDeviceMarks((s) => s.sticky)
  const injected = useApp((s) => s.sessions)
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [renaming, setRenaming] = useState<{ unitId: string; id: string } | null>(null)
  const [draft, setDraft] = useState('')
  const renameRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (renaming) renameRef.current?.select() }, [renaming])
  // 菜单:点别处 / 右键别处 / Escape 关(同 SidebarPane)
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const esc = (e: KeyboardEvent): void => { if (e.key === 'Escape') setMenu(null) }
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('click', close); window.removeEventListener('contextmenu', close); window.removeEventListener('keydown', esc) }
  }, [menu])

  // 每台的行 = 现拉的列表 ∪ 本页打开 / 刚建的、列表还没带上的(不然刚在那台上建的会话要等下一轮刷新才出现)
  const rowsByUnit = useMemo(() => {
    const out: Record<string, SessionRecord[]> = {}
    for (const u of units || []) {
      const id = u.id.toLowerCase()
      if (!u.online) { out[id] = []; continue } // D6:离线电脑的会话不可见
      const listed = byUnit[id]?.sessions ?? []
      const seen = new Set(listed.map((x) => x.id))
      const extra = injected.filter((x) => x.location?.kind === 'unit' && x.location.unitId === id && !seen.has(x.id) && !x.archived)
      const all = [...extra, ...listed].sort((a, b) => sessionActivityAt(b.updated_at) - sessionActivityAt(a.updated_at))
      out[id] = p.filter ? p.filter(all) : all
    }
    return out
  }, [units, byUnit, injected, p.filter])

  if (!runLocationsAvailable() || !units?.length) return null

  const toggle = (id: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      saveCollapsed(next)
      return next
    })
  }
  const commitRename = (): void => {
    if (renaming && draft.trim()) void renameRemote(renaming.unitId, renaming.id, draft.trim())
    setRenaming(null)
  }

  return (
    <div className="t2d-sections" data-device-sections>
      {units.map((u) => {
        const id = u.id.toLowerCase()
        const status: DeviceStatus = statusOfUnit(u).status
        const rows = rowsByUnit[id] ?? []
        const isCollapsed = collapsed.has(id)
        const name = clampText(u.name, 60) || t('engine.target.defaultName')
        return (
          <div className="t2d-section" key={id} data-device-section={id} data-device-status={status}>
            <div className="t2s-group t2d-head" style={{ paddingLeft: folderPadLeft(0) }} title={t(`devstatus.long.${status}`)}>
              <button type="button" className="t2s-group-toggle t2s-folder-row t2d-toggle" aria-expanded={!isCollapsed} aria-label={t('sidebar.device.label', { name })} onClick={() => toggle(id)}>
                <span className="t2s-lead">
                  <DeviceIcon u={u} />
                  <span className={`t2s-chev t2s-lead-chev${isCollapsed ? '' : ' open'}`}><ChevronRight size={12} /></span>
                </span>
                <span className="t2s-group-label t2d-name">{name}</span>
                <span className="t2d-status" data-tone={status === 'ready' ? 'ok' : status === 'checking' ? 'wait' : 'warn'} role="status">{t(`devstatus.${status}`)}</span>
              </button>
            </div>
            <AnimatedCollapse open={!isCollapsed}>
              <div className="t2s-group-sessions">
                {rows.map((s) => (
                  <SidebarRow
                    key={s.id}
                    as={renaming?.id === s.id ? 'div' : 'button'}
                    className={s.id === p.activeId ? 'active' : undefined}
                    depth={1}
                    title={s.summary || s.title || undefined}
                    lead={<>
                      <MessageSquare className="t2s-lead-icon t2s-dim" />
                      {p.rowBadge?.(s) ?? (p.runningIds.has(s.id)
                        ? <span className="t2s-dot running" />
                        : p.unreadIds.has(s.id) ? <span className="t2s-dot unread" /> : null)}
                    </>}
                    trailing={renaming?.id === s.id ? undefined : (
                      <span className="t2s-srow-menu" role="button" aria-label={t('sidebar.device.menu')} onClick={(e) => { e.stopPropagation(); setMenu({ unitId: id, id: s.id, x: e.clientX, y: e.clientY }) }}>
                        <MoreHorizontal size={14} />
                      </span>
                    )}
                    onClick={() => { if (renaming?.id !== s.id) adoptRemoteSession(s, { kind: 'unit', unitId: id }) }}
                    onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ unitId: id, id: s.id, x: e.clientX, y: e.clientY }) }}
                  >
                    {renaming?.id === s.id ? (
                      <input
                        ref={renameRef}
                        className="t2s-rename"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={commitRename}
                        onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(null) }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <span className="t2s-srow-title" data-remote-session={s.id}>{displaySessionTitle(clampText(s.title, 200), t)}</span>
                    )}
                  </SidebarRow>
                ))}
                {status === 'ready' && !rows.length && <div className="t2d-empty">{t('sidebar.device.empty')}</div>}
              </div>
            </AnimatedCollapse>
          </div>
        )
      })}
      {menu && (
        <OverlayAt className="ctx-menu" x={menu.x} y={menu.y} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => {
            const row = rowsByUnit[menu.unitId]?.find((x) => x.id === menu.id)
            setDraft(row?.title || '')
            setRenaming({ unitId: menu.unitId, id: menu.id })
            setMenu(null)
          }}>
            <Pencil size={13} /> {t('sidebar.rename')}
          </button>
          <button onClick={() => { const m = menu; setMenu(null); void archiveRemote(m.unitId, m.id) }}>
            <Archive size={13} /> {t('sidebar.archive')}
          </button>
        </OverlayAt>
      )}
    </div>
  )
}
