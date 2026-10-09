import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { IPC, type DbReadResult } from '@amadeus-shared/ipc'
import type { LoadedPage } from '@amadeus-shared/compiler'
import { createLocalVault, type LocalVault } from '../../unit/localVault'
import { createRuntime } from '../../unit/plugins/amadeus/runtime'
import { VaultWatcher } from './amadeus/fs/watcher'

const execute = promisify(execFile)
let scratch: string
const live = new Set<LocalVault>()
beforeEach(async () => { scratch = await mkdtemp(join(tmpdir(), 'unit-local-vault-')) })
afterEach(async () => { for (const vault of live) await vault.close(); live.clear(); await rm(scratch, { recursive: true, force: true }) })
const options = (name = 'owner') => ({ root: join(scratch, name, 'files'), stateDir: join(scratch, name, 'state') })
async function open(name = 'owner', pluginFileExtensions?: string[]) {
  const vault = await createLocalVault({ ...options(name), pluginFileExtensions })
  live.add(vault)
  return vault
}
async function close(vault: LocalVault) { await vault.close(); live.delete(vault) }

describe('standalone local Amadeus capability', () => {
  it('persists page/compiler state, local Calendar rows, binary assets and plugin data across a cold restart', async () => {
    let vault = await open()
    await vault.call(IPC.createFolder, ['', 'Notes'])
    const page = await vault.call(IPC.newPage, ['Notes/Offline.md']) as LoadedPage
    const id = Object.keys(page.blocks)[0]
    await vault.call(IPC.savePage, ['Notes/Offline.md', page.manifest, { [id]: 'Offline note #local' }], 'tab-a')
    const saved = await vault.call(IPC.dbRead, ['', 'Calendar.db']) as Extract<DbReadResult, { status: 'ok' }>
    expect(saved.status).toBe('ok')
    expect(saved.data.rows).toEqual([])
    const name = saved.data.columns.find((c) => c.type === 'text')!.id
    const date = saved.data.columns.find((c) => c.type === 'calendarDate')!.id
    saved.data.rows.push({ id: 'offline-event', cells: { [name]: 'Local appointment', [date]: '2026-09-09T10:00/2026-09-09T11:00' } })
    expect(await vault.call(IPC.dbWriteCas, ['Calendar.db', saved.data, saved.version], 'tab-a')).toMatchObject({ ok: true })
    await vault.call(IPC.pluginDataWrite, ['bluebird', '{"collection":"offline"}'])
    await vault.call(IPC.writeTextFile, ['Bluebird/collection.json', '{"links":["https://example.test"]}'])
    const asset = await vault.call(IPC.saveAsset, ['Notes/Offline.md', 'image.png', new Uint8Array([1, 2, 3])]) as string
    expect(await readFile((await vault.assetAbs('Notes/Offline.md', asset))!)).toEqual(Buffer.from([1, 2, 3]))
    await close(vault)
    vault = await open()
    expect(await vault.call(IPC.restoreVault, [])).toMatchObject({ pages: ['Notes/Offline.md'], folders: ['Bluebird', 'Notes'], lastPage: 'Notes/Offline.md' })
    expect(JSON.stringify(await vault.call(IPC.loadPage, ['Notes/Offline.md']))).toContain('Offline note #local')
    expect(await vault.call(IPC.search, ['Offline note'])).toHaveLength(1)
    expect(await vault.call(IPC.pluginDataRead, ['bluebird'])).toBe('{"collection":"offline"}')
    expect(await vault.call(IPC.readTextFile, ['Bluebird/collection.json'])).toContain('https://example.test')
    expect(await vault.call(IPC.dbRead, ['', 'Calendar.db'])).toMatchObject({ status: 'ok', data: { rows: [{ id: 'offline-event' }] } })
    expect(await readFile((await vault.assetAbs('Notes/Offline.md', asset))!)).toEqual(Buffer.from([1, 2, 3]))
  })

  it('uses the desktop rewrite/index path and retains plugin file-type protection after removal', async () => {
    let vault = await open('owner', ['.mindmap.md'])
    await vault.call(IPC.writeTextFile, ['Reference.md', '[[Original]]'])
    await vault.call(IPC.writeTextFile, ['Original.md', '---\nicon: 📕\n---\nFresh searchable note #offline'])
    await vault.call(IPC.writeTextFile, ['Map.mindmap.md', 'PRIVATE_PLUGIN_FORMAT'])
    expect(await vault.call(IPC.pageIcons, [])).toMatchObject({ 'Original.md': '📕' })
    expect(await vault.call(IPC.renamePageFile, ['Original.md', 'Renamed'])).toBe('Renamed.md')
    expect(await vault.call(IPC.readTextFile, ['Reference.md'])).toBe('[[Renamed]]')
    expect(await vault.call(IPC.search, ['searchable'])).toHaveLength(1)
    expect(await vault.call(IPC.listPages, [])).not.toContain('Map.mindmap.md')
    await close(vault)
    vault = await open()
    expect(await vault.call(IPC.listPages, [])).not.toContain('Map.mindmap.md')
    expect(await vault.call(IPC.listFiles, [])).toContain('Map.mindmap.md')
    expect(await vault.call(IPC.readTextFile, ['Map.mindmap.md'])).toBe('PRIVATE_PLUGIN_FORMAT')
    await vault.call(IPC.trashEntry, ['Renamed.md'])
    expect(await vault.call(IPC.search, ['searchable'])).toHaveLength(0)
    const entries = await vault.call(IPC.listTrash, []) as Array<{ name: string }>
    await vault.call(IPC.restoreTrash, [entries[0].name])
    expect(await vault.call(IPC.search, ['searchable'])).toHaveLength(1)
  })

  it('rejects generic extension claims, including unsafe saved tombstones, without hiding ordinary notes', async () => {
    await mkdir(options().stateDir, { recursive: true })
    await writeFile(join(options().stateDir, 'file-extensions.json'), JSON.stringify(['.md', '.markdown', '.txt']))
    const vault = await open('owner', ['.md', '.txt', '.markdown', ' .MINDMAP.MD ', '../.md'])
    await vault.call(IPC.writeTextFile, ['Ordinary.md', 'Ordinary searchable note'])
    await vault.call(IPC.writeTextFile, ['Custom.mindmap.md', 'PLUGIN_CUSTOM_FORMAT'])
    expect(await vault.call(IPC.listPages, [])).toEqual(['Ordinary.md'])
    expect(await vault.call(IPC.search, ['Ordinary searchable'])).toHaveLength(1)
    expect(JSON.parse(await readFile(join(options().stateDir, 'file-extensions.json'), 'utf8'))).toEqual(['.mindmap.md'])
  })

  it('loads installed plugin format metadata before discovery and retains protection through disable and a fresh packaged runtime', async () => {
    const plugin = join(scratch, 'format-plugin')
    const workspaceDir = join(scratch, 'runtime-workspace')
    const dataDir = join(scratch, 'runtime-state')
    await mkdir(plugin)
    await mkdir(join(workspaceDir, 'vault'), { recursive: true })
    await writeFile(join(plugin, 'manifest.json'), JSON.stringify({ id: 'mindmap', fileExtensions: ['.mindmap.md', '.md', '.txt'] }))
    await writeFile(join(workspaceDir, 'vault', 'Custom.mindmap.md'), 'UNTOUCHED_CUSTOM_FORMAT')
    await writeFile(join(workspaceDir, 'vault', 'Ordinary.md'), 'Ordinary note')
    const context = { packageDir: resolve('../unit/plugins/amadeus'), workspaceDir, dataDir, config: {}, log: () => {} }
    const runtime = await createRuntime(context)
    try {
      let discovered = false
      const pending = runtime.vault!.call(IPC.listPages, []).then((pages) => { discovered = true; return pages })
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(discovered).toBe(false)
      // Disabled but installed packages still own their persisted file formats.
      await runtime.setPackages!([], [plugin])
      expect(await pending).toEqual(['Ordinary.md'])
      await runtime.setPackages!([], [])
      expect(await runtime.vault!.call(IPC.listPages, [])).toEqual(['Ordinary.md'])
      expect(await runtime.vault!.call(IPC.listFiles, [])).toContain('Custom.mindmap.md')
    } finally { await runtime.close() }

    const outfile = join(scratch, 'amadeus-runtime.mjs')
    await build({ entryPoints: [resolve('../unit/plugins/amadeus/runtime.ts')], outfile,
      bundle: true, platform: 'node', target: 'node20', format: 'esm', logLevel: 'silent', tsconfig: resolve('tsconfig.json'),
      banner: { js: "import { createRequire as __unitCreateRequire } from 'node:module'; const require = __unitCreateRequire(import.meta.url);" },
    })
    const script = `import { createRuntime } from ${JSON.stringify(pathToFileURL(outfile).href)};
      const runtime = await createRuntime({ ...${JSON.stringify({ ...context, log: undefined })}, log() {} });
      try {
        await runtime.setPackages([], []);
        console.log(JSON.stringify({ pages: await runtime.vault.call(${JSON.stringify(IPC.listPages)}, []),
          source: await runtime.vault.call(${JSON.stringify(IPC.readTextFile)}, ['Custom.mindmap.md']) }));
      } finally { await runtime.close(); }`
    const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', script], { cwd: scratch, timeout: 15_000 })
    expect(JSON.parse(stdout)).toEqual({ pages: ['Ordinary.md'], source: 'UNTOUCHED_CUSTOM_FORMAT' })
  })

  it('keeps two owners independent and rejects traversal and symlink redirects for text, bytes, pages and assets', async () => {
    const a = await open('a')
    const b = await open('b')
    await a.call(IPC.writeTextFile, ['Private.md', 'OWNER_A_PRIVATE'])
    await a.call(IPC.pluginDataWrite, ['bluebird', 'OWNER_A_PLUGIN_STATE'])
    expect(await b.call(IPC.readTextFile, ['Private.md'])).toBeNull()
    expect(await b.call(IPC.pluginDataRead, ['bluebird'])).toBeNull()
    await expect(a.call(IPC.writeTextFile, ['../state/escaped.json', 'bad'])).rejects.toThrow()
    await expect(a.call(IPC.pluginDataWrite, ['../escaped', 'bad'])).rejects.toThrow('Invalid plugin id')
    await symlink(options('b').root, join(options('a').root, 'redirect'))
    await b.call(IPC.writeTextFile, ['Private.md', 'OWNER_B_PRIVATE'])
    expect(await a.call(IPC.readTextFile, ['redirect/Private.md'])).toBeNull()
    expect(await a.assetAbs('', 'redirect/Private.md')).toBeNull()
    await expect(a.call(IPC.readVaultBytes, ['redirect/Private.md'])).rejects.toThrow('Symlinks')
    await expect(a.call(IPC.writeTextFile, ['redirect/New.md', 'bad'])).rejects.toThrow('Symlinks')
    await expect(a.call(IPC.newPage, ['redirect/New.md'])).rejects.toThrow('Symlinks')
    await expect(a.call(IPC.saveAsset, ['redirect/New.md', 'image.png', new Uint8Array([1])])).rejects.toThrow('Symlinks')
    await expect(a.call('amadeus:execute-host-command', ['bad'])).rejects.toThrow('Unknown local vault channel')
    expect(await b.call(IPC.readTextFile, ['Private.md'])).toBe('OWNER_B_PRIVATE')
  })

  it('rejects a stale Calendar CAS and propagates remote and external local edits with their correct origins', async () => {
    const vault = await open()
    const events: Array<{ channel: string; payload: unknown; origin: string | null }> = []
    vault.onEvent((channel, payload, origin) => events.push({ channel, payload, origin }))
    await vault.call(IPC.writeTextFile, ['Observed.md', 'initial'], 'tab-a')
    // 笔记经 writeTextFile(v4 唯一落盘通道)写 → externalChange:开着的编辑器只听这一条(评审 G1-04,原为 fileChange)。
    expect(events).toContainEqual({ channel: IPC.externalChange, payload: 'Observed.md', origin: 'tab-a' })
    // 带 base 的 writeTextFile 也是 CAS:被拒 = 没写,不许叫别的编辑器回灌(同下面 Calendar 的 dbWriteCas)。
    // 只数这次写会发的那一类(同下面按 dbChange 数):新建 Observed.md 的 structureChange 由监听器防抖 80ms 后才到,
    // 这一步慢过 80ms 它就落进来(塞 150ms 延时实测必红)—— 数事件总数等于赌它还没到。
    const reloads = (): number => events.filter((e) => e.channel === IPC.externalChange).length
    const beforeTextConflict = reloads()
    expect(await vault.call(IPC.writeTextFile, ['Observed.md', 'stale', { base: 'not-the-current-fingerprint' }], 'stale-tab')).toMatchObject({ ok: false, current: 'initial' })
    expect(reloads()).toBe(beforeTextConflict)
    const saved = await vault.call(IPC.dbRead, ['', 'Calendar.db']) as Extract<DbReadResult, { status: 'ok' }>
    const data = { ...saved.data, name: 'Changed calendar' }
    expect(await vault.call(IPC.dbWriteCas, ['Calendar.db', data, saved.version], 'tab-a')).toMatchObject({ ok: true })
    const beforeConflict = events.filter((e) => e.channel === IPC.dbChange).length
    expect(await vault.call(IPC.dbWriteCas, ['Calendar.db', saved.data, saved.version], 'stale-tab')).toMatchObject({ ok: false })
    expect(events.filter((e) => e.channel === IPC.dbChange)).toHaveLength(beforeConflict)
    await writeFile(join(options().root, 'Observed.md'), 'Changed by a local task #engine')
    // 等的是**操作系统的文件监听事件**(chokidar,ignoreInitial)。⚠️本用例打开库之后立刻外部写盘,并不等监听器 ready:
    // 全量并行、别的套件在起进程时初始扫描变慢,这次写入会落在 ready **之前** —— 被当成初始内容吞掉,事件永远不来
    // (把预算放到 5s 照样红,说明不是「慢」而是「没有」;2026-09-21 新增的 git / 预览服务器套件把这条竞态压成了可复现)。
    // 断言不动(要的仍是一条 origin 为 null 的 externalChange);事件没到就再外部写一次,让已经 ready 的监听器看得到。
    const externalChange = (): boolean => events.some((event) => event.channel === IPC.externalChange && event.payload === 'Observed.md' && event.origin === null)
    let rewrites = 0
    await expect.poll(async () => {
      if (externalChange()) return true
      await writeFile(join(options().root, 'Observed.md'), `Changed by a local task #engine${' '.repeat(++rewrites)}`)
      return false
    }, { timeout: 8000, interval: 300 }).toBe(true)
    await expect.poll(async () => (await vault.call(IPC.search, ['Changed by a local task']) as unknown[]).length, { timeout: 5000 }).toBe(1)
    await close(vault)
    expect(vault.root()).toBeNull()
    await expect(vault.call(IPC.writeTextFile, ['AfterClose.md', 'bad'])).rejects.toThrow('closed')
  })

  it('treats a late file event for the Calendar it seeded as its own write, not an external change', async () => {
    // 要钉的是「收到一次文件事件时怎么判」,不是事件什么时候到:真监听根本不启动(否则它自己在途的处理会掺进来),
    // 事件由这里一次次递给监听器并等它处理完。
    const start = vi.spyOn(VaultWatcher.prototype, 'start').mockImplementation(() => {})
    const vault = await open()
    const watcher = start.mock.contexts[0] as VaultWatcher
    const root = start.mock.calls[0][0]
    start.mockRestore()
    const dbChanges: unknown[] = []
    vault.onEvent((channel, payload) => { if (channel === IPC.dbChange) dbChanges.push(payload) })
    const file = join(root, 'Calendar.db')
    const fileEvent = (): Promise<void> => watcher['handle'](file, root)
    // 迟到的事件 = 字节没变、监听器却被叫起来一次(开库后几毫秒内,负载下偶发:2026-10-09 加压 10 次里 5 次)。
    await fileEvent()
    expect(dbChanges).toEqual([])
    // 别人真改了照报 —— 上面那条不是因为事件没递到才空的。
    await writeFile(file, `${await readFile(file, 'utf8')}\n`)
    await fileEvent()
    expect(dbChanges).toEqual(['Calendar.db'])
  })

  it('bundles and starts in a fresh Node process without Electron, Server or runtime node_modules', async () => {
    const outfile = join(scratch, 'local-vault.mjs')
    const result = await build({
      entryPoints: [resolve('../unit/localVault.ts')], outfile, metafile: true,
      bundle: true, platform: 'node', target: 'node20', format: 'esm', logLevel: 'silent',
      tsconfig: resolve('tsconfig.json'),
      banner: { js: "import { createRequire as __unitCreateRequire } from 'node:module'; const require = __unitCreateRequire(import.meta.url);" },
    })
    expect(Object.keys(result.metafile!.inputs).some((file) => file.includes('node_modules/electron/') || file.includes('/server/'))).toBe(false)
    const script = `import { createLocalVault } from ${JSON.stringify(pathToFileURL(outfile).href)};
      const vault = await createLocalVault(${JSON.stringify(options('portable'))});
      await vault.call(${JSON.stringify(IPC.writeTextFile)}, ['Portable.md', 'no-server-required']);
      console.log(await vault.call(${JSON.stringify(IPC.readTextFile)}, ['Portable.md']));
      await vault.close();`
    const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', script], { cwd: scratch, timeout: 15_000 })
    expect(stdout.trim()).toBe('no-server-required')
  })
})
