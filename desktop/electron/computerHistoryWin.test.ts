import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  cleanupRecorderCopies, createWindowsRecorderResolver, probeRecorderProtocol, recorderBinDir, recorderPipeName, stageRecorderExe, windowsRecorderSource,
} from './computerHistoryWin'

const cleanups: Array<() => void> = []
afterEach(() => { for (const fn of cleanups.splice(0)) fn() })
function tmp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'chwin-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

describe('computerHistoryWin', () => {
  it('管道名:用户名哈希前 8 位 + 内容哈希前 12 位;换用户 / 换 exe 都换管道', () => {
    const name = recorderPipeName('alice', '0123456789ab')
    expect(name).toBe(`\\\\.\\pipe\\tangu-computer-use-recorder-${sha('alice').slice(0, 8)}-0123456789ab`)
    expect(name).not.toContain('alice')
    expect(recorderPipeName('bob', '0123456789ab')).not.toBe(name)
    expect(recorderPipeName('alice', 'ba9876543210')).not.toBe(name)
  })

  it('私有副本:按拷出来的字节的哈希命名、已在不动;清掉别的哈希的旧副本与残留临时文件,刚建的不碰,不碰别的文件', async () => {
    const dir = tmp()
    const src = path.join(dir, 'windows-bridge.exe')
    writeFileSync(src, 'v2')
    const bin = path.join(dir, 'bin')
    mkdirSync(bin)
    for (const f of ['windows-bridge-aaaaaaaaaaaa.exe', '.windows-bridge-1-x.tmp', 'keep.txt']) writeFileSync(path.join(bin, f), 'old')
    const h12 = sha('v2').slice(0, 12)
    const { exe, h12: got } = await stageRecorderExe(src, bin)
    expect(got).toBe(h12)
    expect(exe).toBe(path.join(bin, `windows-bridge-${h12}.exe`))
    expect(readFileSync(exe, 'utf8')).toBe('v2')
    await cleanupRecorderCopies(bin, exe) // 都是刚建的(可能是另一个 Forsion 正要拉起的):不动
    expect(readdirSync(bin)).toHaveLength(4)
    await cleanupRecorderCopies(bin, exe, 0)
    expect(readdirSync(bin).sort()).toEqual(['keep.txt', `windows-bridge-${h12}.exe`])
    // 已在 = 不动,也不留临时文件
    expect((await stageRecorderExe(src, bin)).exe).toBe(exe)
    expect(readdirSync(bin).sort()).toEqual(['keep.txt', `windows-bridge-${h12}.exe`])
  })

  it('解析器:哈希按文件缓存、协议每个哈希只探一次;探测一时失败不缓存;源换了内容 → 新副本 + 新管道 + 再探', async () => {
    const dir = tmp()
    const src = path.join(dir, 'src', 'windows-bridge.exe')
    mkdirSync(path.dirname(src))
    writeFileSync(src, 'v1')
    const bin = path.join(dir, 'bin')
    let failNext = true
    const probe = vi.fn(async (_exe: string) => {
      if (failNext) { failNext = false; throw Object.assign(new Error('spawn EBUSY'), { code: 'EBUSY' }) }
      return 13
    })
    let source: string | null = null
    const resolve = createWindowsRecorderResolver({ binDir: bin, source: async () => source, username: () => 'alice', probe, staleMs: 0 })
    expect(await resolve()).toBeNull() // 没有源 = helper_missing
    source = src
    await expect(resolve()).rejects.toThrow('EBUSY') // 一时失败:不缓存
    const h1 = sha('v1').slice(0, 12)
    const first = await resolve()
    expect(first).toEqual({ exe: path.join(bin, `windows-bridge-${h1}.exe`), pipe: recorderPipeName('alice', h1), protocol: 13 })
    expect(probe).toHaveBeenLastCalledWith(first!.exe) // 探的是私有副本,不是源
    await resolve()
    expect(probe).toHaveBeenCalledTimes(2)
    writeFileSync(src, 'v2-longer') // 大小变了 → 重新算哈希
    const h2 = sha('v2-longer').slice(0, 12)
    const second = await resolve()
    expect(second?.exe).toBe(path.join(bin, `windows-bridge-${h2}.exe`))
    expect(second?.pipe).toBe(recorderPipeName('alice', h2))
    expect(probe).toHaveBeenCalledTimes(3)
    expect(existsSync(first!.exe)).toBe(false) // 旧副本(没在跑)清掉了
  })

  it('源:PI_COMPUTER_USE_WINDOWS_HELPER_PATH 非空即用它(文件不在 = null);不然从 CU 包的 prebuilt/windows 找', async () => {
    const dir = tmp()
    const dev = path.join(dir, 'dev-bridge.exe')
    writeFileSync(dev, '')
    const base = { isPackaged: true, appPath: dir, resourcesPath: path.join(dir, 'resources'), pluginsRoot: path.join(dir, 'plugins') }
    expect(await windowsRecorderSource({ ...base, env: { PI_COMPUTER_USE_WINDOWS_HELPER_PATH: ` ${dev} ` } })).toBe(dev)
    expect(await windowsRecorderSource({ ...base, env: { PI_COMPUTER_USE_WINDOWS_HELPER_PATH: path.join(dir, 'missing.exe') } })).toBeNull()
    expect(await windowsRecorderSource({ ...base, env: {} })).toBeNull()
    if (process.platform !== 'darwin' && process.platform !== 'win32') return // CU 包只在 darwin / win32 列入内置清单
    const bundled = path.join(dir, 'resources', 'bundled-plugins', 'tangu-computer-use', 'prebuilt', 'windows', 'windows-bridge.exe')
    mkdirSync(path.dirname(bundled), { recursive: true })
    writeFileSync(bundled, '')
    expect(await windowsRecorderSource({ ...base, env: {} })).toBe(bundled)
  })

  // 用 sh 脚本冒充 exe:只在 POSIX 上跑(Windows CI 上 spawn 不了 shebang 脚本)
  it.skipIf(process.platform === 'win32')('协议探测:打印版本 → 数字;老 helper(不认子命令、读 stdin 到 EOF 就退)→ null 且不挂到超时;挂住 → 超时 reject', async () => {
    const dir = tmp()
    const script = (name: string, body: string): string => {
      const f = path.join(dir, name)
      writeFileSync(f, `#!/bin/sh\n${body}\n`)
      chmodSync(f, 0o755)
      return f
    }
    expect(await probeRecorderProtocol(script('new', '[ "$1" = recorder-protocol ] && echo 13'))).toBe(13)
    const started = Date.now()
    expect(await probeRecorderProtocol(script('old', 'cat > /dev/null'))).toBeNull()
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(await probeRecorderProtocol(script('noise', 'echo "usage: bridge"'))).toBeNull()
    // 崩了 / 非零退出不是「老 helper」的结论:reject,不进缓存
    await expect(probeRecorderProtocol(script('crash', 'exit 3'))).rejects.toMatchObject({ code: 'helper_probe_failed' })
    await expect(probeRecorderProtocol(script('hang', 'sleep 5'), 200)).rejects.toMatchObject({ code: 'helper_probe_timeout' })
    await expect(probeRecorderProtocol(path.join(dir, 'nope'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('recorderBinDir', () => {
  it('lives under LOCALAPPDATA, never inside the computer-history root', () => {
    expect(recorderBinDir({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'C:\\Users\\u')).toBe(path.join('C:\\Users\\u\\AppData\\Local', 'tangu-computer-use', 'recorder'))
    expect(recorderBinDir({}, '/home/u')).toBe(path.join('/home/u', 'AppData', 'Local', 'tangu-computer-use', 'recorder'))
  })
})
