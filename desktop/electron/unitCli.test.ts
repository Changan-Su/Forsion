import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'
import { packageDigest } from '../../unit/releases'

const exec = promisify(execFile)
let root: string, scratch: string, main: string, file: string
const children = new Set<ChildProcess>()
const sealed: string[] = []
const env = { ...process.env }
delete env.UNIT_PORT

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'unit-cli-test-'))
  main = join(root, 'dist/main.mjs')
  // Use the release entrypoints and bundle settings, without a renderer build or real database.
  await build({ entryPoints: [resolve('../unit/main.ts'), resolve('../unit/backendWorker.ts')],
    outdir: join(root, 'dist'), outExtension: { '.js': '.mjs' }, bundle: true,
    platform: 'node', target: 'node20', format: 'esm', logLevel: 'silent', tsconfig: resolve('tsconfig.json') })
  await mkdir(join(root, 'dist/web'))
  await writeFile(join(root, 'dist/web/index.html'), '<html><head></head><body>Unit CLI fixture</body></html>')
}, 15_000)
beforeEach(async () => {
  scratch = await mkdtemp(join(root, 'instance-'))
  file = join(scratch, 'state/unit.json')
  await cli('init', join(scratch, 'state'), '--port', '0')
})
afterEach(async () => {
  for (const child of children) await stop(child)
  for (const dir of sealed.splice(0)) await exec('chmod', ['-R', 'u+w', dir])
})
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

async function cli(...args: string[]) {
  return (await exec(process.execPath, [main, ...args], { cwd: scratch || root, env, timeout: 15_000 })).stdout
}
const status = async (config = file) => JSON.parse(await cli('status', config))
async function start(config = file) {
  const child = spawn(process.execPath, [main, 'run', config], { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child)
  let output = ''
  child.stdout!.on('data', (chunk) => { output += chunk })
  child.stderr!.on('data', (chunk) => { output += chunk })
  await expect.poll(async () => {
    if (child.exitCode !== null) throw new Error(`Unit exited before ready: ${output}`)
    return (await status(config)).running
  }, { timeout: 10_000 }).toBe(true)
  return child
}
async function stop(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Unit did not stop')) }, 5_000)
      child.once('exit', () => { clearTimeout(timer); done() })
      child.kill('SIGTERM')
    })
  }
  children.delete(child)
}
async function fixture(id: string, version: string, failStart = false) {
  const dir = join(scratch, `${id}-${version}`)
  await mkdir(dir)
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ id, version, apiVersion: 1,
    backend: { apiVersion: 1, main: 'backend.mjs' } }))
  await writeFile(join(dir, 'service.mjs'), `export const version = ${JSON.stringify(version)};`)
  await writeFile(join(dir, 'backend.mjs'), `
    import { appendFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { threadId } from 'node:worker_threads';
    import { version } from './service.mjs';
    export default (ctx) => ({
      mounts: [${JSON.stringify('/api/' + id)}],
      start() { if (${failStart}) throw new Error('Rejected CLI fixture activation'); },
      migrate() { return appendFile(join(ctx.dataDir, 'migration-ran'), 'ran'); },
      handle(req, res) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ version, pid: process.pid, threadId }));
      }
    });
  `)
  return dir
}
const service = async (port: number, id = 'service') => (await fetch(`http://127.0.0.1:${port}/api/${id}`)).json()
/** The directory a host would mount read-only; afterEach restores it so the scratch tree can be removed. */
async function sealedFixture(id: string, version: string, failStart = false) {
  const dir = await fixture(id, version, failStart)
  sealed.push(dir)
  await exec('chmod', ['-R', 'a-w', dir])
  return dir
}
const configuredPaths = async (config: string) => JSON.parse(await readFile(config, 'utf8')).plugins.map((p: { path: string }) => p.path)

