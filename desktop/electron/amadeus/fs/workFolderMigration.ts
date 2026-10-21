import { promises as fs, createReadStream, constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import type { WorkFolderMigration, WorkFolderMigrationResult } from '@amadeus-shared/ipc'
import type { VaultManager } from './vaultManager'

type FileStamp = { path: string; hash: string }
type Journal = { version: 1; complete: boolean; source: string; target: string; index: { path: string; before: string | null; after: string }; files: FileStamp[] }
const chains = new Map<string, Promise<unknown>>()
const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
const relative = (value: string): string => {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.split('/').some(p => !p || p === '.' || p === '..' || p.includes(':')) || path.isAbsolute(value)) throw Error('Invalid migration path')
  return value
}
async function safePath(root: string, rel: string): Promise<string> {
  relative(rel)
  let abs = root
  for (const part of rel.split('/')) {
    abs = path.join(abs, part)
    try { if ((await fs.lstat(abs)).isSymbolicLink()) throw Error('Migration cannot follow symlinks') }
    catch (error: any) { if (error.code !== 'ENOENT') throw error }
  }
  return abs
}
async function read(abs: string): Promise<string | null> {
  try { return await fs.readFile(abs, 'utf8') } catch (error: any) { if (error.code === 'ENOENT') return null; throw error }
}
async function hashFile(abs: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(abs)) hash.update(bytes)
  return hash.digest('hex')
}
async function snapshot(root: string, folder: string): Promise<FileStamp[]> {
  const result: FileStamp[] = []
  const walk = async (rel: string): Promise<void> => {
    const abs = await safePath(root, rel), stat = await fs.lstat(abs)
    if (stat.isDirectory()) for (const name of (await fs.readdir(abs)).sort()) await walk(`${rel}/${name}`)
    else if (stat.isFile()) result.push({ path: rel.slice(folder.length + 1), hash: await hashFile(abs) })
    else throw Error('Unsupported migration file')
  }
  await walk(folder)
  return result
}
async function atomic(abs: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(abs), { recursive: true })
  const temp = `${abs}.${randomUUID()}.tmp`
  try { await fs.writeFile(temp, text, { flag: 'wx' }); await fs.rename(temp, abs) }
  finally { await fs.rm(temp, { force: true }) }
}

/** Copy first, publish the index last. Originals are the retained backup.
 * Exclusive destination creates and a write-ahead journal make retries safe even
 * after a process crash. A completed journal never reimports deleted records. */
