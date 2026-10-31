import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const clipboard = vi.hoisted(() => ({ writeText: vi.fn() }))
vi.mock('electron', () => ({ app: {}, clipboard, ipcMain: {} }))
// 故障注入:新副本就位(临时目录改名成正式目录)那一下失败
const inject = vi.hoisted(() => ({ failTmpRename: false }))
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  return { ...real, renameSync: (from: string, to: string) => { if (inject.failTmpRename && from.endsWith('.tmp')) throw new Error('EPERM (injected)'); return real.renameSync(from, to) } }
})
import { browserControlCode, CHROME_EXTENSIONS_URL, ensureClipCopy, openChromeExtensions, syncClipVersion } from './clipExtension'

it.skipIf(process.platform === 'darwin')('Windows/Linux open-extensions fallback returns the copy instruction', async () => {
  clipboard.writeText.mockClear()
  expect(await openChromeExtensions()).toEqual({ ok: false, copied: true, reason: 'unsupported' })
  expect(clipboard.writeText).toHaveBeenCalledExactlyOnceWith(CHROME_EXTENSIONS_URL)
})

const ext = (root: string, version: string): string => {
  const dir = join(root, `src-${version}`)
  mkdirSync(join(dir, 'icon'), { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version }))
  writeFileSync(join(dir, 'icon', '48.png'), version)
  return dir
}
const versionAt = (dir: string): string => JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).version

describe('ensureClipCopy', () => {
  it('没有就复制;已有副本只在要求更新时才换(Chrome 正从这里加载),换完不留临时目录和备份', () => {
    const root = mkdtempSync(join(tmpdir(), 'clip-copy-'))
    const dst = join(root, 'Forsion', 'Forsion Clip')
    expect(ensureClipCopy(ext(root, '2.1.0'), dst)).toEqual({ dir: dst, version: '2.1.0', bundled: '2.1.0' })
    expect(existsSync(join(dst, 'icon', '48.png'))).toBe(true)

    writeFileSync(join(dst, 'marker'), 'x')
    expect(ensureClipCopy(ext(root, '2.2.0'), dst)).toEqual({ dir: dst, version: '2.1.0', bundled: '2.2.0' })
    expect(existsSync(join(dst, 'marker'))).toBe(true)

    expect(ensureClipCopy(ext(root, '2.2.0'), dst, true)).toEqual({ dir: dst, version: '2.2.0', bundled: '2.2.0' })
    expect(existsSync(join(dst, 'marker'))).toBe(false)
    expect(readdirSync(join(root, 'Forsion'))).toEqual(['Forsion Clip'])
  })

  it('新副本就位那一下失败:旧副本放回原处,不丢', () => {
    const root = mkdtempSync(join(tmpdir(), 'clip-copy-'))
    const dst = join(root, 'Forsion Clip')
    ensureClipCopy(ext(root, '2.1.0'), dst)
    inject.failTmpRename = true
    try {
      expect(ensureClipCopy(ext(root, '2.2.0'), dst, true)).toEqual({ error: 'EPERM (injected)' })
    } finally { inject.failTmpRename = false }
    expect(versionAt(dst)).toBe('2.1.0')
    expect(readdirSync(root).filter((n) => n.startsWith('Forsion Clip'))).toEqual(['Forsion Clip'])
  })

  it('上次换到一半(只剩备份)先恢复;随包那份缺了就报错,不碰已有的副本', () => {
    const root = mkdtempSync(join(tmpdir(), 'clip-copy-'))
    const dst = join(root, 'Forsion Clip')
    ensureClipCopy(ext(root, '2.1.0'), dst)
    renameSync(dst, `${dst}.old`)
    expect(ensureClipCopy(ext(root, '2.2.0'), dst)).toEqual({ dir: dst, version: '2.1.0', bundled: '2.2.0' })
    expect(ensureClipCopy(join(root, 'nope'), dst)).toEqual({ error: 'bundled extension not found' })
    expect(versionAt(dst)).toBe('2.1.0')
  })
})

describe('Forsion 更新后同步连着的 Clip(方案 C 第二步)', () => {
  const engine = () => ({ url: 'http://127.0.0.1:1', token: 'T' })
  it('连着的 Clip 比随包旧:先换副本再叫它重载;没有 Clip 连着不碰副本;同一个随包版本只试一次', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clip-sync-'))
    const dst = join(root, 'Forsion Clip')
    ensureClipCopy(ext(root, '2.1.0'), dst)
    const src = ext(root, '2.2.0')
    let clients: Array<{ version: string }> = []
    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method || 'GET'} ${new URL(url).pathname} ${new Headers(init?.headers).get('Authorization')}`)
      return new Response(JSON.stringify(url.endsWith('/agent/browser-extension') ? { listening: true, clients } : { reloaded: clients.length }))
    })
    try {
      expect(await syncClipVersion(engine, src, dst)).toBe('skip')
      expect(versionAt(dst)).toBe('2.1.0')
      clients = [{ version: '2.2.0' }, { version: '2.1.0' }]
      expect(await syncClipVersion(engine, src, dst)).toBe('reloaded')
      expect(versionAt(dst)).toBe('2.2.0')
      expect(calls.at(-1)).toBe('POST /agent/browser-extension/reload-clients Bearer T')
      expect(await syncClipVersion(engine, src, dst)).toBe('skip')
    } finally { vi.unstubAllGlobals() }
  })

  it('引擎没叫到 Clip(超时 / 503)不算试过:下一轮再试', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clip-sync-'))
    const dst = join(root, 'Forsion Clip')
    ensureClipCopy(ext(root, '2.2.0'), dst)
    const src = ext(root, '2.3.0')
    let reloadOk = false
    vi.stubGlobal('fetch', async (url: string) => url.endsWith('/agent/browser-extension')
      ? new Response(JSON.stringify({ listening: true, clients: [{ version: '2.2.0' }] }))
      : reloadOk ? new Response(JSON.stringify({ reloaded: 1 })) : new Response('{}', { status: 503 }))
    try {
      expect(await syncClipVersion(engine, src, dst)).toBe('skip')
      reloadOk = true
      expect(await syncClipVersion(engine, src, dst)).toBe('reloaded')
    } finally { vi.unstubAllGlobals() }
  })

  it('一次配对领的连接码:桥在听才给,引擎没就绪 / 端口被占都不给', async () => {
    let status: Record<string, unknown> = { listening: true, code: 'tangu:47655:ab' }
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(status)))
    try {
      expect(await browserControlCode(engine)).toBe('tangu:47655:ab')
      status = { listening: false, code: 'tangu:47655:ab', error: 'EADDRINUSE' }
      expect(await browserControlCode(engine)).toBeNull()
      expect(await browserControlCode(() => ({ url: null, token: '' }))).toBeNull()
    } finally { vi.unstubAllGlobals() }
  })
})
