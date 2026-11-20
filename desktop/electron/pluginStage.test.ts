import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyTreePlain, findInstalledPlugin, resolveFixture, stageGrants, createPluginStage } from './pluginStage'
import { isSandboxRoot, sandboxPaths } from './pluginSandbox'
import { parseStageInfo, sanitizeStageOptions, sanitizeStageRecord, sanitizeStageRect, stageThemeStorage, isStageFixturePath } from '../shared/pluginStage'

const tmp = () => mkdtempSync(join(tmpdir(), 'stage-'))
function install(home: string, folder: string, manifest: Record<string, unknown>): string {
  const d = join(home, 'plugins', folder)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'manifest.json'), JSON.stringify(manifest))
  writeFileSync(join(d, 'main.js'), 'return () => {}')
  return d
}

describe('sanitizeStageOptions', () => {
  const zh = { locale: 'zh' as const }
  it('缺省:空库、亮色、1440×900 @2、跟界面语言、不带引擎、调用方不进舞台', () => {
    const r = sanitizeStageOptions(undefined, zh)
    expect(r).toEqual({ ok: true, options: { plugins: [], includeSelf: false, theme: { mode: 'light' }, locale: 'zh', window: { width: 1440, height: 900, scale: 2 }, engine: 'none' } })
  })
  it('数组写法的 window、字符串写法的 theme、去重的 plugins', () => {
    const r = sanitizeStageOptions({ window: [1280, 800], theme: 'dark', plugins: ['calendar', 'calendar', 'market-0b1c2d3e-0000-4000-8000-1234567890ab'] }, zh)
    expect(r.ok && r.options.window).toEqual({ width: 1280, height: 800, scale: 2 })
    expect(r.ok && r.options.theme).toEqual({ mode: 'dark' })
    expect(r.ok && r.options.plugins).toEqual(['calendar', 'market-0b1c2d3e-0000-4000-8000-1234567890ab'])
  })
  it('拒:越界的尺寸 / 密度、坏 id、坏时钟、坏 fixture、scripted 没 fixture', () => {
    for (const bad of [
      { window: [100, 800] }, { window: [1280, 800, 5] }, { window: { width: 'x', height: 800 } },
      { plugins: ['Bad Id'] }, { plugins: 'calendar' }, { clock: '2026/11/20' }, { clock: '2026-11-20' },
      { fixture: '../up' }, { fixture: '/abs' }, { fixture: 'a/.git/b' }, { fixture: 'C:\\x' },
      { engine: 'scripted' }, { engine: 'real' }, { theme: { mode: 'sepia' } }, { theme: { mode: 'light', skin: 'Coral!' } },
      { locale: 'fr' }, { includeSelf: 'yes' },
    ]) expect(sanitizeStageOptions(bad, zh).ok, JSON.stringify(bad)).toBe(false)
  })
  it('fixture 统一成正斜杠;时钟收本地时间', () => {
    const r = sanitizeStageOptions({ fixture: 'fixtures\\demo', clock: '2026-11-20T10:00', engine: 'scripted' }, zh)
    expect(r.ok && r.options.fixture).toBe('fixtures/demo')
    expect(r.ok && r.options.clock).toBe('2026-11-20T10:00')
  })
  it('isStageFixturePath', () => {
    expect(isStageFixturePath('fixtures/demo')).toBe(true)
    expect(isStageFixturePath('fixtures/../demo')).toBe(false)
    expect(isStageFixturePath('')).toBe(false)
  })
})

