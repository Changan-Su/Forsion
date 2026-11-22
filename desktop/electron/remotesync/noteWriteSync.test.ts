import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { IPC } from '@amadeus-shared/ipc'
import { textFingerprint } from '@amadeus-shared/writeConflict'
import { VaultManager } from '../amadeus/fs/vaultManager'
import { VaultIndex } from '../amadeus/fs/vaultIndex'
import { registerVaultHandlers, type VaultHandlerDependencies } from '../amadeus/fs/vaultHandlers'
import { runSync, moveAsideFromSync } from './engine'
import { createDirRemote } from './fsLocal'

let scratch: string, root: string, remoteRoot: string
const note = 'research/spectra.md'
const before = 'old baseline', edit = 'locally replaced text', cloud = 'changed on another device'
beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'note-replace-sync-'))
  root = path.join(scratch, 'vault')
  remoteRoot = path.join(scratch, 'remote')
  await fs.mkdir(path.join(root, 'research'), {recursive: true})
  await fs.mkdir(remoteRoot)
  await fs.writeFile(path.join(root, note), before)
})
afterEach(async () => { await fs.rm(scratch, {recursive: true, force: true}) })

// Pause the real strict write after the handler has accepted the on-disk fingerprint,
// immediately before its atomic write. The competing operation gets to run in that gap.
async function raceStrictWrite<T>(competing: () => Promise<T>): Promise<T> {
  const vault = new VaultManager()
  vault.setRoot(root)
  const handlers = new Map<string, Parameters<VaultHandlerDependencies['handle']>[1]>()
  registerVaultHandlers({
    vault, index: new VaultIndex(vault), handle: (id, fn) => { handlers.set(id, fn) },
    rememberPage: async () => {}, notifyAll: () => {},
  })
  let reached!: () => void, release!: () => void
  const ready = new Promise<void>(r => { reached = r })
  const gate = new Promise<void>(r => { release = r })
  const real = vault.writeTextFile.bind(vault)
  vi.spyOn(vault, 'writeTextFile').mockImplementationOnce(async (...args) => {
    reached()
    await gate
    await real(...args)
  })
  const saving = handlers.get(IPC.writeTextFile)!(null, note, edit, {
    strictExisting: true, base: textFingerprint(before), expectedRoot: root,
  })
  await ready
  const other = competing()
  try {
    await Promise.race([other, new Promise(resolve => setTimeout(resolve, 120))])
    expect(await fs.readFile(path.join(root, note), 'utf8')).toBe(before)
  } finally { release(); await Promise.all([saving, other]) }
  expect(await saving).toEqual({ok: true})
  return other
}

it.each(['pull', 'delete'] as const)('serializes a sync %s with a real strict note edit and retains the edits', async action => {
  const remote = createDirRemote(remoteRoot)
  const sync = () => runSync({localRoot: root, remote, statePath: path.join(scratch, 'state.json'), fingerprint: 'fixture'})
  expect((await sync()).pushed).toBe(1)
  if (action === 'pull') await remote.writeFile(note, Buffer.from(cloud), Date.now())
  else await remote.rm(note)
  const report = await raceStrictWrite(sync)
  expect(report.ok).toBe(true)
  if (action === 'delete') {
    expect(report.deletedLocal).toBe(0)
    expect(await fs.readFile(path.join(root, note), 'utf8')).toBe(edit)
  } else {
    expect(report.conflicts).toBe(1)
    expect(await fs.readFile(path.join(root, note), 'utf8')).toBe(cloud)
    const copy = (await fs.readdir(path.join(root, 'research'))).find(f => f.includes('(conflict '))
    expect(await fs.readFile(path.join(root, 'research', copy!), 'utf8')).toBe(edit)
  }
})

it('moves the completed edit into the backup when adopting the cloud vault', async () => {
  const backupDir = path.join(scratch, 'backup')
  const result = await raceStrictWrite(() => moveAsideFromSync({
    localRoot: root, keys: [note], backupDir, statePath: path.join(scratch, 'state.json'), fingerprint: 'fixture',
  }))
  expect(result).toEqual({moved: 1})
  expect(await fs.readFile(path.join(backupDir, note), 'utf8')).toBe(edit)
  await expect(fs.access(path.join(root, note))).rejects.toMatchObject({code:'ENOENT'})
})

it.each(['write', 'remove'] as const)('serializes a folder-backend %s targeting the note with its strict write', async action => {
  const folder = createDirRemote(root)
  await raceStrictWrite(async () => {
    if (action === 'write') await folder.writeFile(note, Buffer.from(cloud), Date.now())
    else await folder.rm(note)
  })
  if (action === 'write') expect(await fs.readFile(path.join(root, note), 'utf8')).toBe(cloud)
  else await expect(fs.access(path.join(root, note))).rejects.toMatchObject({code:'ENOENT'})
})
