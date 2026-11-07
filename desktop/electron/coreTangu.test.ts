import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { canonicalFiles, verifySignedBytes } from '../../tangu-agent/src/boot/overlay'
import { createCoreTangu } from './coreTangu'

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const pub = publicKey.export({ type: 'spki', format: 'pem' }) as string
const W = 1 // 主窗口的 webContents id
const W2 = 2

/** 签名表 = files 里每个文件的 sha256,用 key 签(缺省测试钥匙)。 */
function signature(files: Record<string, string>, key = privateKey): string {
  const hashes = Object.fromEntries(Object.entries(files).map(([rel, data]) => [rel, sha(data)]))
  return JSON.stringify({ alg: 'ed25519', files: hashes, sig: sign(null, Buffer.from(canonicalFiles(hashes), 'utf8'), key).toString('base64') })
}

/** 引擎包目录:package.json + 可选的界面半身(ui/main.js + manifest.json + SIGNATURE)。 */
function pkgDir(root: string, name: string, version: string, ui?: { code: string; forDesktop?: string; forge?: boolean }): string {
  const dir = join(root, name)
  mkdirSync(join(dir, 'ui'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }))
  if (ui) {
    const files: Record<string, string> = { 'ui/main.js': ui.code }
    if (ui.forDesktop !== undefined) files['manifest.json'] = JSON.stringify({ id: 'tangu', main: 'ui/main.js', forDesktop: ui.forDesktop })
    for (const [rel, data] of Object.entries(files)) writeFileSync(join(dir, rel), data)
    // forge:字节连同 SIGNATURE 一起被换掉 —— 自洽的哈希,但不是钉死的那把钥匙签的
    writeFileSync(join(dir, 'SIGNATURE'), signature(files, ui.forge ? generateKeyPairSync('ed25519').privateKey : privateKey))
  }
  return dir
}

function setup(o: { overlay?: { forDesktop?: string; forge?: boolean; code?: string } | 'engine-only'; bundledUi?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'core-tangu-'))
  const bundledRoot = pkgDir(root, 'bundled', '2.13.14', o.bundledUi === false ? undefined : { code: 'BUNDLED' })
  const dirs: Record<string, string> = {}
  if (o.overlay === 'engine-only') dirs['2.13.15'] = pkgDir(root, '2.13.15', '2.13.15')
  else if (o.overlay) dirs['2.13.15'] = pkgDir(root, '2.13.15', '2.13.15', { code: 'OVERLAY', forDesktop: '2.13.8', ...o.overlay })
  const state = { selected: o.overlay ? '2.13.15' : (null as string | null), running: undefined as string | null | undefined }
  const demote = vi.fn()
  const deps = {
    bundledRoot,
    desktopVersion: '2.13.8',
    overlay: async (version?: string) => {
      const v = version ?? state.selected
      return v && dirs[v] ? { version: v, dir: dirs[v] } : null
    },
    runningOverlay: () => state.running,
    verify: (sig: string, files: Record<string, Uint8Array>) => verifySignedBytes(sig, files, pub),
    demote,
  }
  return { core: createCoreTangu(deps), deps, state, demote, dirs, root }
}

describe('coreTangu.load', () => {
  it('no engine update → the bundled UI', async () => {
    expect(await setup().core.load(W)).toMatchObject({ source: 'bundled', version: '2.13.14', code: 'BUNDLED' })
  })
  it('an engine update with a UI half built for this desktop → its UI', async () => {
    expect(await setup({ overlay: {} }).core.load(W)).toMatchObject({ source: 'overlay', version: '2.13.15', code: 'OVERLAY' })
  })
  it('built for another desktop (forDesktop is an exact match) → the bundled UI', async () => {
    expect((await setup({ overlay: { forDesktop: '2.13.7' } }).core.load(W))?.source).toBe('bundled')
    expect((await setup({ overlay: { forDesktop: '2.13.8+build.1' } }).core.load(W))?.source).toBe('bundled')
  })
  it('ui/main.js and SIGNATURE swapped together after checkOverlay (self-consistent, wrong key) → the bundled UI', async () => {
    expect((await setup({ overlay: { forge: true, code: 'EVIL' } }).core.load(W))?.source).toBe('bundled')
  })
  it('ui/main.js changed alone → the bundled UI', async () => {
    const t = setup({ overlay: {} })
    writeFileSync(join(t.dirs['2.13.15'], 'ui', 'main.js'), 'EVIL')
    expect((await t.core.load(W))?.source).toBe('bundled')
  })
  it('an engine-only update (no manifest.json, like 2.13.12) → the bundled UI', async () => {
    expect((await setup({ overlay: 'engine-only' }).core.load(W))?.source).toBe('bundled')
  })
  it('no UI anywhere (dev without a bundle, products without the engine) → null = the built-in one', async () => {
    expect(await setup({ bundledUi: false }).core.load(W)).toBeNull()
  })
})