describe('主题 / 截图区域 / 录像参数', () => {
  it('stageThemeStorage:明暗 + 玻璃一律关', () => {
    expect(stageThemeStorage({ mode: 'dark', skin: 'coral' })).toEqual({ forsion_theme_pref: 'dark', forsion_theme: 'dark', forsion_glass: 'off', forsion_theme_skin: 'coral' })
  })
  it('sanitizeStageRect', () => {
    expect(sanitizeStageRect({ x: 1.4, y: 2, width: 10, height: 10 })).toEqual({ x: 1, y: 2, width: 10, height: 10 })
    expect(sanitizeStageRect({ x: -1, y: 0, width: 10, height: 10 })).toBeNull()
    expect(sanitizeStageRect({ x: 0, y: 0, width: 0, height: 10 })).toBeNull()
  })
  it('sanitizeStageRecord:夹到上下限,cursor 缺省开', () => {
    expect(sanitizeStageRecord({})).toEqual({ fps: 30, cursor: true, maxMs: 120_000 })
    expect(sanitizeStageRecord({ fps: 500, maxMs: 10, cursor: false })).toEqual({ fps: 60, cursor: false, maxMs: 1000 })
  })
})

describe('舞台目录与子进程参数', () => {
  it('舞台在 stages/,和开发沙箱分开;stages/ 的守卫不认 sandbox/', () => {
    const p = sandboxPaths('/h', 'demo', 'stages')
    expect(p.root).toBe(join('/h', 'stages', 'demo'))
    expect(isSandboxRoot('/h', p.root, 'stages')).toBe(true)
    expect(isSandboxRoot('/h', p.root)).toBe(false)
    expect(isSandboxRoot('/h', join('/h', 'sandbox', 'demo'), 'stages')).toBe(false)
  })
  it('stages 本身是软链(比如链到 plugins)→ 守卫不认,不清空', async () => {
    const { insideSandbox } = await import('./pluginSandbox')
    const home = tmp()
    mkdirSync(join(home, 'plugins', 'demo'), { recursive: true })
    symlinkSync(join(home, 'plugins'), join(home, 'stages'))
    expect(await insideSandbox(home, sandboxPaths(home, 'demo', 'stages'), [], 'stages')).toBe(false)
    const home2 = tmp()
    mkdirSync(join(home2, 'stages', 'demo'), { recursive: true })
    expect(await insideSandbox(home2, sandboxPaths(home2, 'demo', 'stages'), [], 'stages')).toBe(true)
  })
  it('parseStageInfo:形状不对就不是舞台', () => {
    expect(parseStageInfo({ plugins: ['calendar', 'BAD'], window: { width: 1280, height: 800, scale: 2 }, clock: '2026-11-20T10:00', engine: 'scripted' }))
      .toEqual({ plugins: ['calendar'], window: { width: 1280, height: 800, scale: 2 }, clock: '2026-11-20T10:00', engine: 'scripted' })
    expect(parseStageInfo({ plugins: [], window: { width: 'x' } })).toBeUndefined()
    expect(parseStageInfo(null)).toBeUndefined()
  })
})

