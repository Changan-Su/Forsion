// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeUiSync } from '../../../shared/uiSync'
import { normalizeSpaceAppearance } from '../../../shared/spaceAppearance'
import { resolveSpaceAppearance } from './spaceAppearance'

const global = { lang: 'lovable', skin: 'teal', bg: 'cream', seed: '#123456', bgSeed: '#654321', modePref: 'light' as const, mode: 'light' as const, modeLocked: false }

describe('Space appearance inheritance', () => {
  it('inherits each missing axis and ignores unavailable themes without deleting the saved choice', () => {
    expect(resolveSpaceAppearance(global)).toEqual(global)
    expect(resolveSpaceAppearance(global, { skin: 'coral', lang: 'uninstalled' })).toEqual({ ...global, skin: 'coral' })
    expect(resolveSpaceAppearance({ ...global, bg: 'lavender' }, { skin: 'coral' }).bg).toBe('lavender')
  })
  it('does not apply dormant local seeds to an inherited global custom palette', () => {
    expect(resolveSpaceAppearance({ ...global, skin: 'custom', bg: 'custom' }, { seed: '#ffffff', bgSeed: '#000000' })).toMatchObject({ seed: global.seed, bgSeed: global.bgSeed })
    expect(resolveSpaceAppearance(global, { skin: 'custom', seed: '#ffffff', bg: 'custom', bgSeed: '' })).toMatchObject({ seed: '#ffffff', bgSeed: '' })
  })
  it('keeps the already-resolved global mode while it inherits the language (disk theme manifest not loaded yet)', () => {
    // 首帧:磁盘主题强制 dark,registry 还不认识它 → modeLocked 尚为 false,mode 已按 forced_scheme 提示落成 dark
    const booting = { ...global, lang: 'disk-theme-not-loaded', modePref: 'light' as const, mode: 'dark' as const, modeLocked: false }
    expect(resolveSpaceAppearance(booting)).toMatchObject({ mode: 'dark', modeLocked: false })
    expect(resolveSpaceAppearance(booting, { skin: 'coral' })).toMatchObject({ mode: 'dark', skin: 'coral' })
    // 全局锁了明暗:Space 自己的明暗偏好让位
    expect(resolveSpaceAppearance({ ...booting, modeLocked: true }, { modePref: 'light' })).toMatchObject({ mode: 'dark', modeLocked: true })
    // 没锁:Space 自己的明暗偏好生效
    expect(resolveSpaceAppearance({ ...global, mode: 'light' }, { modePref: 'dark' })).toMatchObject({ mode: 'dark', modeLocked: false })
  })
  it('validates the cross-window update and explicit reset', () => {
    expect(normalizeSpaceAppearance({ skin: 'teal', modePref: 'auto', seed: 'red', bg: '<script>', unknown: 'x' })).toEqual({ skin: 'teal' })
    expect(normalizeUiSync({ spaceAppearance: { id: 'tangu', appearance: {} } })?.spaceAppearance).toEqual({ id: 'tangu', appearance: {} })
    expect(normalizeUiSync({ spaceAppearance: { id: 'tangu', appearance: { skin: 'teal' }, at: 1791000000000 } })?.spaceAppearance).toEqual({ id: 'tangu', appearance: { skin: 'teal' }, at: 1791000000000 })
    expect(normalizeUiSync({ spaceAppearance: { id: 'tangu', appearance: {}, at: '1' } })?.spaceAppearance).toEqual({ id: 'tangu', appearance: {} })
    expect(normalizeUiSync({ spaceAppearance: { id: '../x', appearance: {} } })).toBeNull()
    expect(normalizeUiSync({ spaceAppearance: { id: 'tangu', appearance: [] } })).toBeNull()
  })
})

