import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HOMEPAGE_WALLPAPER_PREFS, mapBingArchive, normalizeHomepageWallpaperPrefs,
} from './homepageWallpaper'

describe('homepage wallpaper prefs', () => {
  it('normalizes old or malformed persisted values to safe defaults', () => {
    expect(normalizeHomepageWallpaperPrefs(null)).toEqual(DEFAULT_HOMEPAGE_WALLPAPER_PREFS)
    expect(normalizeHomepageWallpaperPrefs({ source: 'javascript:', bingDaily: 0, focusBlur: 0 })).toMatchObject({
      source: 'theme', themePreset: 'orbit', bingDaily: true, focusBlur: true, vignette: true, motion: true,
    })
    expect(normalizeHomepageWallpaperPrefs({ motion: false }).motion).toBe(false)
  })

  it('maps the retired presets and sources onto the new set', () => {
    expect(normalizeHomepageWallpaperPrefs({ themePreset: 'rings' }).themePreset).toBe('orbit')
    expect(normalizeHomepageWallpaperPrefs({ themePreset: 'topography' }).themePreset).toBe('path')
    expect(normalizeHomepageWallpaperPrefs({ themePreset: 'weave' }).themePreset).toBe('paper')
    expect(normalizeHomepageWallpaperPrefs({ themePreset: 'horizon' }).themePreset).toBe('orbit')
    expect(normalizeHomepageWallpaperPrefs({ themePreset: 'path' }).themePreset).toBe('path')
    expect(normalizeHomepageWallpaperPrefs({ themePreset: 'glyph' }).themePreset).toBe('glyph')
    // 扶桑环:旧格式(没有 motion 字段)里的 rings 多半是当年的缺省值 → 星轨;新格式里的 rings 是自己选的,留着
    expect(normalizeHomepageWallpaperPrefs({ themePreset: 'rings', motion: true }).themePreset).toBe('rings')
    expect(normalizeHomepageWallpaperPrefs({ themePreset: 'topography', motion: true }).themePreset).toBe('orbit')
    // Hack2Gate 海报 10-18 去掉:选着它的回到主题背景;正在用必应的不动;自己上传的图片照旧
    expect(normalizeHomepageWallpaperPrefs({ source: 'theme', themePreset: 'hack2gate' })).toMatchObject({ source: 'theme', themePreset: 'orbit' })
    expect(normalizeHomepageWallpaperPrefs({ source: 'image', imageChoice: 'hack2gate', motion: true })).toMatchObject({ source: 'theme' })
    expect(normalizeHomepageWallpaperPrefs({ source: 'bing', themePreset: 'hack2gate' })).toMatchObject({ source: 'bing' })
    expect(normalizeHomepageWallpaperPrefs({ source: 'image', imageChoice: 'custom', motion: true })).toMatchObject({ source: 'image' })
    expect(normalizeHomepageWallpaperPrefs({ source: 'image', motion: true })).toMatchObject({ source: 'image' })
    expect(normalizeHomepageWallpaperPrefs({ source: 'custom', themePreset: 'weave' })).toMatchObject({ source: 'image', themePreset: 'paper' })
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
