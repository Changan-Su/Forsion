import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'

const exec = promisify(execFile)
let root: string, scratch: string, main: string, file: string
const children = new Set<ChildProcess>()
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
})
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

async function cli(...args: string[]) {
  return (await exec(process.execPath, [main, ...args], { cwd: scratch || root, env, timeout: 15_000 })).stdout
}
const status = async () => JSON.parse(await cli('status', file))
async function start() {
  const child = spawn(process.execPath, [main, 'run', file], { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child)
  let output = ''
  child.stdout!.on('data', (chunk) => { output += chunk })
  child.stderr!.on('data', (chunk) => { output += chunk })
  await expect.poll(async () => {
    if (child.exitCode !== null) throw new Error(`Unit exited before ready: ${output}`)
    return (await status()).running
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
    expect((await status()).running).toBe(false)
  })
})
