// @vitest-environment happy-dom
/**
 * 设置 › 远程会话 › 急停与远程锁定(P1 · K2 §3.10):经 K4 扩展槽挂载;门控(没有主进程 API 不渲染);锁定 / 解锁 / 急停 / 热键录制;
 * 热键失败红字可见(D13);运行中的远程任务列表。主进程行为在 electron/remoteSafety.test.ts,这里只测界面契约。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteSafetyPanel, remoteSafetyApi } from './RemoteSafetyPanel'
import { remoteSettingsSections } from './remoteSettingsSections'
import { LocaleProvider, setLocaleGlobal } from '../i18n'
import type { RemoteSafetyApi, RemoteSafetyState } from '../../../shared/remoteSafety'

const makeState = (over: Partial<RemoteSafetyState> = {}): RemoteSafetyState => ({
  locked: false, lockedAt: null, lockSource: null, lockPersistFailed: false,
  hotkey: { accelerator: 'Control+Alt+Shift+.', registered: true, error: null },
  engine: 'connected', pendingEstop: false, remoteRuns: [], lastEstop: null, ...over,
})

let host: HTMLDivElement
let root: Root
let st: RemoteSafetyState
let push: ((s: RemoteSafetyState) => void) | null
const api = {
  get: vi.fn<RemoteSafetyApi['get']>(),
  estop: vi.fn<RemoteSafetyApi['estop']>(),
  unlock: vi.fn<RemoteSafetyApi['unlock']>(),
  setHotkey: vi.fn<RemoteSafetyApi['setHotkey']>(),
  onChanged: vi.fn<RemoteSafetyApi['onChanged']>(),
}

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  setLocaleGlobal('zh')
  st = makeState()
  push = null
  api.get.mockReset().mockImplementation(async () => st)
  api.estop.mockReset().mockImplementation(async () => (st = { ...st, locked: true, lockedAt: Date.now(), lockSource: 'settings' }))
  api.unlock.mockReset().mockImplementation(async () => ({ ok: false, reason: 'cancelled' }))
  api.setHotkey.mockReset().mockImplementation(async (acc) => (st = { ...st, hotkey: { accelerator: acc, registered: acc !== '', error: acc === '' ? 'disabled' : null } }).hotkey)
  api.onChanged.mockReset().mockImplementation((cb) => { push = cb; return () => { push = null } })
  window.tangu = { platform: 'darwin', remoteSafety: api } as unknown as Window['tangu']
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  delete window.tangu
})

async function mount(): Promise<void> {
  await act(async () => root.render(React.createElement(LocaleProvider, { children: React.createElement(RemoteSafetyPanel) })))
}
const q = <T extends Element = HTMLElement>(sel: string): T | null => host.querySelector<T>(sel)
const click = async (el: Element | null): Promise<void> => { await act(async () => { (el as HTMLElement).click() }) }

describe('RemoteSafetyPanel', () => {
  it('经 K4 扩展槽登记(id remote-safety, order 100)', () => {
    expect(remoteSettingsSections().find((s) => s.id === 'remote-safety')?.order).toBe(100)
  })

  it('门控:没有主进程 API / 设备页 / web / 手机 → 不渲染', async () => {
    window.tangu = { platform: 'darwin' } as unknown as Window['tangu']
    expect(remoteSafetyApi()).toBeUndefined()
    await mount()
    expect(host.innerHTML).toBe('')
    for (const flag of ['unitPage', 'cloudWeb', 'mobile']) {
      window.tangu = { platform: 'darwin', remoteSafety: api, [flag]: true } as unknown as Window['tangu']
      expect(remoteSafetyApi(), flag).toBeUndefined()
    }
  })

  it('未锁:显示「未锁定」+「立即急停」;点急停 → 锁定显示来源与说明、出「解锁…」', async () => {
    await mount()
    expect(q('[data-rsf-lock-state]')!.textContent).toBe('未锁定')
    expect(q('[data-rsf="unlock"]')).toBeNull()
    expect(q('[data-rsf="hotkey"]')!.textContent).toBe('⌃⌥⇧.')
    await click(q('[data-rsf="estop"]'))
    expect(api.estop).toHaveBeenCalledTimes(1)
    expect(q('[data-rsf-lock-state]')!.textContent).toContain('已锁定')
    expect(q('[data-rsf-lock-state]')!.textContent).toContain('设置')
    expect(q('[data-rsf="unlock"]')).not.toBeNull()
  })

  it('解锁被取消 → 仍锁定并说明;通过 → 由 changed 事件刷回未锁', async () => {
    st = makeState({ locked: true, lockedAt: Date.now(), lockSource: 'hotkey' })
    await mount()
    await click(q('[data-rsf="unlock"]'))
    expect(q('[data-rsf-note]')!.textContent).toBe('已取消，远程访问仍锁定。')
    api.unlock.mockImplementation(async () => { st = makeState(); return { ok: true } })
    await click(q('[data-rsf="unlock"]'))
    expect(q('[data-rsf-lock-state]')!.textContent).toBe('未锁定')
  })

  it('写盘失败 / 待补发如实显示(失败可见)', async () => {
    st = makeState({ locked: true, lockedAt: Date.now(), lockSource: 'tray', lockPersistFailed: true, pendingEstop: true })
    await mount()
    expect(q('[data-rsf-persist-failed]')).not.toBeNull()
    expect(q('[data-rsf-pending-estop]')).not.toBeNull()
  })

  it('热键注册失败 → 红字「被占用」;录制新键(⌃⌥⇧K)→ setHotkey;Esc 取消;关闭 / 恢复默认', async () => {
    st = makeState({ hotkey: { accelerator: 'Control+Alt+Shift+.', registered: false, error: 'in_use' } })
    await mount()
    expect(q('[data-rsf-hotkey-state="in_use"]')!.textContent).toContain('被占用')
    expect(q('[data-rsf-hotkey-state="in_use"]')!.className).toContain('rsf-danger')
    expect(q('[data-rsf="hotkey"]')!.className).toContain('rsf-kbd--off')
    await click(q('[data-rsf="hotkey-change"]'))
    const rec = q<HTMLButtonElement>('[data-rsf="hotkey-recorder"]')!
    await act(async () => { rec.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', bubbles: true })) }) // 没修饰键:继续录
    expect(api.setHotkey).not.toHaveBeenCalled()
    await act(async () => { rec.dispatchEvent(new KeyboardEvent('keydown', { key: 'K', code: 'KeyK', ctrlKey: true, altKey: true, shiftKey: true, bubbles: true })) })
    expect(api.setHotkey).toHaveBeenCalledWith('Control+Alt+Shift+K')
    expect(q('[data-rsf="hotkey"]')!.textContent).toBe('⌃⌥⇧K')
    await click(q('[data-rsf="hotkey-change"]'))
    await act(async () => { q('[data-rsf="hotkey-recorder"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })) })
    expect(q('[data-rsf="hotkey-recorder"]')).toBeNull()
    await click(q('[data-rsf="hotkey-off"]'))
    expect(api.setHotkey).toHaveBeenLastCalledWith('')
    expect(q('[data-rsf-hotkey-state="disabled"]')).not.toBeNull()
    await click(q('[data-rsf="hotkey-reset"]'))
    expect(api.setHotkey).toHaveBeenLastCalledWith('Control+Alt+Shift+.')
  })

  it('运行中的远程任务:空态一句;有任务 → 名字 / 等你处理 / 停止;主进程推送即时刷新', async () => {
    await mount()
    expect(q('[data-rsf-empty]')).not.toBeNull()
    await act(async () => push!(makeState({ remoteRuns: [
      { runId: 'r1', sessionId: 's1', category: 'remote', label: 'Pixel 9', pendingApprovals: 1, pendingInquiries: 0, startedAt: Date.now() - 60_000 },
      { runId: 'c1', sessionId: 's2', category: 'channel', label: '微信', pendingApprovals: 0, pendingInquiries: 0, startedAt: Date.now() },
    ] })))
    expect(q('[data-rsf-empty]')).toBeNull()
    expect(host.textContent).toContain('Pixel 9')
    expect(q('[data-rsf-waiting]')).not.toBeNull()
    expect(q('[data-rsf-stop="r1"]')).not.toBeNull()
    expect(q('[data-rsf-keepawake]')!.textContent).toContain('合盖仍会休眠')
  })
})
