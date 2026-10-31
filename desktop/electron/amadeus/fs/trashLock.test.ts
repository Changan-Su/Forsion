import { afterEach, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { withTrashLock } from './trashLock'
let root = ''
afterEach(async () => { vi.restoreAllMocks(); if (root) await fs.rm(root, { recursive: true, force: true }) })
it('a live emptyTrash holder must not lose its lock merely because it takes over 10 seconds', async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'trash-stale-review-'))
  await fs.mkdir(path.join(root, '.trash'))
  await fs.writeFile(path.join(root, '.trash', 'old-file'), 'old')
  await fs.writeFile(path.join(root, 'new-note.md'), 'new data')
  vi.resetModules()
  const { VaultManager: FirstHost } = await import('./vaultManager')
  const first = new FirstHost(); first.setRoot(root)
  vi.resetModules()
  const { VaultManager: SecondHost } = await import('./vaultManager')
  const second = new SecondHost(); second.setRoot(root)
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(r => { release = r })
  const atDelete = new Promise<void>(r => { entered = r })
  const realRm = fs.rm
  vi.spyOn(fs, 'rm').mockImplementation(async (target, opts) => {
    if (String(target) === path.join(root, '.trash')) { entered(); await gate }
    return realRm(target, opts)
  })
  const empty = first.emptyTrash()
  await atDelete
  // Deterministically model a still-running recursive delete taking >10 seconds.
  const stale = new Date(Date.now() - 11_000)
  await fs.utimes(path.join(root, '.trash-transaction.lock'), stale, stale)
  const importing = second.trashEntry('new-note.md')
  try {
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(await fs.readFile(path.join(root, 'new-note.md'), 'utf8')).toBe('new data')
  } finally { release(); await Promise.all([empty, importing]) }
  const originalExists = await fs.access(path.join(root, 'new-note.md')).then(() => true, () => false)
  const trashExists = await fs.access(path.join(root, '.trash')).then(() => true, () => false)
  expect(originalExists || trashExists).toBe(true)
})

it('recovers a dead process owner, without using lock age as permission to steal', async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'trash-owner-crash-'))
  const moduleUrl = new URL('./trashLock.ts', import.meta.url).href
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
      `import { withTrashLock } from ${JSON.stringify(moduleUrl)}; await withTrashLock(${JSON.stringify(root)}, async () => process.exit(0));`], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(stderr)))
  })
  expect(await fs.readFile(path.join(root, '.trash-transaction.lock'), 'utf8')).toContain('token')
  let inside = 0
  await Promise.all(Array.from({ length: 3 }, () => withTrashLock(root, async () => {
    expect(++inside).toBe(1)
    await new Promise(resolve => setTimeout(resolve, 20))
    inside--
  })))
  expect(await fs.access(path.join(root, '.trash-transaction.lock')).then(() => true, () => false)).toBe(false)
})