describe('findInstalledPlugin / resolveFixture / copyTreePlain', () => {
  it('按 id 找已安装的插件;商店装的按 market-<uuid>', async () => {
    const home = tmp()
    install(home, 'calendar', { id: 'calendar', name: 'Calendar', version: '0.2.0' })
    install(home, 'market-0b1c2d3e-0000-4000-8000-1234567890ab', { id: 'reading-log', name: 'Reading log', version: '1.0.0' })
    expect((await findInstalledPlugin(home, 'calendar'))?.folder).toBe('calendar')
    // 商店装的插件身份就是 market-<uuid>(manifest id 可能和别家撞):只认目录名
    expect(await findInstalledPlugin(home, 'reading-log')).toBeNull()
    const m = await findInstalledPlugin(home, 'market-0b1c2d3e-0000-4000-8000-1234567890ab')
    expect(m?.id).toBe('market-0b1c2d3e-0000-4000-8000-1234567890ab')
    expect(m?.name).toBe('Reading log')
    expect(await findInstalledPlugin(home, 'nope')).toBeNull()
    expect(await findInstalledPlugin(home, '../x')).toBeNull()
  })
  it('fixture 必须在插件包里面:软链指出去的不认', async () => {
    const home = tmp()
    const dir = install(home, 'director', { id: 'director' })
    mkdirSync(join(dir, 'fixtures', 'demo', 'vault'), { recursive: true })
    const outside = tmp()
    symlinkSync(outside, join(dir, 'fixtures', 'escape'))
    await expect(resolveFixture(dir, 'fixtures/demo')).resolves.toContain(join('fixtures', 'demo'))
    await expect(resolveFixture(dir, 'fixtures/escape')).rejects.toMatchObject({ code: 'fixture-invalid' })
    await expect(resolveFixture(dir, 'fixtures/missing')).rejects.toMatchObject({ code: 'fixture-invalid' })
  })
  it('演示库只拷普通文件:软链、.git 跳过,超量报 fixture-invalid', async () => {
    const src = tmp(), dest = join(tmp(), 'vault')
    mkdirSync(join(src, 'Projects'), { recursive: true })
    writeFileSync(join(src, 'Welcome.md'), '# hi')
    writeFileSync(join(src, 'Projects', 'Plan.md'), '# plan')
    mkdirSync(join(src, '.git'))
    writeFileSync(join(src, '.git', 'HEAD'), 'x')
    const secret = join(tmp(), 'secret.md')
    writeFileSync(secret, 'SECRET')
    symlinkSync(secret, join(src, 'link.md'))
    const r = await copyTreePlain(src, dest)
    expect(r.files).toBe(2)
    expect(existsSync(join(dest, 'Projects', 'Plan.md'))).toBe(true)
    expect(existsSync(join(dest, 'link.md'))).toBe(false)
    expect(existsSync(join(dest, '.git'))).toBe(false)
    await expect(copyTreePlain(src, join(tmp(), 'v2'), { files: 1, bytes: 1e9 })).rejects.toMatchObject({ code: 'fixture-invalid' })
  })
})

describe('stageGrants', () => {
  it('记住允许过的插件;文件读坏了 = 不知道:照样问,也不写回', async () => {
    const home = tmp()
    const g = stageGrants(home)
    expect(await g.has('director')).toBe(false)
    await g.add('director')
    expect(await g.has('director')).toBe(true)
    const f = join(home, 'stages', '.grants.json')
    writeFileSync(f, '{broken')
    expect(await g.has('director')).toBe(false)
    await g.add('other')
    expect(readFileSync(f, 'utf8')).toBe('{broken')
  })
  it('id 叫 constructor / __proto__ 的插件不会摸到原型上的同名属性', async () => {
    const g = stageGrants(tmp())
    expect(await g.has('constructor')).toBe(false)
    expect(await g.has('tostring')).toBe(false)
  })
})

