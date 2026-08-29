import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HOMEPAGE_WALLPAPER_PREFS, mapBingArchive, normalizeHomepageWallpaperPrefs,
} from './homepageWallpaper'

describe('homepage wallpaper prefs', () => {
  it('normalizes old or malformed persisted values to safe defaults', () => {
    expect(normalizeHomepageWallpaperPrefs(null)).toEqual(DEFAULT_HOMEPAGE_WALLPAPER_PREFS)
    expect(normalizeHomepageWallpaperPrefs({ source: 'javascript:', bingDaily: 0, focusBlur: 0 })).toMatchObject({
      source: 'theme', themePreset: 'rings', bingDaily: true, focusBlur: true, vignette: true,
    })
  })

  it('keeps known theme presets and falls back from unknown ones', () => {
    expect(normalizeHomepageWallpaperPrefs({ themePreset: 'topography' }).themePreset).toBe('topography')
    expect(normalizeHomepageWallpaperPrefs({ themePreset: 'something-else' }).themePreset).toBe('rings')
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