describe('persistent global settings versus rendered Space settings', () => {
  beforeEach(() => { vi.resetModules(); localStorage.clear() })
  it('switches Space / replays settings without overwriting global preferences', async () => {
    const { useTheme, useVisualTheme } = await import('../stores/themeStore')
    const { useSpaceStore } = await import('@lcl/engine/spaceRegistry')
    const { setSpaceAppearance } = await import('../stores/spaceAppearanceStore')
    useTheme.getState().setTheme('lovable', 'teal', 'cream', 'light')
    useSpaceStore.setState({ activeSpaceId: 'notes' })
    expect(setSpaceAppearance('notes', { skin: 'custom', seed: '#ff2200', bg: 'lavender', modePref: 'dark' })).toBe(true)
    expect(useVisualTheme.getState()).toMatchObject({ skin: 'custom', bg: 'lavender', mode: 'dark' })
    expect(document.documentElement.dataset.skin).toBe('custom')
    expect(localStorage.getItem('forsion_theme_skin')).toBe('teal')
    expect(localStorage.getItem('forsion_theme')).toBe('light')
    expect(localStorage.getItem('forsion_theme_seed')).not.toBe('#ff2200')
    useTheme.getState().setBg('coral')
    expect(document.documentElement.dataset.bg).toBe('lavender')
    useTheme.getState().setSeedValue('#123456')
    expect(document.documentElement.dataset.skin).toBe('custom')
    expect(useVisualTheme.getState().seed).toBe('#ff2200')
    useSpaceStore.setState({ activeSpaceId: 'tangu' })
    expect(useVisualTheme.getState()).toMatchObject({ skin: 'teal', bg: 'coral', mode: 'light' })
    useSpaceStore.setState({ activeSpaceId: 'notes' })
    expect(useVisualTheme.getState().mode).toBe('dark')
    // 别的窗口发来「恢复继承」:本窗只更新内存。落盘是发方的事(同源存储),收方再写一遍会把晚到的旧消息盖到新保存上。
    const stored = localStorage.getItem('forsion_space_appearance.notes')
    useTheme.getState().syncFromWindow({ spaceAppearance: { id: 'notes', appearance: {}, at: Date.now() + 10_000 } })
    expect(useVisualTheme.getState()).toMatchObject({ skin: 'teal', bg: 'coral', mode: 'light' })
    expect(localStorage.getItem('forsion_space_appearance.notes')).toBe(stored)
  }, 15000)
  it('rejects a late, older update from another window on both channels and never persists what it receives', async () => {
    const { useTheme } = await import('../stores/themeStore')
    const { useSpaceAppearance, setSpaceAppearance } = await import('../stores/spaceAppearanceStore')
    expect(setSpaceAppearance('notes', { skin: 'teal' })).toBe(true)
    const stored = localStorage.getItem('forsion_space_appearance.notes')!
    const at = JSON.parse(stored).at as number
    expect(at).toBeGreaterThan(0)
    // 另一个窗口更早保存的 coral,IPC 晚到
    useTheme.getState().syncFromWindow({ spaceAppearance: { id: 'notes', appearance: { skin: 'coral' }, at: at - 5 } })
    // 同一条旧值再从 storage 事件来一遍
    window.dispatchEvent(new StorageEvent('storage', { key: 'forsion_space_appearance.notes', newValue: JSON.stringify({ skin: 'coral', at: at - 5 }) }))
    // 不带时间戳的旧格式消息同样算旧
    useTheme.getState().syncFromWindow({ spaceAppearance: { id: 'notes', appearance: {} } })
    expect(useSpaceAppearance.getState().byId.notes).toEqual({ skin: 'teal' })
    expect(localStorage.getItem('forsion_space_appearance.notes')).toBe(stored)
    // 更新的照收,但仍不落盘
    useTheme.getState().syncFromWindow({ spaceAppearance: { id: 'notes', appearance: { skin: 'lavender' }, at: at + 5 } })
    expect(useSpaceAppearance.getState().byId.notes).toEqual({ skin: 'lavender' })
    expect(localStorage.getItem('forsion_space_appearance.notes')).toBe(stored)
  })
  it('keeps a stamped empty record on reset so an older update cannot resurrect the override', async () => {
    const { useSpaceAppearance, setSpaceAppearance, receiveSpaceAppearance } = await import('../stores/spaceAppearanceStore')
    setSpaceAppearance('notes', { skin: 'teal' })
    const before = JSON.parse(localStorage.getItem('forsion_space_appearance.notes')!).at as number
    expect(setSpaceAppearance('notes', {})).toBe(true)
    const reset = JSON.parse(localStorage.getItem('forsion_space_appearance.notes')!)
    expect(Object.keys(reset)).toEqual(['at'])
    expect(reset.at).toBeGreaterThan(before) // 同一毫秒内连写两次也严格递增
    expect(receiveSpaceAppearance({ id: 'notes', appearance: { skin: 'coral' }, at: before })).toBe(false)
    expect(useSpaceAppearance.getState().byId.notes).toEqual({})
    // 重新装载(刷新 / 新窗口)读回来仍是「继承全局」,时间戳不进外观对象
    vi.resetModules()
    const again = await import('../stores/spaceAppearanceStore')
    expect(again.useSpaceAppearance.getState().byId.notes).toEqual({})
    expect(again.receiveSpaceAppearance({ id: 'notes', appearance: { skin: 'coral' }, at: before })).toBe(false)
  })
  it('Ribbon mode toggle writes to the Space when the global language locks the scheme but the Space language does not', async () => {
    const { useTheme, useVisualTheme, toggleVisibleMode } = await import('../stores/themeStore')
    const { useSpaceStore } = await import('@lcl/engine/spaceRegistry')
    const { useSpaceAppearance, setSpaceAppearance } = await import('../stores/spaceAppearanceStore')
    const { mergeDiskThemes } = await import('./registry')
    // 测试环境里 bundle 语言注册不进来(css ?url),用两套磁盘主题:一套锁明暗,一套不锁
    mergeDiskThemes([{ id: 'locked', manifest: { name: 'Locked', colorScheme: 'light' }, css: '' }, { id: 'free', manifest: { name: 'Free' }, css: '' }])
    useTheme.getState().setTheme('locked', 'cream', 'cream', 'light')
    expect(useTheme.getState().modeLocked).toBe(true)
    useSpaceStore.setState({ activeSpaceId: 'notes' })
    setSpaceAppearance('notes', { lang: 'free' })
    expect(useVisualTheme.getState()).toMatchObject({ lang: 'free', modeLocked: false, mode: 'light' })
    await toggleVisibleMode()
    expect(useSpaceAppearance.getState().byId.notes).toEqual({ lang: 'free', modePref: 'dark' })
    expect(useVisualTheme.getState().mode).toBe('dark')
    expect(useTheme.getState().modePref).toBe('light') // 全局偏好没被动
  })
  it('keeps the previous setting if storage cannot save', async () => {
    const { useSpaceAppearance, setSpaceAppearance } = await import('../stores/spaceAppearanceStore')
    setSpaceAppearance('notes', { skin: 'teal' })
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('full') })
    expect(setSpaceAppearance('notes', { skin: 'coral' })).toBe(false)
    expect(useSpaceAppearance.getState().byId.notes).toEqual({ skin: 'teal' })
    spy.mockRestore()
  })
})
