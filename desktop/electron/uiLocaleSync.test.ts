// @vitest-environment happy-dom
// P1-KF · 主进程文案跟渲染层的**生效**语言走(修 K5 接线:原先只读 localStorage `tangu_locale` 手选键)。
// 端到端地钉:真 LocaleProvider(渲染层四级链)挂载 → preload 同形的 reportUiLocale → uiLocaleSync.report → mainI18n → mt()。
// 复现场景 = P1-K3 修复报告的实测:界面中文(系统英文 + IP 区域 = CN,没手选过),远程审批系统通知却是英文。
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPreferredSystemLanguages: () => ['en-US'], isPackaged: false },
  Tray: class { setToolTip(): void {} setContextMenu(): void {} on(): void {} },
  Menu: { buildFromTemplate: (t: unknown) => t },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
}))

import { LocaleProvider, setLocaleGlobal } from '../frontend/src/i18n'
import { initMainLocale, mainLocale, mt, setMainLocale } from './mainI18n'
import { createUiLocaleSync, type UiLocaleSync } from './uiLocaleSync'
import { APPROVAL_DELIVERY_MESSAGES } from './approvalDelivery'
import { confirmDialogOptions } from './remoteSessions'
import { trayLang } from './tray'

const APPROVAL_TITLE = 'main.approvalDelivery.approvalTitleUnknown'
const ZH_TITLE = APPROVAL_DELIVERY_MESSAGES[APPROVAL_TITLE].zh
const EN_TITLE = APPROVAL_DELIVERY_MESSAGES[APPROVAL_TITLE].en

/** userData 里的 ui-locale.json(内存版)。 */
const disk = new Map<string, string>()
const FILE = '/userData/ui-locale.json'
const writes: unknown[] = []
function makeSync(over: Partial<Parameters<typeof createUiLocaleSync>[0]> = {}): UiLocaleSync {
  return createUiLocaleSync({
    file: () => FILE,
    readFileSync: (f) => { const v = disk.get(f); if (v === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return v },
    writeFile: async (f, d) => { writes.push(d); disk.set(f, JSON.stringify(d)) },
    ...over,
  })
}

/** 渲染层的环境:系统(navigator)语言 + localStorage。testSetup 的 setLocaleGlobal('zh') 写过手选键,这里必须清掉,否则 ③ 永远走不到(假绿)。 */
function rendererEnv(o: { navigator: string[]; region?: string | null }): void {
  Object.defineProperty(window.navigator, 'languages', { configurable: true, get: () => o.navigator })
  Object.defineProperty(window.navigator, 'language', { configurable: true, get: () => o.navigator[0] })
  localStorage.removeItem('tangu_locale')
  if (o.region) localStorage.setItem('forsion_region', o.region)
  else localStorage.removeItem('forsion_region')
}

let host: HTMLDivElement
let root: Root | null = null
async function mountRenderer(sync: UiLocaleSync): Promise<void> {
  // = preload.ts 的 reportUiLocale(ipcRenderer.send(UI_LOCALE_CHANNEL))+ main.ts 的 ipcMain.on(UI_LOCALE_CHANNEL → uiLocale.report)
  ;(window as unknown as { tangu: unknown }).tangu = { reportUiLocale: (l: 'zh' | 'en') => sync.report(l) }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(React.createElement(LocaleProvider, { children: React.createElement('div', null, 'app') })))
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  disk.clear()
  writes.length = 0
  setMainLocale(null)
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null
  host?.remove()
  delete (window as unknown as { tangu?: unknown }).tangu
  localStorage.removeItem('forsion_region')
  setLocaleGlobal('zh') // 复位 testSetup 的全局钉
  setMainLocale(null)
  initMainLocale({ systemLanguages: () => [] })
})