export function migrateWorkFolder(vault: VaultManager, req: WorkFolderMigration, lockIndex: <T>(rel: string, fn: () => Promise<T>) => Promise<T>): Promise<WorkFolderMigrationResult> {
  const root = req.expectedRoot
  const key = `${root}\0${req.target}`
  const run = async (): Promise<WorkFolderMigrationResult> => {
    const check = (): void => { if (!root || vault.getRoot() !== root) throw Error('Vault changed before migration') }
    check()
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(req.id)) throw Error('Invalid migration id')
    relative(req.source); relative(req.target)
    if (req.source.includes('/') || !req.target.startsWith('Plugins/') || req.target.split('/').length !== 2) throw Error('Invalid upgrade folders')
    const journalRel = `.forsion/plugin-migrations/${req.id}.json`
    const journalPath = await safePath(root, journalRel)
    const previous = await read(journalPath)
    if (previous) {
      const journal = JSON.parse(previous) as Journal
      if (journal.version !== 1 || journal.target !== req.target) throw Error('Migration journal mismatch')
      if (journal.complete) return { status: 'complete', backup: journal.source }
      if (req.plan && journal.source !== req.source) throw Error('Interrupted migration uses another source')
      const indexRel = `${req.target}/${relative(journal.index.path)}`
      const current = await read(await safePath(root, indexRel))
      if (current === journal.index.after) {
        for (const file of journal.files) if (await hashFile(await safePath(root, `${req.target}/${relative(file.path)}`)) !== file.hash) throw Error('Interrupted migration needs recovery')
        check(); await atomic(journalPath, JSON.stringify({ ...journal, complete: true }))
        return { status: 'complete', backup: journal.source }
      }
      if (current !== journal.index.before) throw Error('Migration index changed; original data retained')
    }
    if (!req.plan) return { status: 'needed' }
    const plan = req.plan, indexPath = relative(plan.index.path)
    if (typeof plan.index.after !== 'string' || (plan.index.before !== null && typeof plan.index.before !== 'string')) throw Error('Invalid migration index')
    const edits = new Map(plan.edits.map(edit => [relative(edit.path), edit]))
    if (edits.size !== plan.edits.length || !edits.has(indexPath) || edits.get(indexPath)!.after !== plan.index.after) throw Error('Invalid migration edits')
    const original = await snapshot(root, req.source)
    for (const rel of plan.requiredFiles ?? []) {
      relative(rel)
      if (!original.some(file => file.path === rel) || !(await fs.stat(await safePath(root, `${req.source}/${rel}`))).size) throw Error(`Missing migration asset: ${rel}`)
    }
    for (const [rel, edit] of edits) {
      if (typeof edit.before !== 'string' || typeof edit.after !== 'string' || !original.some(f => f.path === rel && f.hash === digest(edit.before))) throw Error('Migration source changed')
    }
    const indexRel = `${req.target}/${indexPath}`
    const files = original.filter(f => f.path !== indexPath).map(f => ({ path: f.path, hash: edits.has(f.path) ? digest(edits.get(f.path)!.after) : f.hash }))
    const journal: Journal = { version: 1, complete: false, source: req.source, target: req.target, index: plan.index, files }
    check()
    if (await read(await safePath(root, indexRel)) !== plan.index.before) throw Error('Migration target index changed')
    await atomic(journalPath, JSON.stringify(journal))
    for (const file of files) {
      check()
      const src = await safePath(root, `${req.source}/${file.path}`), dst = await safePath(root, `${req.target}/${file.path}`)
      await fs.mkdir(path.dirname(dst), { recursive: true })
      const temp = `${dst}.${randomUUID()}.tmp`
      try {
        const edit = edits.get(file.path)
        if (edit) await fs.writeFile(temp, edit.after, { flag: 'wx' })
        else await fs.copyFile(src, temp, constants.COPYFILE_EXCL)
        try { await fs.link(temp, dst) } catch (error: any) { if (error.code !== 'EEXIST') throw error }
      } finally { await fs.rm(temp, { force: true }) }
      if (await hashFile(await safePath(root, `${req.target}/${file.path}`)) !== file.hash) throw Error(`Migration file conflict: ${file.path}`)
    }
    if (JSON.stringify(await snapshot(root, req.source)) !== JSON.stringify(original)) throw Error('Migration source changed during copy')
    await lockIndex(indexRel, async () => {
      check()
      if (await read(await safePath(root, indexRel)) !== plan.index.before) throw Error('Migration target index changed')
      for (const file of files) if (await hashFile(await safePath(root, `${req.target}/${file.path}`)) !== file.hash) throw Error('Migration target changed during copy')
      check()
      // Capture the destination before the await: a later vault switch cannot redirect this write.
      await atomic(await safePath(root, indexRel), plan.index.after)
      await atomic(journalPath, JSON.stringify({ ...journal, complete: true }))
    })
    if (vault.getRoot() === root) vault.reportCopiedFiles([...files.map(f => `${req.target}/${f.path}`), indexRel])
    return { status: 'complete', backup: req.source }
  }
  const job = (chains.get(key) ?? Promise.resolve()).then(run, run)
  const tail = job.catch(() => {})
  chains.set(key, tail)
  void tail.then(() => { if (chains.get(key) === tail) chains.delete(key) })
  return job
}