describe('createPluginStage', () => {
  /** 假的沙箱实例:只记调用,openStage 回一份 running 的状态。 */
  function fakeSandbox() {
    const calls: string[] = []
    let running = false
    return {
      calls,
      sandbox: {
        state: () => ({ running }),
        stop: async () => { calls.push('stop'); running = false },
        openStage: async (owner: { pluginId: string }, spec: { prepare(p: unknown): Promise<void>; info: Record<string, unknown> }) => {
          calls.push(`open:${owner.pluginId}:${JSON.stringify(spec.info.plugins)}`)
          running = true
          return { ok: true, text: JSON.stringify({ state: 'running' }) }
        },
        exec: async () => ({ ok: true, text: JSON.stringify({ state: 'running', action: { did: 'clicked', target: 'Add' } }) }),
        raw: async () => ({}),
      },
    }
  }
  it('第一次问、不允许 → denied 不起;允许 → 记住;别的插件 → busy;点名没装 → plugin-missing', async () => {
    const home = tmp()
    install(home, 'director', { id: 'director', name: 'Director', capabilities: ['stage'] })
    install(home, 'rival', { id: 'rival', name: 'Rival', capabilities: ['stage'] })
    install(home, 'calendar', { id: 'calendar', name: 'Calendar' })
    const f = fakeSandbox()
    let answer = false
    let asked = 0
    const stage = createPluginStage({
      forsionHome: () => home,
      sandbox: f.sandbox as never,
      confirm: async () => { asked += 1; return answer },
      startEngine: async () => ({ url: 'http://127.0.0.1:9', close: async () => {} }),
      log: () => {},
    })
    expect(await stage.exec('director', 'open', { plugins: ['calendar'] }, 'zh')).toMatchObject({ ok: false, code: 'denied' })
    expect(f.calls).toEqual([])
    answer = true
    expect(await stage.exec('director', 'open', { plugins: ['calendar'] }, 'zh')).toMatchObject({ ok: true, plugins: ['calendar'] })
    expect(f.calls).toEqual(['open:director:["calendar"]'])
    expect(await stage.exec('director', 'click', { target: 'Add' }, 'zh')).toEqual({ ok: true, did: 'clicked', target: 'Add' })
    expect(await stage.exec('rival', 'open', {}, 'zh')).toMatchObject({ ok: false, code: 'busy' })
    expect(await stage.exec('rival', 'click', { target: 'Add' }, 'zh')).toMatchObject({ ok: false, code: 'closed' })
    expect(asked).toBe(2)
    // 自己再开:不再问,先停前一份
    expect(await stage.exec('director', 'open', { plugins: ['nope'] }, 'zh')).toMatchObject({ ok: false, code: 'plugin-missing' })
    expect(asked).toBe(2)
    expect(await stage.exec('director', 'close', {}, 'zh')).toEqual({ ok: true })
    expect(await stage.exec('director', 'click', { target: 'Add' }, 'zh')).toMatchObject({ ok: false, code: 'closed' })
  })
  it('没声明 stage 的插件绕开 ctx 直接调通道 → unsupported', async () => {
    const home = tmp()
    install(home, 'plain', { id: 'plain', name: 'Plain' })
    const f = fakeSandbox()
    const stage = createPluginStage({ forsionHome: () => home, sandbox: f.sandbox as never, confirm: async () => true, startEngine: async () => ({ url: '', close: async () => {} }), log: () => {} })
    expect(await stage.exec('plain', 'open', {}, 'en')).toMatchObject({ ok: false, code: 'unsupported' })
    expect(f.calls).toEqual([])
  })
  it('重开之后旧代号的句柄和清理不作数', async () => {
    const home = tmp()
    install(home, 'director', { id: 'director', name: 'Director', capabilities: ['stage'] })
    const f = fakeSandbox()
    const stage = createPluginStage({ forsionHome: () => home, sandbox: f.sandbox as never, confirm: async () => true, startEngine: async () => ({ url: '', close: async () => {} }), log: () => {} })
    const a = await stage.exec('director', 'open', {}, 'en') as unknown as { gen: number }
    const b = await stage.exec('director', 'open', {}, 'en') as unknown as { gen: number }
    expect(b.gen).toBe(a.gen + 1)
    expect(await stage.exec('director', 'click', { target: 'x', __gen: a.gen }, 'en')).toMatchObject({ ok: false, code: 'closed' })
    expect(await stage.exec('director', 'close', { __gen: a.gen }, 'en')).toEqual({ ok: true })
    expect(await stage.exec('director', 'click', { target: 'x', __gen: b.gen }, 'en')).toMatchObject({ ok: true })
  })
  it('没安装的插件(开发副本)不能起舞台', async () => {
    const f = fakeSandbox()
    const stage = createPluginStage({ forsionHome: () => tmp(), sandbox: f.sandbox as never, confirm: async () => true, startEngine: async () => ({ url: '', close: async () => {} }), log: () => {} })
    expect(await stage.exec('ghost', 'open', {}, 'en')).toMatchObject({ ok: false, code: 'unsupported' })
  })
})
