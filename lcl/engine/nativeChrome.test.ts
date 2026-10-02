import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  claimNativeChrome, dispatchNativeChromeAction, installNativeChromeHost, nativeChromeInstalled, nativeChromeState,
  setNativeChromeShell, type NativeChromeState,
} from './nativeChrome'

const labels = { left: 'Left panel', right: 'Right panel', tabs: 'Tabs', more: 'More' }
const shellState = { title: 'Home', left: true, right: false, tabCount: 2, labels }

let cleanup: Array<() => void> = []
afterEach(() => { cleanup.forEach((fn) => fn()); cleanup = []; setNativeChromeShell(null) })

describe('native chrome seam', () => {
  it('no host: nothing is pushed and nothing is installed', () => {
    expect(nativeChromeInstalled()).toBe(false)
    setNativeChromeShell(shellState)
    expect(nativeChromeState()).toMatchObject({ mode: 'shell', title: 'Home' })
  })
  it('pushes the effective state once per change; last claim wins; release restores the shell', () => {
    const seen: NativeChromeState[] = []
    cleanup.push(installNativeChromeHost({ render: (s) => seen.push(s) }))
    expect(seen).toEqual([{ mode: 'hidden' }])
    setNativeChromeShell(shellState)
    setNativeChromeShell(shellState) // identical → deduplicated
    expect(seen).toHaveLength(2)
    expect(seen[1]).toMatchObject({ mode: 'shell', left: true, tabCount: 2 })
    const hidden = claimNativeChrome({ mode: 'hidden' })
    const onBack = vi.fn()
    const page = claimNativeChrome({ mode: 'page', title: 'Settings', back: 'Back', onBack })
    expect(seen.at(-1)).toEqual({ mode: 'page', title: 'Settings', back: 'Back' })
    expect(dispatchNativeChromeAction('back')).toBe(true)
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(dispatchNativeChromeAction('left')).toBe(false) // covered shell does not react
    page.release()
    expect(seen.at(-1)).toEqual({ mode: 'hidden' })
    hidden.release()
    expect(seen.at(-1)).toMatchObject({ mode: 'shell', title: 'Home' })
  })
  it('page claims may carry a close (×) action; close without a handler is not offered', () => {
    const seen: NativeChromeState[] = []
    cleanup.push(installNativeChromeHost({ render: (s) => seen.push(s) }))
    setNativeChromeShell(shellState)
    const onBack = vi.fn(); const onClose = vi.fn()
    const page = claimNativeChrome({ mode: 'page', title: 'Models', back: 'Settings', close: 'Back to app', onBack, onClose })
    expect(seen.at(-1)).toEqual({ mode: 'page', title: 'Models', back: 'Settings', close: 'Back to app' })
    expect(dispatchNativeChromeAction('close')).toBe(true)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onBack).not.toHaveBeenCalled()
    page.update({ mode: 'page', title: 'Settings', back: 'Back to app', close: 'ignored', onBack })
    expect(seen.at(-1)).toEqual({ mode: 'page', title: 'Settings', back: 'Back to app' })
    expect(dispatchNativeChromeAction('close')).toBe(false)
    page.release()
    expect(dispatchNativeChromeAction('close')).toBe(false) // the shell has no close
  })
  it('routes shell actions to the shell handlers', () => {
    cleanup.push(installNativeChromeHost({ render: () => {} }))
    const left = vi.fn(); const tabs = vi.fn()
    setNativeChromeShell(shellState, { left, tabs })
    expect(dispatchNativeChromeAction('left')).toBe(true)
    expect(dispatchNativeChromeAction('tabs')).toBe(true)
    expect(dispatchNativeChromeAction('more')).toBe(false)
    expect(dispatchNativeChromeAction('back')).toBe(false)
    expect(left).toHaveBeenCalledTimes(1)
    expect(tabs).toHaveBeenCalledTimes(1)
  })
  it('an old uninstall cannot remove a replacement host; a throwing host does not break callers', () => {
    const a = installNativeChromeHost({ render: () => { throw new Error('bridge down') } })
    expect(() => setNativeChromeShell(shellState)).not.toThrow()
    const b = installNativeChromeHost({ render: () => {} })
    a(); expect(nativeChromeInstalled()).toBe(true)
    b(); expect(nativeChromeInstalled()).toBe(false)
  })
})
