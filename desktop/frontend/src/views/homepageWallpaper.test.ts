import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HOMEPAGE_WALLPAPER_PREFS, mapBingArchive, normalizeHomepageWallpaperPrefs,
} from './homepageWallpaper'

describe('homepage wallpaper prefs', () => {
  it('normalizes old or malformed persisted values to safe defaults', () => {
    expect(normalizeHomepageWallpaperPrefs(null)).toEqual(DEFAULT_HOMEPAGE_WALLPAPER_PREFS)
    expect(normalizeHomepageWallpaperPrefs({ source: 'javascript:', bingDaily: 0, focusBlur: 0 })).toMatchObject({
      source: 'theme', themePreset: 'orbit', imageChoice: 'hack2gate', bingDaily: true, focusBlur: true, vignette: true, motion: true,
    })
    expect(normalizeHomepageWallpaperPrefs({ motion: false }).motion).toBe(false)
  })

  it('maps the retired presets and sources onto the new set', () => {
    expect(normalizeHomepageWallpaperPrefs({ themePreset: 'rings' }).themePreset).toBe('orbit')
    expect(normalizeHomepageWallpaperPrefs({ themePreset: 'topography' }).themePreset).toBe('path')
    expect(normalizeHomepageWallpaperPrefs({ themePreset: 'weave' }).themePreset).toBe('paper')
    expect(normalizeHomepageWallpaperPrefs({ themePreset: 'horizon' }).themePreset).toBe('orbit')
    expect(normalizeHomepageWallpaperPrefs({ themePreset: 'path' }).themePreset).toBe('path')
    // Hack2Gate 是位图,挪进「图片」;正在用必应的人只记下选择,来源不动
    expect(normalizeHomepageWallpaperPrefs({ source: 'theme', themePreset: 'hack2gate' })).toMatchObject({ source: 'image', imageChoice: 'hack2gate', themePreset: 'orbit' })
    expect(normalizeHomepageWallpaperPrefs({ source: 'bing', themePreset: 'hack2gate' })).toMatchObject({ source: 'bing', imageChoice: 'hack2gate' })
    expect(normalizeHomepageWallpaperPrefs({ source: 'custom', themePreset: 'weave' })).toMatchObject({ source: 'image', imageChoice: 'custom', themePreset: 'paper' })
  })

  it('accepts only Bing https images from the archive', () => {
    const items = mapBingArchive({ images: [
      { startdate: '20260829', urlbase: '/th?id=OHR.Sample_EN-US0000000000', title: 'Sample', copyright: 'Bing' },
      { startdate: 'bad', url: 'https://tracker.example/wallpaper.jpg' },
    ] })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ id: '20260829', title: 'Sample', startDate: '20260829' })
    expect(items[0].url).toBe('https://www.bing.com/th?id=OHR.Sample_EN-US0000000000_UHD.jpg')
    expect(items[0].thumbnailUrl).toBe('https://www.bing.com/th?id=OHR.Sample_EN-US0000000000_400x240.jpg')
  })

  it('drops a tampered saved Bing URL instead of restoring it', () => {
    const prefs = normalizeHomepageWallpaperPrefs({
      source: 'bing',
      bing: { id: 'x', url: 'http://127.0.0.1/private', thumbnailUrl: 'https://www.bing.com/x.jpg' },
    })
    expect(prefs.source).toBe('bing')
    expect(prefs.bing).toBeNull()
  })
})
