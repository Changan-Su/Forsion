import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import chokidar, { type FSWatcher } from 'chokidar'
import {
  CODE_STUDIO_SNAPSHOT_MAX_BYTES,
  createCodeStudioProjectWatcher,
  createCodeStudioSnapshot,
  isCodeStudioSnapshotSource,
  listCodeStudioSnapshots,
  restoreCodeStudioSnapshot,
} from './codeStudioProjects'
import type { CodeStudioProjectChange } from '../shared/codeStudio'

let home: string
let root: string
let data: string
const closers: Array<() => void> = []
beforeEach(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'coding-projects-')))
  root = path.join(home, 'project')
  data = path.join(home, 'history')
  await fs.mkdir(root)
})
afterEach(async () => {
  closers.splice(0).forEach((close) => close())
  vi.restoreAllMocks()
  await fs.rm(home, { recursive: true, force: true })
})
async function put(relative: string, content: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true })
  await fs.writeFile(path.join(root, relative), content)
}
const read = (relative: string): Promise<string> => fs.readFile(path.join(root, relative), 'utf8')
const historyPath = (id: string): string => path.join(data, createHash('sha256').update(root).digest('hex'), id)

describe('Coding Studio source snapshots', () => {
  it('captures design tokens while excluding token credential stores', async () => {
    const source = ['tokens.ts', 'styles/tokens.css', 'design-tokens.json', 'tokens/colors.ts']
    const credentials = ['token.json', 'tokens.json', 'access-token.json', 'refresh_token.yaml', 'oauth-token-store.toml']
    for (const rel of [...source, ...credentials]) await put(rel, `contents of ${rel}`)
    source.forEach((rel) => expect(isCodeStudioSnapshotSource(rel)).toBe(true))
    credentials.forEach((rel) => expect(isCodeStudioSnapshotSource(rel)).toBe(false))
    const snapshot = await createCodeStudioSnapshot(root, data)
    expect(snapshot.files).toBe(source.length)
    for (const rel of source) await put(rel, 'changed')
    await restoreCodeStudioSnapshot(root, data, snapshot.id)
    for (const rel of source) expect(await read(rel)).toBe(`contents of ${rel}`)
  })

  it('captures source/config only, skips secrets/binaries/dependencies/symlinks, and lists a per-project history', async () => {
    await put('index.html', '<h1>First</h1>')
    await put('src/App.tsx', 'export const App = () => "Hello"')
    await put('package.json', '{"type":"module"}')
    await put('.gitignore', 'node_modules')
    for (const rel of ['.env', '.env.local', 'secrets.json', 'config/credentials.toml', 'auth.json', 'node_modules/x/index.js', 'dist/bundle.js', '.git/config', 'photo.png']) await put(rel, 'not source')
    const outside = path.join(home, 'private.txt')
    await fs.writeFile(outside, 'private outside data')
    await fs.symlink(outside, path.join(root, 'link.txt'))
    await fs.symlink(home, path.join(root, 'linked-dir'))
    const first = await createCodeStudioSnapshot(root, data, 'First working app')
    expect(first).toMatchObject({ name: 'First working app', files: 4 })
    expect(await listCodeStudioSnapshots(root, data)).toEqual([first])
    const manifest = JSON.parse(await fs.readFile(path.join(historyPath(first.id), 'manifest.json'), 'utf8'))
    expect(manifest.entries.map((e: { path: string }) => e.path).sort()).toEqual(['.gitignore', 'index.html', 'package.json', 'src/App.tsx'])
    const other = path.join(home, 'second')
    await fs.mkdir(other)
    expect(await listCodeStudioSnapshots(other, data)).toEqual([])
  })

  it('restores edits and removals, deletes added source, keeps excluded files, and saves the pre-restore state', async () => {
    await put('index.html', 'version one')
    await put('src/deleted.ts', 'recover me')
    const first = await createCodeStudioSnapshot(root, data, 'Version one')
    await put('index.html', 'version two')
    await fs.unlink(path.join(root, 'src/deleted.ts'))
    await put('added.css', 'remove me')
    await put('.env', 'unchanged secret')
    await put('photo.png', 'unchanged media')
    const report = await restoreCodeStudioSnapshot(root, data, first.id)
    expect(report.conflicts).toEqual([])
    expect(report.restored.sort()).toEqual(['index.html', 'src/deleted.ts'])
    expect(report.deleted).toEqual(['added.css'])
    expect(await read('index.html')).toBe('version one')
    expect(await read('src/deleted.ts')).toBe('recover me')
    expect(await read('.env')).toBe('unchanged secret')
    expect(await read('photo.png')).toBe('unchanged media')
    const undo = await restoreCodeStudioSnapshot(root, data, report.backupId)
    expect(undo.conflicts).toEqual([])
    expect(await read('index.html')).toBe('version two')
    expect(await read('added.css')).toBe('remove me')
    await expect(read('src/deleted.ts')).rejects.toHaveProperty('code', 'ENOENT')
  })

  it('fails rather than recording a partial snapshot above the file or byte limit', async () => {
    await Promise.all(Array.from({ length: 513 }, (_, index) => put(`${index}.ts`, 'x')))
    await expect(createCodeStudioSnapshot(root, data)).rejects.toThrow('512 file limit')
    expect(await listCodeStudioSnapshots(root, data)).toEqual([])
    await fs.rm(root, { recursive: true })
    await fs.mkdir(root)
    await put('huge.ts', Buffer.alloc(CODE_STUDIO_SNAPSHOT_MAX_BYTES + 1, 'x'))
    await expect(createCodeStudioSnapshot(root, data)).rejects.toThrow('16 MB limit')
    expect(await listCodeStudioSnapshots(root, data)).toEqual([])
  })

  it('rejects a source file with binary bytes and disallows histories inside the project', async () => {
    await put('binary.ts', Buffer.from([0, 1, 2]))
    await expect(createCodeStudioSnapshot(root, data)).rejects.toThrow('not UTF-8 text')
    await expect(createCodeStudioSnapshot(root, path.join(root, 'history'))).rejects.toThrow('outside the project')
    const alias = path.join(home, 'project-alias')
    await fs.symlink(root, alias)
    await expect(createCodeStudioSnapshot(root, path.join(alias, 'history'))).rejects.toThrow('outside the project')
    await expect(fs.stat(path.join(root, 'history'))).rejects.toHaveProperty('code', 'ENOENT')
    expect(isCodeStudioSnapshotSource('../outside.ts')).toBe(false)
    expect(isCodeStudioSnapshotSource('C:\\outside.ts')).toBe(false)
    expect(isCodeStudioSnapshotSource('config/service-account.json')).toBe(false)
  })

  it('validates every manifest entry and blob before changing the project', async () => {
    await put('index.html', 'original')
    await put('app.ts', 'original app')
    const first = await createCodeStudioSnapshot(root, data)
    const manifestPath = path.join(historyPath(first.id), 'manifest.json')
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
    await put('index.html', 'current work')
    const firstPath = manifest.entries[0].path
    manifest.entries[0].path = '../outside.ts'
    await fs.writeFile(manifestPath, JSON.stringify(manifest))
    await expect(restoreCodeStudioSnapshot(root, data, first.id)).rejects.toThrow('Unsafe snapshot manifest entry')
    expect(await read('index.html')).toBe('current work')
    manifest.entries[0].path = firstPath
    await fs.writeFile(manifestPath, JSON.stringify(manifest))
    await fs.writeFile(path.join(historyPath(first.id), 'files', manifest.entries[1].hash), 'corrupt')
    await expect(restoreCodeStudioSnapshot(root, data, first.id)).rejects.toThrow('content is corrupt')
    expect(await read('index.html')).toBe('current work')
    expect((await listCodeStudioSnapshots(root, data)).length).toBe(1) // 未开始恢复，没产生安全备份。
    await expect(restoreCodeStudioSnapshot(root, data, '../escape')).rejects.toThrow('Invalid snapshot ID')
  })

  it('does not follow a symlink replacing a saved source or a snapshot blob', async () => {
    await put('index.html', 'original')
    const first = await createCodeStudioSnapshot(root, data)
    const outside = path.join(home, 'outside.txt')
    await fs.writeFile(outside, 'keep outside')
    await fs.unlink(path.join(root, 'index.html'))
    await fs.symlink(outside, path.join(root, 'index.html'))
    const report = await restoreCodeStudioSnapshot(root, data, first.id)
    expect(report.conflicts).toEqual(['index.html'])
    expect(await fs.readFile(outside, 'utf8')).toBe('keep outside')
    const manifest = JSON.parse(await fs.readFile(path.join(historyPath(first.id), 'manifest.json'), 'utf8'))
    const blob = path.join(historyPath(first.id), 'files', manifest.entries[0].hash)
    await fs.unlink(blob)
    await fs.symlink(outside, blob)
    await expect(restoreCodeStudioSnapshot(root, data, first.id)).rejects.toThrow('Symbolic link')
  })

  it('keeps external edits, deletions, and creations made after the automatic safety snapshot', async () => {
    await put('edited.ts', 'old')
    await put('deleted.ts', 'old')
    await put('created.ts', 'old')
    const first = await createCodeStudioSnapshot(root, data)
    await put('edited.ts', 'current')
    await put('deleted.ts', 'current')
    await fs.unlink(path.join(root, 'created.ts'))
    // 真备份落盘后插入外部编辑，钉住时序；只观察 rename，不替换文件系统实现。
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await rename(from, to)
      if (String(from).includes('.tmp-')) {
        await put('edited.ts', 'external edit')
        await fs.unlink(path.join(root, 'deleted.ts'))
        await put('created.ts', 'external creation')
      }
    })
    const report = await restoreCodeStudioSnapshot(root, data, first.id)
    expect(report.conflicts.sort()).toEqual(['created.ts', 'deleted.ts', 'edited.ts'])
    expect(report.restored).toEqual([])
    expect(await read('edited.ts')).toBe('external edit')
    expect(await read('created.ts')).toBe('external creation')
    await expect(read('deleted.ts')).rejects.toHaveProperty('code', 'ENOENT')
  })

  it('does not modify the project when the required safety backup fails', async () => {
    await put('index.html', 'original')
    const first = await createCodeStudioSnapshot(root, data)
    await put('index.html', 'current work')
    const write = fs.writeFile.bind(fs)
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
      if (String(args[0]).includes('.tmp-')) throw new Error('disk full')
      return write(...args)
    })
    await expect(restoreCodeStudioSnapshot(root, data, first.id)).rejects.toThrow('disk full')
    expect(await read('index.html')).toBe('current work')
  })

  it('serializes a concurrent snapshot behind restore and preserves executable permissions', async () => {
    await put('run.sh', '#!/bin/sh\necho first')
    await fs.chmod(path.join(root, 'run.sh'), 0o764)
    const first = await createCodeStudioSnapshot(root, data)
    await put('run.sh', '#!/bin/sh\necho second')
    await fs.chmod(path.join(root, 'run.sh'), 0o600)
    let entered!: () => void
    let release!: () => void
    const backupEntered = new Promise<void>((resolve) => { entered = resolve })
    const backupRelease = new Promise<void>((resolve) => { release = resolve })
    const rename = fs.rename.bind(fs)
    let blockOnce = true
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await rename(from, to)
      if (blockOnce && String(from).includes('.tmp-')) { blockOnce = false; entered(); await backupRelease }
    })
    const restoring = restoreCodeStudioSnapshot(root, data, first.id)
    await backupEntered
    const concurrent = createCodeStudioSnapshot(root, data, 'After restore')
    release()
    await restoring
    const after = await concurrent
    const manifest = JSON.parse(await fs.readFile(path.join(historyPath(after.id), 'manifest.json'), 'utf8'))
    const saved = await fs.readFile(path.join(historyPath(after.id), 'files', manifest.entries[0].hash), 'utf8')
    expect(saved).toBe('#!/bin/sh\necho first')
    expect((await fs.stat(path.join(root, 'run.sh'))).mode & 0o777).toBe(0o764)
  })

  it('keeps a directory symlink intact when it replaces a recorded source directory', async () => {
    await put('src/app.ts', 'original')
    const first = await createCodeStudioSnapshot(root, data)
    await fs.rm(path.join(root, 'src'), { recursive: true })
    const outside = path.join(home, 'external-src')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'app.ts'), 'outside work')
    await fs.symlink(outside, path.join(root, 'src'))
    const report = await restoreCodeStudioSnapshot(root, data, first.id)
    expect(report.conflicts).toEqual(['src/app.ts'])
    expect((await fs.lstat(path.join(root, 'src'))).isSymbolicLink()).toBe(true)
    expect(await fs.readFile(path.join(outside, 'app.ts'), 'utf8')).toBe('outside work')
  })
})

