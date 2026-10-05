// @vitest-environment happy-dom
// P1-K7a 侧栏「我的电脑」分组(规格 K7 §3.5;S3:设备自报的名字 / 标题只进文本节点;S4:行菜单没有删除)。
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { SessionRecord, UnitInfo } from '../../types'

const fakeApp = create(() => ({ sessions: [] as SessionRecord[], archivedSessions: [] as SessionRecord[], connState: 'ok', activeId: null as string | null, configBySession: {}, cfg: { token: 't' }, setActiveId: () => {}, toast: () => {}, tr: (k: string) => k }))
vi.mock('../../stores/appStore', () => ({ useApp: fakeApp }))
vi.mock('../../sessionNav', () => ({ openSession: vi.fn() }))
vi.mock('../../features/runtime', () => ({ runLocationsAvailable: () => true, rosterAvailable: () => true }))
vi.mock('@lcl/engine', () => ({
  OverlayAt: ({ children, className }: { children: React.ReactNode; className?: string }) => React.createElement('div', { className, 'data-overlay': '' }, children),
  setActiveSpace: () => {},
  useSpaceStore: { getState: () => ({ activeSpaceId: 'tangu' }) },
  // 无原生半屏宿主(桌面 / 网页):菜单照旧画 Web 版。
  nativeSheetPresenter: () => undefined,
  presentNativePrompt: async () => ({ handled: false }),
  useNativeSheetMenu: () => true,
}))
vi.mock('../../components/AnimatedUI', () => ({ AnimatedCollapse: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? React.createElement(React.Fragment, null, children) : null) }))

const { DeviceSessionSections } = await import('./DeviceSessionSections')
const { useDeviceSessions } = await import('../../stores/deviceSessionsStore')
const { noteDeviceProbe, resetDeviceMarks } = await import('../../services/deviceMarks')

const A = '11111111-2222-4333-8444-555555555555'
const B = '22222222-2222-4333-8444-555555555555'
const C = '33333333-2222-4333-8444-555555555555'
const EVIL = '<img src=x onerror="window.__pwned=1">' + 'x'.repeat(80)
const unit = (id: string, o: Partial<UnitInfo> = {}): UnitInfo => ({ id, name: `Mac ${id.slice(0, 2)}`, platform: 'darwin', icon: null, online: true, kind: 'desktop', caps: { engine: 'ready' }, capsLive: true, ...o })
const sess = (id: string, title = id): SessionRecord => ({ id, title, model_id: 'm', created_at: '', updated_at: '2026-09-28 10:00:00' } as SessionRecord)

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  resetDeviceMarks()
  useDeviceSessions.setState({
    refresh: async () => {},
    units: [unit(A, { name: EVIL }), unit(B, { online: false }), unit(C, { caps: { engine: 'stopped' } })],
    byUnit: {
      [A]: { sessions: [sess('a1', '<b>bold</b> title')], fetchedAt: 1, loading: false },
      [B]: { sessions: [sess('b1')], fetchedAt: 1, loading: false }, // 离线前列过的:离线后不可见(D6)
    },
  })
  noteDeviceProbe(A, { ok: true })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })

const render = async (): Promise<void> => {
  await act(async () => { root.render(React.createElement(DeviceSessionSections, { activeId: null, runningIds: new Set<string>(), unreadIds: new Set<string>() })) })
}

describe('DeviceSessionSections', () => {
  it('one section per computer, statuses distinct (ready / offline / engine stopped)', async () => {
    await render()
    const secs = [...host.querySelectorAll('[data-device-section]')].map((e) => [e.getAttribute('data-device-section'), e.getAttribute('data-device-status'), e.querySelector('.t2d-status')?.textContent])
    expect(secs).toEqual([
      [A, 'ready', '在线'],
      [B, 'offline', '离线'],
      [C, 'engineStopped', '引擎没有运行'],
    ])
  })

  it('offline computer shows only its header (D6); ready computer lists its sessions', async () => {
    await render()
    expect(host.querySelectorAll(`[data-device-section="${A}"] [data-remote-session]`).length).toBe(1)
    expect(host.querySelectorAll(`[data-device-section="${B}"] [data-remote-session]`).length).toBe(0)
  })

  it('S3: self-reported names and titles are text, clamped; no markup is created', async () => {
    await render()
    const name = host.querySelector(`[data-device-section="${A}"] .t2d-name`)!
    expect(name.textContent!.startsWith('<img src=x')).toBe(true)
    expect(name.textContent!.length).toBeLessThanOrEqual(60)
    expect(host.querySelector('img')).toBeNull()
    expect(host.querySelector(`[data-remote-session="a1"]`)!.textContent).toBe('<b>bold</b> title')
    expect(host.querySelector('b')).toBeNull()
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()
  })

  it('K3 attention dot shows on a remote row through the rowBadge slot (priority over running / unread)', async () => {
    const { attentionBadge } = await import('./DeviceSessionSections')
    const ids = new Map([['a1', { n: 2, localOnly: false }]])
    await act(async () => { root.render(React.createElement(DeviceSessionSections, { activeId: null, runningIds: new Set<string>(['a1']), unreadIds: new Set<string>(), rowBadge: (x: SessionRecord) => attentionBadge(ids, x.id) })) })
    const row = host.querySelector(`[data-device-section="${A}"] .t2s-srow`)!
    expect(row.querySelector('.t2s-dot.attention')).not.toBeNull()
    expect(row.querySelector('.t2s-dot.running')).toBeNull()
  })

  // 设置图标走与改名同一条 PATCH /agent/sessions/:id(远端放行),只动 emoji 字段。
  it('S4: row menu has Set icon, Rename and Archive only (no Delete)', async () => {
    await render()
    const trigger = host.querySelector(`[data-device-section="${A}"] .t2s-srow-menu`) as HTMLElement
    await act(async () => { trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const items = [...host.querySelectorAll('[data-overlay] button')].map((b) => b.textContent?.trim())
    expect(items).toHaveLength(3)
    expect(items[0]).toMatch(/设置图标|Set icon/)
    expect(items.join('|')).not.toMatch(/删除|Delete/)
  })
})