describe('coreTangu follows the engine', () => {
  it('before the engine is ready the prediction is pinned: an update staged later does not reach new windows', async () => {
    const t = setup({ overlay: {} })
    t.state.selected = null
    expect((await t.core.load(W))?.source).toBe('bundled')
    t.state.selected = '2.13.15' // 更新器中途落位了新版
    expect((await t.core.load(W2))?.source).toBe('bundled')
  })
  it('once the engine is ready the UI is the version it runs', async () => {
    const t = setup({ overlay: {} })
    t.state.running = '2.13.15'
    expect((await t.core.load(W))?.source).toBe('overlay')
    t.state.running = null
    expect((await t.core.load(W))?.source).toBe('bundled')
  })
  it('engine becomes ready on another version while the files are being read → follows the running one', async () => {
    const t = setup({ overlay: {} })
    const overlay = t.deps.overlay
    t.deps.overlay = async (v) => { const r = await overlay(v); t.state.running ??= null; return r } // 读的时候引擎就绪、跑的是自带的
    expect((await t.core.load(W))?.source).toBe('bundled')
    expect(t.core.engineReady()).toEqual([])
  })
  it('engineReady: reload only windows holding an update the engine is not running', async () => {
    const t = setup({ overlay: {} })
    await t.core.load(W) // 预测 2.13.15,给了热更新版
    t.state.running = '2.13.15'
    expect(t.core.engineReady()).toEqual([])
    t.state.running = null // 引擎退回了自带的
    expect(t.core.engineReady()).toEqual([W])
    expect(t.core.engineReady()).toEqual([]) // 一次就够
    expect((await t.core.load(W))?.source).toBe('bundled')
    t.state.running = '2.13.15'
    expect(t.core.engineReady()).toEqual([]) // 界面自带、引擎热更新:不重载
  })
})

describe('coreTangu failures are tied to what the window was given', () => {
  it('a failing update UI disables the whole version; the next load is the bundled UI even while the engine still runs it', async () => {
    const t = setup({ overlay: {} })
    expect((await t.core.load(W))?.source).toBe('overlay')
    expect(t.core.failed(W, 'activateTangu threw')).toBe(true)
    expect(t.demote).toHaveBeenCalledWith('2.13.15', 'UI: activateTangu threw')
    t.state.running = '2.13.15' // 引擎这次运行里还在跑它(下次拉起才退)
    expect((await t.core.load(W))?.source).toBe('bundled')
  })
  it('a demote that cannot be written still stops the reload loop', async () => {
    const t = setup({ overlay: {} })
    t.demote.mockImplementation(() => { throw new Error('EROFS') })
    await t.core.load(W)
    t.core.failed(W, 'boom')
    expect((await t.core.load(W))?.source).toBe('bundled')
  })
  it('a failing bundled UI: that window gets null (built-in copy) from then on, without relying on renderer storage', async () => {
    const t = setup()
    expect((await t.core.load(W))?.source).toBe('bundled')
    expect(t.core.failed(W, 'SyntaxError')).toBe(true)
    expect(await t.core.load(W)).toBeNull()
    expect(t.core.failed(W, 'again')).toBe(false) // 编进宿主的那份不归这里管:不再重载
    expect((await t.core.load(W2))?.source).toBe('bundled') // 别的窗口不受影响
    expect(t.demote).not.toHaveBeenCalled()
  })
  it('reports from a window that was not given an update cannot disable one', async () => {
    const t = setup({ overlay: {} })
    t.state.running = null
    expect((await t.core.load(W))?.source).toBe('bundled')
    t.core.crashed(W, 'x')
    t.core.crashed(W, 'x')
    expect(t.core.failed(W2, 'never loaded')).toBe(false)
    expect(t.demote).not.toHaveBeenCalled()
  })
  it('render crashes add up across reloads; the second one disables the version', async () => {
    const t = setup({ overlay: {} })
    await t.core.load(W)
    expect(t.core.crashed(W, 'TypeError')).toBe(false)
    expect((await t.core.load(W))?.source).toBe('overlay') // 用户点了重载
    expect(t.core.crashed(W, 'TypeError')).toBe(true)
    expect(t.demote).toHaveBeenCalledWith('2.13.15', expect.stringContaining('render crashed 2 times'))
    expect((await t.core.load(W))?.source).toBe('bundled')
  })
})