describe('Coding Studio project watcher', () => {
  it('prunes dependency and hidden build directories during startup', async () => {
    await put('tokens.ts', 'initial')
    await put('node_modules/big/package/src/main.ts', 'do not watch')
    await put('.next/server/chunks/bundle.js', 'do not watch')
    await put('dist/assets/bundle.js', 'do not watch')
    const instances: FSWatcher[] = []
    const watch = chokidar.watch.bind(chokidar)
    vi.spyOn(chokidar, 'watch').mockImplementation((...args: Parameters<typeof chokidar.watch>) => {
      const instance = watch(...args)
      instances.push(instance)
      return instance
    })
    const changes: CodeStudioProjectChange[] = []
    const watcher = createCodeStudioProjectWatcher((event) => changes.push(event), undefined, { usePolling: true })
    closers.push(watcher.close)
    await watcher.setRoot(root)
    const watched = Object.keys(instances[0].getWatched())
    expect(watched.some((dir) => /node_modules|\.next|\/dist(?:\/|$)/.test(dir))).toBe(false)
    await put('tokens.ts', 'changed')
    await vi.waitFor(() => expect(changes.some((event) => event.path === 'tokens.ts')).toBe(true))
  })

  it('reports a fatal watcher error after readiness with its project root', async () => {
    const fake = Object.assign(new EventEmitter(), { close: vi.fn(async () => {}) })
    vi.spyOn(chokidar, 'watch').mockReturnValue(fake as unknown as FSWatcher)
    const failures = vi.fn()
    const watcher = createCodeStudioProjectWatcher(() => {}, failures)
    closers.push(watcher.close)
    const starting = watcher.setRoot(root)
    await vi.waitFor(() => expect(fake.listenerCount('ready')).toBe(1))
    fake.emit('ready')
    await starting
    const error = Object.assign(new Error('Source watcher lost access'), { code: 'EACCES' })
    fake.emit('error', error)
    expect(failures).toHaveBeenCalledExactlyOnceWith(error, root)
    expect(fake.close).toHaveBeenCalledOnce()
  })

  it('falls back once from native watch exhaustion to polling and asks the UI to rescan', async () => {
    const instances: Array<EventEmitter & { close: ReturnType<typeof vi.fn> }> = []
    const modes: boolean[] = []
    vi.spyOn(chokidar, 'watch').mockImplementation((_root, options) => {
      modes.push(!!options?.usePolling)
      const instance = Object.assign(new EventEmitter(), { close: vi.fn(async () => {}) })
      instances.push(instance)
      return instance as unknown as FSWatcher
    })
    const changes = vi.fn()
    const failures = vi.fn()
    const watcher = createCodeStudioProjectWatcher(changes, failures)
    closers.push(watcher.close)
    const starting = watcher.setRoot(root)
    await vi.waitFor(() => expect(instances.length).toBe(1))
    instances[0].emit('error', Object.assign(new Error('Native watch limit'), { code: 'EMFILE' }))
    await vi.waitFor(() => expect(instances.length).toBe(2))
    instances[1].emit('ready')
    await starting
    expect(modes).toEqual([false, true])
    expect(changes).toHaveBeenCalledExactlyOnceWith({ root, path: null })
    expect(failures).not.toHaveBeenCalled()
    // polling 自身失败后明确报告，不再无限重建。
    const error = Object.assign(new Error('Polling lost access'), { code: 'EACCES' })
    instances[1].emit('error', error)
    expect(failures).toHaveBeenCalledExactlyOnceWith(error, root)
    expect(instances.length).toBe(2)
  })

  it('cancels pending startup on null, superseding roots, and close without leaving hanging promises', async () => {
    const instances: Array<EventEmitter & { close: ReturnType<typeof vi.fn> }> = []
    vi.spyOn(chokidar, 'watch').mockImplementation(() => {
      const instance = Object.assign(new EventEmitter(), { close: vi.fn(async () => {}) })
      instances.push(instance)
      return instance as unknown as FSWatcher
    })
    const changes = vi.fn()
    const failures = vi.fn()
    const watcher = createCodeStudioProjectWatcher(changes, failures)
    closers.push(watcher.close)
    const first = watcher.setRoot(root)
    await vi.waitFor(() => expect(instances.length).toBe(1))
    await watcher.setRoot(null)
    await first
    instances[0].emit('ready')
    expect(instances[0].close).toHaveBeenCalledOnce()
    const second = watcher.setRoot(root)
    await vi.waitFor(() => expect(instances.length).toBe(2))
    const other = path.join(home, 'other')
    await fs.mkdir(other)
    const third = watcher.setRoot(other)
    await second
    await vi.waitFor(() => expect(instances.length).toBe(3))
    watcher.close()
    await third
    instances[1].emit('ready')
    instances[2].emit('ready')
    instances[2].emit('all', 'change', path.join(other, 'app.ts'))
    instances[2].emit('error', new Error('late error'))
    expect(instances.every((instance) => instance.close.mock.calls.length === 1)).toBe(true)
    expect(changes).not.toHaveBeenCalled()
    expect(failures).not.toHaveBeenCalled()
  })

  it('follows real external changes and newly added folders while ignoring dependencies, hidden files and symlinks', async () => {
    await put('index.html', 'initial')
    await put('node_modules/x/a.js', 'initial')
    const outside = path.join(home, 'outside')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'external.ts'), 'initial')
    await fs.symlink(outside, path.join(root, 'linked'))
    const changes: CodeStudioProjectChange[] = []
    const watcher = createCodeStudioProjectWatcher((event) => changes.push(event), undefined, { usePolling: true })
    closers.push(watcher.close)
    await watcher.setRoot(root)
    await put('index.html', 'changed')
    await put('nested/new.ts', 'new file')
    await put('node_modules/x/a.js', 'changed')
    await put('.env', 'secret')
    await fs.writeFile(path.join(outside, 'external.ts'), 'outside change')
    await vi.waitFor(() => expect(changes.some((event) => event.path === 'index.html')).toBe(true), { timeout: 4000 })
    await vi.waitFor(() => expect(changes.some((event) => event.path === 'nested/new.ts')).toBe(true), { timeout: 4000 })
    expect(changes.every((event) => event.root === root)).toBe(true)
    expect(changes.some((event) => /node_modules|\.env|linked/.test(event.path || ''))).toBe(false)
  })

  it('switching roots and closing suppresses events from old projects', async () => {
    await put('first.ts', 'one')
    const other = path.join(home, 'other')
    await fs.mkdir(other)
    await fs.writeFile(path.join(other, 'second.ts'), 'two')
    const changes: CodeStudioProjectChange[] = []
    const watcher = createCodeStudioProjectWatcher((event) => changes.push(event), undefined, { usePolling: true })
    closers.push(watcher.close)
    await watcher.setRoot(root)
    await watcher.setRoot(other)
    changes.length = 0
    await put('first.ts', 'old changed')
    await fs.writeFile(path.join(other, 'second.ts'), 'new changed')
    await vi.waitFor(() => expect(changes.some((event) => event.path === 'second.ts')).toBe(true), { timeout: 4000 })
    expect(changes.every((event) => event.root === other)).toBe(true)
    watcher.close()
    changes.length = 0
    await fs.writeFile(path.join(other, 'second.ts'), 'after close')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(changes).toEqual([])
  })
})
