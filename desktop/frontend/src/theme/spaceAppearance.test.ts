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
    useTheme.getState().syncFromWindow({ spaceAppearance: { id: 'notes', appearance: {} } })
    expect(useVisualTheme.getState()).toMatchObject({ skin: 'teal', bg: 'coral', mode: 'light' })
    expect(localStorage.getItem('forsion_space_appearance.notes')).toBeNull()
  }, 15000)
  it('keeps the previous setting if storage cannot save', async () => {
    const { useSpaceAppearance, setSpaceAppearance } = await import('../stores/spaceAppearanceStore')
    setSpaceAppearance('notes', { skin: 'teal' })
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('full') })
    expect(setSpaceAppearance('notes', { skin: 'coral' })).toBe(false)
    expect(useSpaceAppearance.getState().byId.notes).toEqual({ skin: 'teal' })
    spy.mockRestore()
  })
})
