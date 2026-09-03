// 首屏语言优先级链(i18n.tsx resolveInitialLocale)。钉的是**判定顺序**,不是词条。
// 为什么值得一个单测:四个分支互相压过,而线上表现是「界面语言不对」这种没人会写 bug 单
// 的软故障 —— 改错了不崩、不红、不报错,只有海外用户看见中文。
//
// vitest 环境是 node:localStorage / navigator.languages 都得自己搭桩(见 vitest.config.ts)。
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { resolveInitialLocale, correctLocaleByRegion, currentLocale, setLocaleGlobal } from './i18n'

const store = new Map<string, string>()

function stubLocalStorage(available = true): void {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: available
      ? {
          getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
          setItem: (k: string, v: string) => { store.set(k, v) },
          removeItem: (k: string) => { store.delete(k) },
        }
      // 隐私模式:访问即抛。resolveInitialLocale 必须活下来。
      : { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } },
  })
}

/** langs=null 模拟连 navigator 都没有(纯 node / 老 webview)。 */
function stubNavigator(langs: string[] | null): void {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: langs === null ? undefined : { languages: langs, language: langs[0] },
  })
}

describe('首屏语言优先级链', () => {
  beforeEach(() => { store.clear(); stubLocalStorage(true) })
  afterEach(() => { store.clear() })

  it('① 用户手选压过一切(系统英文 + IP 非中国仍给中文)', () => {
    store.set('tangu_locale', 'zh')
    store.set('forsion_region', 'US')
    stubNavigator(['en-US'])
    expect(resolveInitialLocale()).toBe('zh')
    // 反向同样成立:中文系统 + 中国 IP,手选英文就是英文
    store.set('tangu_locale', 'en')
    store.set('forsion_region', 'CN')
    stubNavigator(['zh-CN'])
    expect(resolveInitialLocale()).toBe('en')
  })

  it('② 系统中文 = 定论,连 IP 缓存都不查(zh-TW/zh-HK 同归 zh)', () => {
    store.set('forsion_region', 'US') // 故意放一个反向的区域,不许它生效
    for (const l of ['zh-CN', 'zh-TW', 'zh-HK', 'zh']) {
      stubNavigator([l])
      expect(resolveInitialLocale(), l).toBe('zh')
    }
  })

  it('③ 系统非中文时由 IP 区域裁决:CN→zh,其余→en', () => {
    stubNavigator(['en-US'])
    store.set('forsion_region', 'CN')
    expect(resolveInitialLocale()).toBe('zh') // 国内开发者跑英文系统:IP 把他掰回中文
    store.set('forsion_region', 'US')
    expect(resolveInitialLocale()).toBe('en')
    store.set('forsion_region', 'JP')
    expect(resolveInitialLocale()).toBe('en')
  })

  it('④ 无区域缓存时回落系统语言:非中文一律英文', () => {
    for (const l of ['en-US', 'en', 'ja-JP', 'de-DE', 'fr', 'ko-KR', 'ru-RU']) {
      stubNavigator([l])
      expect(resolveInitialLocale(), l).toBe('en')
    }
  })

  it('④ 连语言信号都没有 → 兜底中文', () => {
    stubNavigator(null)
    expect(resolveInitialLocale()).toBe('zh')
    stubNavigator([]) // languages 空数组 + language 为 undefined
    expect(resolveInitialLocale()).toBe('zh')
  })

  it('navigator.languages 缺失时退 navigator.language 单值', () => {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en-GB' } })
    expect(resolveInitialLocale()).toBe('en')
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'zh-CN' } })
    expect(resolveInitialLocale()).toBe('zh')
  })

  it('localStorage 不可用(隐私模式)不崩,退到系统语言', () => {
    stubLocalStorage(false)
    stubNavigator(['en-US'])
    expect(resolveInitialLocale()).toBe('en')
    stubNavigator(['zh-CN'])
    expect(resolveInitialLocale()).toBe('zh')
  })

  it('languages 首项为空串时跳过,取下一个有效项', () => {
    stubNavigator(['', 'zh-CN'])
    expect(resolveInitialLocale()).toBe('zh')
  })

  // ── IP 校正的边界(2026-09-03 实测抓到的真 bug)────────────────────────────────
  describe('correctLocaleByRegion 的越权闸', () => {
    let fetched: string[] = []
    const stubFetch = (country: string | null): void => {
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        value: async (u: string) => { fetched.push(String(u)); return { ok: true, json: async () => ({ country }) } },
      })
    }
    const stubTangu = (cloudUrl: string): void => {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { tangu: { getConfig: async () => ({ cloudUrl }) } },
      })
    }

    beforeEach(() => { fetched = []; stubLocalStorage(true); setLocaleGlobal('zh'); store.clear() })

    it('⚠️ 系统中文 → 根本不外呼(中文用户出国不许被 IP 翻成英文)', async () => {
      stubNavigator(['zh-CN']); stubTangu('https://api.forsion.net'); stubFetch('GB')
      await correctLocaleByRegion()
      expect(fetched, '系统已是中文,不该再查 IP').toEqual([])
      expect(currentLocale()).toBe('zh')
    })

    it('用户手选过 → 不外呼', async () => {
      store.set('tangu_locale', 'en')
      stubNavigator(['en-US']); stubTangu('https://api.forsion.net'); stubFetch('CN')
      await correctLocaleByRegion()
      expect(fetched).toEqual([])
    })

    it('英文系统 + IP=CN → 掰回中文,并缓存区域', async () => {
      stubNavigator(['en-US']); stubTangu('https://api.forsion.net'); stubFetch('CN')
      setLocaleGlobal('en'); store.delete('tangu_locale') // ⚠️ setLocaleGlobal 顺手持久化,这里要的是「当前 en 但用户没手选过」
      await correctLocaleByRegion()
      expect(fetched).toEqual(['https://api.forsion.net/api/auth/region'])
      expect(store.get('forsion_region')).toBe('CN')
      expect(currentLocale()).toBe('zh')
      setLocaleGlobal('zh')
    })

    it('⚠️ cloudUrl 已含 /api(web/mobile 垫片形态)→ 不重复拼 /api', async () => {
      stubNavigator(['en-US']); stubTangu('https://forsion.net/api'); stubFetch('US')
      await correctLocaleByRegion()
      expect(fetched).toEqual(['https://forsion.net/api/auth/region'])
    })

    it('geo 查不到(country=null)→ 不缓存,同步链结论不动', async () => {
      stubNavigator(['en-US']); stubTangu('https://api.forsion.net'); stubFetch(null)
      setLocaleGlobal('en'); store.delete('tangu_locale') // ⚠️ setLocaleGlobal 顺手持久化,这里要的是「当前 en 但用户没手选过」
      await correctLocaleByRegion()
      expect(store.get('forsion_region')).toBeUndefined()
      expect(currentLocale()).toBe('en')
      setLocaleGlobal('zh')
    })
  })
})
