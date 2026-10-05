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
    // 别的窗口「恢复继承」:它先改了同源存储,再发通知。本窗只把通知当信号,值从存储读,自己不落盘。
    localStorage.removeItem('forsion_space_appearance.notes')
    useTheme.getState().syncFromWindow({ spaceAppearance: { id: 'notes', appearance: {} } })
    expect(useVisualTheme.getState()).toMatchObject({ skin: 'teal', bg: 'coral', mode: 'light' })
    expect(localStorage.getItem('forsion_space_appearance.notes')).toBeNull()
  }, 15000)
  it('a late, older message from another window can neither roll back memory nor touch storage', async () => {
    const { useTheme } = await import('../stores/themeStore')
    const { useSpaceAppearance, setSpaceAppearance } = await import('../stores/spaceAppearanceStore')
    const key = 'forsion_space_appearance.notes'
    expect(setSpaceAppearance('notes', { skin: 'teal', bg: 'lavender' })).toBe(true) // 本窗是最后保存的
    const stored = localStorage.getItem(key)
    // 另一个窗口更早保存的 coral:IPC 晚到、storage 事件晚到、一条旧的「恢复继承」也晚到
    useTheme.getState().syncFromWindow({ spaceAppearance: { id: 'notes', appearance: { skin: 'coral' } } })
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: JSON.stringify({ skin: 'coral' }) }))
    useTheme.getState().syncFromWindow({ spaceAppearance: { id: 'notes', appearance: {} } })
    expect(useSpaceAppearance.getState().byId.notes).toEqual({ skin: 'teal', bg: 'lavender' })
    expect(localStorage.getItem(key)).toBe(stored)
    // 之后在本窗改另一根轴(Ribbon 明暗就是这么写的):合并的是没被旧消息污染的内存
    setSpaceAppearance('notes', { ...useSpaceAppearance.getState().byId.notes, modePref: 'dark' })
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ skin: 'teal', bg: 'lavender', modePref: 'dark' })
    // 别的窗口真的后保存了:存储变了,信号一到就跟上,本窗仍不写
    localStorage.setItem(key, JSON.stringify({ skin: 'lavender' }))
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: JSON.stringify({ skin: 'lavender' }) }))
    expect(useSpaceAppearance.getState().byId.notes).toEqual({ skin: 'lavender' })
    expect(localStorage.getItem(key)).toBe(JSON.stringify({ skin: 'lavender' }))
  })
  it('an IPC notice that outruns storage propagation is picked up by the delayed re-read', async () => {
    const { useTheme } = await import('../stores/themeStore')
    const { useSpaceAppearance } = await import('../stores/spaceAppearanceStore')
    vi.useFakeTimers()
    try {
      useTheme.getState().syncFromWindow({ spaceAppearance: { id: 'notes', appearance: { skin: 'coral' } } })
      expect(useSpaceAppearance.getState().byId.notes ?? {}).toEqual({}) // 存储里还没有,不信载荷
      localStorage.setItem('forsion_space_appearance.notes', JSON.stringify({ skin: 'coral' })) // 传播到了,但没有 storage 事件
      vi.advanceTimersByTime(300)
      expect(useSpaceAppearance.getState().byId.notes).toEqual({ skin: 'coral' })
    } finally { vi.useRealTimers() }
  })
  it('reset removes the key and an older message cannot resurrect the override', async () => {
    const { useSpaceAppearance, setSpaceAppearance, receiveSpaceAppearance } = await import('../stores/spaceAppearanceStore')
    setSpaceAppearance('notes', { skin: 'teal' })
    expect(setSpaceAppearance('notes', {})).toBe(true)
    expect(localStorage.getItem('forsion_space_appearance.notes')).toBeNull()
    receiveSpaceAppearance({ id: 'notes', appearance: { skin: 'coral' } })
    expect(useSpaceAppearance.getState().byId.notes).toEqual({})
    expect(localStorage.getItem('forsion_space_appearance.notes')).toBeNull()
  })
  it('honours the forced-scheme hint before the disk theme manifest arrives, even for a Space with its own mode', async () => {
    // 上次用的是强制 dark 的磁盘主题:清单没到之前 registry 不认识它,只有首帧提示可依
    localStorage.setItem('forsion_theme_lang', 'disk-forced-dark')
    localStorage.setItem('forsion_theme_pref', 'light')
    localStorage.setItem('forsion_theme_forced_scheme', 'dark')
    localStorage.setItem('forsion_space_appearance.notes', JSON.stringify({ modePref: 'light' }))
    const { useSpaceStore } = await import('@lcl/engine/spaceRegistry')
    useSpaceStore.setState({ activeSpaceId: 'notes' })
    const { useTheme, useVisualTheme } = await import('../stores/themeStore')
    expect(useTheme.getState()).toMatchObject({ mode: 'dark', modeLocked: true, modePref: 'light' })
    useTheme.setState({}) // 触发一次视觉投影(生产里是 initThemes 开头那次)
    expect(useVisualTheme.getState()).toMatchObject({ mode: 'dark', modeLocked: true })
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
  it('content-tinted chrome stays off until the user turns it on, follows another window, and survives a restart', async () => {
    const { useTheme, useVisualTheme } = await import('../stores/themeStore')
    expect(useTheme.getState().ambient).toBe(false)
    expect(document.documentElement.dataset.ambient).toBe('off')
    useTheme.getState().setAmbient(true)
    expect(document.documentElement.dataset.ambient).toBe('on')
    expect(localStorage.getItem('forsion_theme_ambient')).toBe('on')
    expect(useVisualTheme.getState().ambient).toBe(true)
    // 设置浮窗关掉它 → 本窗跟着关;不带这一项的旧窗口发来的主题变更不动它。
    // vitest 里内置设计语言不注册 → 重放走「先重扫磁盘主题」那条异步路,所以要等。
    const s = useTheme.getState()
    const axes = { lang: s.lang, skin: s.skin, bg: s.bg, modePref: s.modePref, seed: s.seed, bgSeed: s.bgSeed, glass: s.glass }
    s.syncFromWindow({ theme: { ...axes, flat: true } })
    await vi.waitFor(() => expect(useTheme.getState().flat).toBe(true))
    expect(useTheme.getState().ambient).toBe(true)
    // 开关本身不排那条异步路:消息一到就落(否则晚到的旧重放会盖掉更新的选择)。
    s.syncFromWindow({ theme: { ...axes, lang: 'disk-theme-not-here', ambient: true } })
    s.syncFromWindow({ theme: { ...axes, ambient: false } })
    expect(document.documentElement.dataset.ambient).toBe('off')
    expect(useVisualTheme.getState().ambient).toBe(false)
    await new Promise((r) => setTimeout(r, 30)) // 让两条延后的重放都跑完
    expect(useTheme.getState().ambient).toBe(false)
    expect(localStorage.getItem('forsion_theme_ambient')).toBe('off')
    localStorage.setItem('forsion_theme_ambient', 'on')
    vi.resetModules()
    delete document.documentElement.dataset.ambient
    const again = await import('../stores/themeStore')
    expect(again.useTheme.getState().ambient).toBe(true)
    expect(document.documentElement.dataset.ambient).toBe('on')
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
