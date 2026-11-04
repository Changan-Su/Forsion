import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createCoreTangu } from './coreTangu'

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

/** 引擎包目录:package.json + 可选的界面半身(ui/main.js + manifest.json + SIGNATURE 里的哈希)。 */
function pkgDir(root: string, name: string, version: string, ui?: { code: string; forDesktop?: string; signed?: string }): string {
  const dir = join(root, name)
  mkdirSync(join(dir, 'ui'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }))
  if (ui) {
    writeFileSync(join(dir, 'ui', 'main.js'), ui.code)
    if (ui.forDesktop !== undefined) writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ id: 'tangu', main: 'ui/main.js', forDesktop: ui.forDesktop }))
    writeFileSync(join(dir, 'SIGNATURE'), JSON.stringify({ files: { 'ui/main.js': ui.signed ?? sha(ui.code) } }))
  }
  return dir
}

function setup(o: { overlay?: { forDesktop?: string; signed?: string } | 'engine-only'; bundledUi?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'core-tangu-'))
  const bundledRoot = pkgDir(root, 'bundled', '2.13.14', o.bundledUi === false ? undefined : { code: 'BUNDLED' })
  const dirs: Record<string, string> = {}
  if (o.overlay === 'engine-only') dirs['2.13.15'] = pkgDir(root, '2.13.15', '2.13.15')
  else if (o.overlay) dirs['2.13.15'] = pkgDir(root, '2.13.15', '2.13.15', { code: 'OVERLAY', forDesktop: '2.13.8', ...o.overlay })
  const state = { selected: o.overlay ? '2.13.15' : (null as string | null), running: undefined as string | null | undefined }
  const demote = vi.fn()
  const core = createCoreTangu({
    bundledRoot,
    desktopVersion: '2.13.8',
    overlay: async (version) => {
      const v = version ?? state.selected
      return v && dirs[v] ? { version: v, dir: dirs[v] } : null
    },
    runningOverlay: () => state.running,
    demote,
  })
  return { core, state, demote, dirs, root }
}

describe('coreTangu.load', () => {
  it('no engine update → the bundled UI', async () => {
    expect(await setup().core.load()).toMatchObject({ source: 'bundled', version: '2.13.14', code: 'BUNDLED' })
  })
  it('an engine update with a UI half built for this desktop → its UI', async () => {
    expect(await setup({ overlay: {} }).core.load()).toMatchObject({ source: 'overlay', version: '2.13.15', code: 'OVERLAY' })
  })
  it('built for another desktop (forDesktop is an exact match) → the bundled UI', async () => {
    expect((await setup({ overlay: { forDesktop: '2.13.7' } }).core.load())?.source).toBe('bundled')
    expect((await setup({ overlay: { forDesktop: '2.13.8+build.1' } }).core.load())?.source).toBe('bundled')
  })
  it('ui/main.js whose bytes do not match the signed hash → the bundled UI', async () => {
    expect((await setup({ overlay: { signed: sha('something else') } }).core.load())?.source).toBe('bundled')
  })
  it('an engine-only update (no manifest.json, like 2.13.12) → the bundled UI', async () => {
    expect((await setup({ overlay: 'engine-only' }).core.load())?.source).toBe('bundled')
  })
  it('no UI anywhere (dev without a bundle, products without the engine) → null = the built-in one', async () => {
    expect(await setup({ bundledUi: false }).core.load()).toBeNull()
  })
})

describe('coreTangu follows the engine', () => {
  it('before the engine is ready the prediction is pinned: an update staged later does not reach new windows', async () => {
    const t = setup({ overlay: {} })
    t.state.selected = null
    expect((await t.core.load())?.source).toBe('bundled')
    t.state.selected = '2.13.15' // 更新器中途落位了新版
    expect((await t.core.load())?.source).toBe('bundled')
  })
  it('once the engine is ready the UI is the version it runs', async () => {
    const t = setup({ overlay: {} })
    t.state.running = '2.13.15'
    expect((await t.core.load())?.source).toBe('overlay')
    t.state.running = null
    expect((await t.core.load())?.source).toBe('bundled')
  })
  it('engineSettled: reload only when the UI is an update the engine is not running', async () => {
    const t = setup({ overlay: {} })
    await t.core.load() // 预测 2.13.15,给了热更新版
    t.state.running = '2.13.15'
    expect(t.core.engineSettled()).toBe(false)
    t.state.running = null // 引擎退回了自带的
    expect(t.core.engineSettled()).toBe(true)
    expect(t.core.engineSettled()).toBe(false) // 一次就够
    expect((await t.core.load())?.source).toBe('bundled')
    expect(t.core.engineSettled()).toBe(false) // 界面自带、引擎热更新:不重载
  })
})

describe('coreTangu.markBad', () => {
  it('disables the whole version and serves the bundled UI next, even while the engine still runs it', async () => {
    const t = setup({ overlay: {} })
    expect((await t.core.load())?.source).toBe('overlay')
    t.core.markBad('2.13.15', 'activateTangu threw')
    expect(t.demote).toHaveBeenCalledWith('2.13.15', 'UI: activateTangu threw')
    t.state.running = '2.13.15' // 引擎这次运行里还在跑它(下次拉起才退)
    expect((await t.core.load())?.source).toBe('bundled')
  })
  it('a demote that cannot be written still stops the reload loop', async () => {
    const t = setup({ overlay: {} })
    t.demote.mockImplementation(() => { throw new Error('EROFS') })
    t.core.markBad('2.13.15', 'boom')
    expect((await t.core.load())?.source).toBe('bundled')
  })
  it('ignores junk from the renderer', () => {
    const t = setup()
    t.core.markBad(undefined, 'x')
    t.core.markBad({}, 'x')
    expect(t.demote).not.toHaveBeenCalled()
  })
})