describe('主进程文案跟渲染层的生效语言(P1-KF)', () => {
  it('系统英文 + IP 区域 = CN(没手选)→ 界面中文 → 主进程文案(远程审批通知)也是中文', async () => {
    initMainLocale({ systemLanguages: () => ['en-US'] }) // = app.getPreferredSystemLanguages()
    rendererEnv({ navigator: ['en-US'], region: 'CN' })
    expect(mt(APPROVAL_TITLE)).toBe(EN_TITLE) // 前提:渲染层没报之前,主进程只有系统语言
    const sync = makeSync()
    await mountRenderer(sync)
    expect(localStorage.getItem('tangu_locale'), '渲染层按 ③ 判出中文,不写手选键 —— 读这个键的主进程就是英文').toBeNull()
    expect(mainLocale()).toBe('zh')
    expect(mt(APPROVAL_TITLE)).toBe(ZH_TITLE)
    // 同一语言源的其余主进程出口:远程会话确认框、托盘
    expect(confirmDialogOptions({ principal: 'account', cap: 'auto-edit' }).title).toBe('远程会话请求')
    expect(trayLang()).toBe('zh')
    await sync.flush()
    expect(JSON.parse(disk.get(FILE)!)).toEqual({ v: 1, locale: 'zh' })
  })

  it('反向对照:系统中文 + 渲染层判英文(英文系统浏览器语言 + IP 区域非 CN)→ 主进程跟渲染层是英文,不跟自己的系统语言', async () => {
    initMainLocale({ systemLanguages: () => ['zh-Hans-CN'] })
    rendererEnv({ navigator: ['en-GB'], region: 'GB' })
    expect(mt(APPROVAL_TITLE)).toBe(ZH_TITLE)
    await mountRenderer(makeSync())
    expect(mt(APPROVAL_TITLE)).toBe(EN_TITLE)
    expect(confirmDialogOptions({ principal: 'account', cap: 'auto-edit' }).title).toBe('Remote session request')
  })

  it('渲染层切语言(设置里手选)→ 主进程跟着切、缓存更新;同值不重复落盘', async () => {
    initMainLocale({ systemLanguages: () => ['en-US'] })
    rendererEnv({ navigator: ['en-US'], region: 'CN' })
    const sync = makeSync()
    await mountRenderer(sync)
    expect(mt(APPROVAL_TITLE)).toBe(ZH_TITLE)
    await act(async () => setLocaleGlobal('en'))
    expect(mt(APPROVAL_TITLE)).toBe(EN_TITLE)
    await act(async () => setLocaleGlobal('en'))
    await sync.flush()
    expect(writes).toEqual([{ v: 1, locale: 'zh' }, { v: 1, locale: 'en' }])
  })

  it('窗口载入之前:重启后先用上次报来的界面语言(不是系统语言);首次运行 / 缓存坏了才回落系统', async () => {
    initMainLocale({ systemLanguages: () => ['en-US'] })
    rendererEnv({ navigator: ['en-US'], region: 'CN' })
    const first = makeSync()
    await mountRenderer(first)
    await first.flush()
    // ── 模拟重启:进程内存清零,文件还在;渲染层还没挂 ──
    setMainLocale(null)
    initMainLocale({ systemLanguages: () => ['en-US'] })
    expect(mt(APPROVAL_TITLE)).toBe(EN_TITLE)
    expect(makeSync().seed()).toBe('zh')
    expect(mt(APPROVAL_TITLE), '托盘 / 启动期通知在窗口载入前就是界面语言').toBe(ZH_TITLE)
    // 首次运行(没有文件)与坏文件:null,文案回落系统语言,不抛
    setMainLocale(null)
    disk.clear()
    expect(makeSync().seed()).toBeNull()
    expect(mainLocale()).toBe('en')
    for (const bad of ['{', '{"v":1,"locale":"fr"}', 'null', '[]']) {
      disk.set(FILE, bad)
      expect(makeSync().seed(), bad).toBeNull()
      expect(mainLocale()).toBe('en')
    }
  })

  it('只认 zh / en:插件也够得着 window.tangu,乱报的值丢弃(不当成「跟随系统」把已对上的语言重置)', () => {
    initMainLocale({ systemLanguages: () => ['en-US'] })
    const sync = makeSync()
    sync.report('zh')
    for (const junk of [null, undefined, 'fr', 'zh-CN', '', 1, {}, ['zh']]) sync.report(junk)
    expect(mainLocale()).toBe('zh')
  })

  it('落盘失败不抛、不影响本次生效;下次报上来重试', async () => {
    initMainLocale({ systemLanguages: () => ['en-US'] })
    const logs: string[] = []
    let fail = true
    const sync = makeSync({
      writeFile: async (f, d) => { if (fail) throw new Error('EACCES'); writes.push(d); disk.set(f, JSON.stringify(d)) },
      log: (m) => logs.push(m),
    })
    sync.report('zh')
    await sync.flush()
    expect(mainLocale()).toBe('zh')
    expect(logs.join('\n')).toMatch(/EACCES/)
    fail = false
    sync.report('zh')
    await sync.flush()
    expect(writes).toEqual([{ v: 1, locale: 'zh' }])
  })
})

describe('主进程只有一个语言源(P1-KF 静态闸)', () => {
  // 先去行注释(注释里常有 `/vault/*` 这类路径,先去块注释会从那儿一路吃到下一个 `*/`),再去块注释
  const src = (f: string): string => readFileSync(join(__dirname, f), 'utf8').replace(/(^|\s)\/\/[^\n]*/g, '$1').replace(/\/\*[\s\S]*?\*\//g, '')

  it('main.ts 不再从 localStorage 手选键 / ui:sync 的 prefs 喂主进程语言(null 会把已对上的语言重置回系统)', () => {
    const main = src('main.ts')
    expect(main).not.toMatch(/setMainLocale\(/)
    expect(main).not.toMatch(/UI_LOCALE_PREF_KEY/)
    expect(main).toMatch(/ipcMain\.on\(UI_LOCALE_CHANNEL,[\s\S]{0,120}isTrustedSender\(e\)[\s\S]{0,60}uiLocale\.report\(v\)/)
    expect(main).toMatch(/initMainLocale\(\{ systemLanguages: \(\) => app\.getPreferredSystemLanguages\(\) \}\)\s*\n\s*uiLocale\.seed\(\)/) // 托盘 / 窗口之前
    expect(main).toMatch(/createApprovalDelivery\(\{[\s\S]*?\n\s*t: mt,/) // 远程审批通知的文案函数就是 mt
  })

  it('electron/ 下除了 main.ts 的注入点与 tray 的旧回落,没有别的模块自己判系统语言(文案一律经 mt / mainLocale)', () => {
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const ent of readdirSync(join(__dirname, dir), { withFileTypes: true })) {
        const rel = dir ? `${dir}/${ent.name}` : ent.name
        if (ent.isDirectory()) { walk(rel); continue }
        if (!/\.ts$/.test(ent.name) || /\.test\.ts$|\.testutil\.ts$/.test(ent.name)) continue
        const code = src(rel)
        const hits = code.match(/getPreferredSystemLanguages\(|app\.getLocale\(|getSystemLocale\(|getLocaleCountryCode\(/g) || []
        const allowed = rel === 'main.ts' || rel === 'tray.ts' ? 1 : 0
        if (hits.length > allowed) offenders.push(`${rel} × ${hits.length}`)
      }
    }
    walk('')
    expect(offenders).toEqual([])
  })
})