describe('Unit update CLI', () => {
  it('updates a copied package in the same Unit process and persists it across restarts', async () => {
    const old = await fixture('service', '1.0.0'), next = await fixture('service', '2.0.0')
    const unrelated = await fixture('unrelated', '1.0.0')
    await cli('install', file, old)
    await cli('install', file, unrelated)
    const child = await start(), before = await status()
    const firstService = await service(before.port), firstUnrelated = await service(before.port, 'unrelated')
    const updated = JSON.parse(await cli('update', relative(scratch, file), 'service', relative(scratch, next)))
    const after = await status()
    expect(after).toMatchObject({ running: true, pid: before.pid, port: before.port,
      plugins: [{ id: 'service', version: '2.0.0', state: 'active' }, { id: 'unrelated', version: '1.0.0', state: 'active' }] })
    expect(await service(after.port)).toMatchObject({ version: '2.0.0', pid: before.pid })
    expect((await service(after.port)).threadId).not.toBe(firstService.threadId)
    expect(await service(after.port, 'unrelated')).toEqual(firstUnrelated)
    expect(updated).toMatchObject({ id: 'service', version: '2.0.0' })
    expect(updated.path).not.toBe(next)
    expect(JSON.parse(await readFile(file, 'utf8')).plugins[0].path).toBe(updated.path)
    await rm(next, { recursive: true })
    await cli('restart', file, 'service')
    expect(await service(after.port)).toMatchObject({ version: '2.0.0', pid: before.pid })
    await stop(child)
    await start()
    expect(await service((await status()).port)).toMatchObject({ version: '2.0.0' })
  }, 25_000)

  it('rejects a broken release or different plugin identity while keeping the running release and configuration', async () => {
    await cli('install', file, await fixture('service', '1.0.0'))
    const broken = await fixture('service', '2.0.0', true), other = await fixture('other', '1.0.0')
    await start()
    const before = await status(), config = await readFile(file, 'utf8')
    await expect(cli('update', file, 'service', broken)).rejects.toThrow('Rejected CLI fixture activation')
    await expect(cli('update', file, 'service', other)).rejects.toThrow('Update changes plugin identity')
    expect(await status()).toEqual(before)
    expect(await service(before.port)).toMatchObject({ version: '1.0.0', pid: before.pid })
    expect(await readFile(file, 'utf8')).toBe(config)
  }, 20_000)

  it('rejects offline updates and unknown plugin IDs without changing the installation or migrating', async () => {
    await cli('install', file, await fixture('service', '1.0.0'))
    const next = await fixture('service', '2.0.0'), config = await readFile(file, 'utf8')
    await expect(cli('update', file, 'service', next)).rejects.toThrow('Unit is not running; start it before updating')
    expect(await readFile(file, 'utf8')).toBe(config)
    await expect(readFile(join(scratch, 'state/data/plugins/service/migration-ran'))).rejects.toMatchObject({ code: 'ENOENT' })
    await start()
    await expect(cli('update', file, 'unknown', next)).rejects.toThrow('Plugin is not installed: unknown')
    expect(await readFile(file, 'utf8')).toBe(config)
  }, 20_000)

  it('validates required arguments before reading a configuration or starting a Unit', async () => {
    for (const args of [[], [file], [file, 'service'], [file, 'service', 'package', 'extra']]) {
      await expect(cli('update', ...args)).rejects.toThrow('Usage: node main.mjs update <unit.json> <plugin-id> <package-path>')
    }
    await expect(cli('update', file, '../service', 'package')).rejects.toThrow('Invalid plugin id')
    await expect(cli('stage', file, 'package', '--reference')).rejects.toThrow('--reference applies to install and update')
    expect((await status()).running).toBe(false)
  })
})

describe.skipIf(process.platform === 'win32')('Unit package references', () => {
  it('runs two instances from one read-only directory and updates one by switching its path', async () => {
    const peer = join(scratch, 'peer/unit.json')
    await cli('init', dirname(peer), '--port', '0')
    const v1 = await sealedFixture('service', '1.0.0'), v2 = await sealedFixture('service', '2.0.0')
    const broken = await sealedFixture('service', '3.0.0', true), newcomer = await sealedFixture('newcomer', '1.0.0')
    const shared = await Promise.all([v1, v2, broken, newcomer].map((dir) => realpath(dir)))
    const digests = () => Promise.all(shared.map(packageDigest)), before = await digests()
    for (const config of [file, peer]) {
      expect(JSON.parse(await cli('install', config, v1, '--reference'))).toEqual({ id: 'service', version: '1.0.0', path: shared[0], reference: true })
      expect(await configuredPaths(config)).toEqual([shared[0]])
    }
    const child = await start()
    await start(peer)
    const a = await status(), b = await status(peer)
    expect(a.pid).not.toBe(b.pid)
    expect(await service(a.port)).toMatchObject({ version: '1.0.0', pid: a.pid })
    expect(await service(b.port)).toMatchObject({ version: '1.0.0', pid: b.pid })

    // Both failures reach the installer's cleanup, which must never touch a package it did not copy.
    await expect(cli('install', file, newcomer, '--reference')).rejects.toThrow('Stop the Unit')
    await expect(cli('update', file, 'service', broken, '--reference')).rejects.toThrow('Rejected CLI fixture activation')
    expect(await service(a.port)).toMatchObject({ version: '1.0.0', pid: a.pid })

    expect(JSON.parse(await cli('update', file, 'service', v2, '--reference'))).toEqual({ id: 'service', version: '2.0.0', path: shared[1], reference: true })
    expect(await service(a.port)).toMatchObject({ version: '2.0.0', pid: a.pid })
    expect(await service(b.port)).toMatchObject({ version: '1.0.0', pid: b.pid })
    expect(await configuredPaths(file)).toEqual([shared[1]])
    expect(await configuredPaths(peer)).toEqual([shared[0]])

    await stop(child)
    await start()
    expect(await service((await status()).port)).toMatchObject({ version: '2.0.0' })
    expect(await service(b.port)).toMatchObject({ version: '1.0.0', pid: b.pid })
    expect(await digests()).toEqual(before)
    for (const config of [file, peer]) await expect(stat(join(dirname(config), 'plugins'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 40_000)

  it('treats an unreadable reference as unknown and leaves the configuration alone', async () => {
    const v1 = await sealedFixture('service', '1.0.0'), next = await sealedFixture('service', '2.0.0')
    await cli('install', file, v1, '--reference')
    const config = await readFile(file, 'utf8')
    await expect(cli('install', file, join(scratch, 'not-mounted'), '--reference')).rejects.toThrow('ENOENT')
    await rename(v1, v1 + '.not-mounted')
    await expect(cli('install', file, next, '--reference')).rejects.toThrow('ENOENT')
    await expect(cli('disable', file, 'service')).rejects.toThrow('ENOENT')
    await expect(cli('run', file)).rejects.toThrow('ENOENT')
    expect(await readFile(file, 'utf8')).toBe(config)
    await rename(v1 + '.not-mounted', v1)
    await start()
    expect(await service((await status()).port)).toMatchObject({ version: '1.0.0' })
  }, 25_000)
})
