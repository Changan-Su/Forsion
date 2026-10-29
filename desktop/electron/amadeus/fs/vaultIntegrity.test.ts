import { afterEach, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { VaultManager } from './vaultManager'

const roots: string[] = []
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-integrity-'))
  roots.push(root)
  const vault = new VaultManager()
  vault.setRoot(root)
  return { root, vault }
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(r => fs.rm(r, { recursive: true, force: true }))) })

it('20 concurrent same-name attachments retain every input, including compound suffixes', async () => {
  const { root, vault } = await setup()
  const imported = await Promise.all(Array.from({ length: 20 }, (_, i) => vault.writeAttachment('N.md', '中文 name.excalidraw.md', Buffer.from(`input-${i}`), { mode: 'attachments', folder: '' })))
  expect(new Set(imported.map(r => r.pageRel)).size).toBe(20)
  for (const [i, r] of imported.entries()) {
    expect(r.base.endsWith('.excalidraw.md')).toBe(true)
    expect(await fs.readFile(path.join(root, r.pageRel), 'utf8')).toBe(`input-${i}`)
  }
})

it('a standalone full-path read cannot be redirected by a same-named nested path', async () => {
  const { vault } = await setup()
  await vault.writeTextFile('A/data.db', 'correct')
  await vault.writeTextFile('A/A/data.db', 'decoy')
  expect(await vault.resolveAttachment('A/data.db', 'A/data.db')).toBe(vault.absPath('A/data.db'))
  expect(await vault.resolveAttachment('A/note.md', './data.db')).toBe(vault.absPath('A/data.db'))
})

it('failed attachment writes remove only their own incomplete file', async () => {
  const { root, vault } = await setup()
  await vault.writeAttachment('N.md', 'name.txt', Buffer.from('existing'), { mode: 'same', folder: '' })
  const open = fs.open.bind(fs)
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args)
    vi.spyOn(handle, 'writeFile').mockImplementation(async () => { await handle.write('partial'); throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) })
    return handle
  })
  await expect(vault.writeAttachment('N.md', 'name.txt', Buffer.from('new'), { mode: 'same', folder: '' })).rejects.toThrow('disk full')
  expect(await fs.readdir(root)).toEqual(['name.txt'])
  expect(await fs.readFile(path.join(root, 'name.txt'), 'utf8')).toBe('existing')
})

it('concurrent trash entries retain their original paths and restore every byte', async () => {
  const { root, vault } = await setup()
  const originals = Array.from({ length: 20 }, (_, i) => `dir-${i}/same.md`)
  await Promise.all(originals.map((p, i) => vault.writeTextFile(p, `input-${i}`)))
  await Promise.all(originals.map(p => vault.trashEntry(p)))
  const entries = await vault.listTrash()
  expect(entries).toHaveLength(20)
  expect(new Set(entries.map(e => e.original))).toEqual(new Set(originals))
  await Promise.all(entries.map(e => vault.restoreTrash(e.name)))
  for (const [i, p] of originals.entries()) expect(await fs.readFile(path.join(root, p), 'utf8')).toBe(`input-${i}`)
})

it('a crash immediately after moving to trash retains the original identity across restart', async () => {
  const { root, vault } = await setup()
  await vault.writeTextFile('folder/note.md', 'precious')
  const rename = fs.rename.bind(fs)
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    await rename(from, to)
    if (String(from).endsWith(`${path.sep}note.md`)) throw new Error('simulated crash after move')
  })
  await expect(vault.trashEntry('folder/note.md')).rejects.toThrow('simulated crash')
  vi.restoreAllMocks()
  const restarted = new VaultManager()
  restarted.setRoot(root)
  const [entry] = await restarted.listTrash()
  expect(entry.original).toBe('folder/note.md')
  expect(await restarted.restoreTrash(entry.name)).toBe('folder/note.md')
  expect(await fs.readFile(path.join(root, 'folder/note.md'), 'utf8')).toBe('precious')
})

it('self-write ledger stores no source text and retires directory descendants and roots', async () => {
  const { root, vault } = await setup()
  await vault.writeTextFile('folder/a.md', 'large source '.repeat(10000))
  const ledger = vault['lastWritten']
  expect(JSON.stringify([...ledger.values()]).length).toBeLessThan(500)
  await vault.moveEntry('folder', 'moved')
  expect(ledger.size).toBe(0)
  await vault.writeTextFile('moved/a.md', 'next')
  await vault.removeEntry('moved')
  expect(ledger.size).toBe(0)
  await vault.writeTextFile('a.md', 'next')
  vault.setRoot(root + '-other')
  expect(ledger.size).toBe(0)
})

it('1000 file lifecycles retain only live ledger entries, and the cache has a fixed capacity', async () => {
  const { vault } = await setup()
  await vault.writeTextFile('live.md', 'keep')
  for (let i = 0; i < 1000; i++) {
    await vault.writeTextFile(`folder-${i}/a.md`, 'text')
    await vault.removeEntry(`folder-${i}`)
  }
  expect(vault['lastWritten'].size).toBe(1)
  // Exercise the capacity guard without thousands of unrelated filesystem writes.
  for (let i = 0; i < 3000; i++) vault['rememberWrite'](vault.absPath(`active-${i}.md`), 'text', vault['rootGeneration'])
  expect(vault['lastWritten'].size).toBeLessThanOrEqual(2048)
}, 30000)

it('trash operations from independent managers share the transaction and preserve mixed restore/delete/import metadata', async () => {
  const { root, vault } = await setup()
  const other = new VaultManager()
  other.setRoot(root)
  for (const p of ['A/same.md', 'B/same.md', 'C/same.md']) await vault.writeTextFile(p, p)
  await Promise.all([vault.trashEntry('A/same.md'), other.trashEntry('B/same.md')])
  const initial = await vault.listTrash()
  await Promise.all([vault.restoreTrash(initial[0].name), other.deleteTrashEntry(initial[1].name), vault.trashEntry('C/same.md')])
  const remaining = await other.listTrash()
  expect(remaining.map(e => e.original)).toEqual(['C/same.md'])
  expect(await fs.readFile(path.join(root, initial[0].original), 'utf8')).toBe(initial[0].original)
  // Start the import only once emptyTrash owns the transaction. Promise.all
  // invocation order cannot order the asynchronous realpath/lock acquisition.
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const atDelete = new Promise<void>(resolve => { entered = resolve })
  const rm = fs.rm.bind(fs)
  vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
    if (String(target) === path.join(root, '.trash')) { entered(); await gate }
    return rm(target, options)
  })
  const empty = vault.emptyTrash()
  await atDelete
  const importing = other.trashEntry(initial[0].original)
  release()
  await Promise.all([empty, importing])
  expect((await vault.listTrash()).map(e => e.original)).toEqual([initial[0].original])
})
