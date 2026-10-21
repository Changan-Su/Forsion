import { promises as fs, createReadStream, constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import type { WorkFolderMigration, WorkFolderMigrationResult } from '@amadeus-shared/ipc'
import type { VaultManager } from './vaultManager'
import { rebaseFileRefs } from '@amadeus-shared/assets'
import { renameAtomic } from './renameAtomic'
import { mapOutsideFences } from '@amadeus-shared/links'

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
async function syncFile(abs: string): Promise<void> {
  // Windows FlushFileBuffers requires a handle opened for writing. Never truncate.
  const file = await fs.open(abs, process.platform === 'win32' ? 'r+' : 'r')
  try { await file.sync() } finally { await file.close() }
}
async function syncParents(root: string, dir: string): Promise<void> {
  // Node cannot open directory handles for FlushFileBuffers on Windows.
  // File data is flushed there; POSIX also flushes each new directory entry.
  if (process.platform === 'win32') return
  for (let current = dir; ; current = path.dirname(current)) {
    const handle = await fs.open(current, 'r')
    try { await handle.sync() } finally { await handle.close() }
    if (current === root) break
    if (!current.startsWith(root + path.sep)) throw Error('Migration directory escapes vault')
  }
}
async function atomic(root: string, abs: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(abs), { recursive: true })
  const temp = `${abs}.${randomUUID()}.tmp`
  try {
    const file = await fs.open(temp, 'wx')
    try { await file.writeFile(text); await file.sync() } finally { await file.close() }
    await renameAtomic(temp, abs)
    await syncParents(root, path.dirname(abs))
  } finally { await fs.rm(temp, { force: true }) }
}

/** Copy first, publish the index last. Originals are the retained backup.
 * Exclusive destination creates and a write-ahead journal make retries safe even
 * after a process crash. A completed journal never reimports deleted records. */
export function migrateWorkFolder(vault: VaultManager, req: WorkFolderMigration, lockPaths: <T>(rels: string[], fn: () => Promise<T>) => Promise<T>): Promise<WorkFolderMigrationResult> {
  const root = req.expectedRoot
  const key = `${root}\0${req.target}`
  const run = async (): Promise<WorkFolderMigrationResult> => {
    const check = (): void => { if (!root || vault.getRoot() !== root) throw Error('Vault changed before migration') }
    check()
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(req.id)) throw Error('Invalid migration id')
    relative(req.source); relative(req.target)
    const validFolder = (folder: string): boolean => !folder.includes('/') || (folder.startsWith('Plugins/') && folder.split('/').length === 2)
    // Windows aliases trailing dots/spaces as well as case. Reject overlap on every host.
    const folderKey = (folder: string): string => folder.split('/').map(p => p.replace(/[ .]+$/g, '').toLowerCase()).join('/')
    const sourceKey = folderKey(req.source), targetKey = folderKey(req.target)
    if (!validFolder(req.source) || !req.target.startsWith('Plugins/') || req.target.split('/').length !== 2
      || sourceKey === targetKey || sourceKey.startsWith(targetKey + '/') || targetKey.startsWith(sourceKey + '/')) throw Error('Invalid upgrade folders')
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
        check(); await atomic(root, journalPath, JSON.stringify({ ...journal, complete: true }))
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
    // Resolve user-added bare media against the original vault. It may live beside
    // the note, in assets/, or outside this plugin; never invent an assets/ location.
    const scopeMedia = async (text: string, page: string): Promise<string> => {
      const frontmatter = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text)?.[0] ?? ''
      const body = text.slice(frontmatter.length), refs = new Map<string, string>()
      const transform = (collect: boolean): string => {
        let codeParagraph = false
        return mapOutsideFences(body, line => {
          if (!line.trim()) codeParagraph = false
          if (line.includes('`')) codeParagraph = true
          if (codeParagraph || /^(?:\t| {4})/.test(line)) return line
          return line.replace(/(!?\[\[)([^\]|#\n]+)([^\]]*\]\])/g, (all, open, ref, tail, offset: number) => {
            if (offset > 0 && line[offset - 1] === '\\') return all
            if (ref.includes('/') || ref.includes('\\') || !/\.(?:mp3|wav|ogg|m4a|flac|mp4|webm|mov|m4v)$/i.test(ref)) return all
            if (collect) { refs.set(ref, ref); return all }
            return open + (refs.get(ref) ?? ref) + tail
          })
        }, true)
      }
      transform(true)
      for (const ref of refs.keys()) {
        check(); const abs = await vault.resolveAttachment(page, ref); check()
        if (abs) refs.set(ref, moved(path.relative(root, abs).split(path.sep).join('/')))
      }
      return frontmatter + transform(false)
    }
    // Reuse the host's ordinary file-move reference semantics for Markdown.
    const moved = (rel: string): string => rel.startsWith(req.source + '/') ? req.target + rel.slice(req.source.length) : rel
    for (const file of original.filter(f => f.path.endsWith('.md'))) {
      const before = await fs.readFile(await safePath(root, `${req.source}/${file.path}`), 'utf8')
      if (digest(before) !== file.hash) throw Error('Migration source changed')
      const text = await scopeMedia(edits.get(file.path)?.after ?? before, `${req.source}/${file.path}`)
      const after = await rebaseFileRefs(text, `${req.source}/${file.path}`, `${req.target}/${file.path}`, moved, async rel => {
        const existing = rel.startsWith(req.target + '/') ? req.source + rel.slice(req.target.length) : rel
        try { return (await fs.stat(await safePath(root, existing))).isFile() }
        catch (error: any) { if (error.code === 'ENOENT') return false; throw error }
      })
      if (after !== before) edits.set(file.path, { path: file.path, before, after })
    }
    const indexRel = `${req.target}/${indexPath}`
    const files = original.filter(f => f.path !== indexPath).map(f => ({ path: f.path, hash: edits.has(f.path) ? digest(edits.get(f.path)!.after) : f.hash }))
    const journal: Journal = { version: 1, complete: false, source: req.source, target: req.target, index: plan.index, files }
    check()
    if (await read(await safePath(root, indexRel)) !== plan.index.before) throw Error('Migration target index changed')
    await atomic(root, journalPath, JSON.stringify(journal))
    for (const file of files) {
      check()
      const src = await safePath(root, `${req.source}/${file.path}`), dst = await safePath(root, `${req.target}/${file.path}`)
      await fs.mkdir(path.dirname(dst), { recursive: true })
      const temp = `${dst}.${randomUUID()}.tmp`
      try {
        const edit = edits.get(file.path)
        if (edit) await fs.writeFile(temp, edit.after, { flag: 'wx' })
        else await fs.copyFile(src, temp, constants.COPYFILE_EXCL)
        await syncFile(temp)
        try { await fs.link(temp, dst) } catch (error: any) { if (error.code !== 'EEXIST') throw error }
      } finally { await fs.rm(temp, { force: true }) }
      if (await hashFile(await safePath(root, `${req.target}/${file.path}`)) !== file.hash) throw Error(`Migration file conflict: ${file.path}`)
      await syncFile(dst); await syncParents(root, path.dirname(dst))
    }
    if (JSON.stringify(await snapshot(root, req.source)) !== JSON.stringify(original)) throw Error('Migration source changed during copy')
    await lockPaths([...original.map(f => `${req.source}/${f.path}`), ...files.map(f => `${req.target}/${f.path}`), indexRel], async () => {
      check()
      if (await read(await safePath(root, indexRel)) !== plan.index.before) throw Error('Migration target index changed')
      for (const file of files) if (await hashFile(await safePath(root, `${req.target}/${file.path}`)) !== file.hash) throw Error('Migration target changed during copy')
      if (JSON.stringify(await snapshot(root, req.source)) !== JSON.stringify(original)) throw Error('Migration source changed before publication')
      check()
      // Capture the destination before the await: a later vault switch cannot redirect this write.
      await atomic(root, await safePath(root, indexRel), plan.index.after)
      await atomic(root, journalPath, JSON.stringify({ ...journal, complete: true }))
    })
    if (vault.getRoot() === root) {
      try { vault.reportCopiedFiles([...files.map(f => `${req.target}/${f.path}`), indexRel]) }
      catch (error) { console.warn('[migration] committed; sync notification failed', error) }
    }
    return { status: 'complete', backup: req.source }
  }
  const guarded = (): Promise<WorkFolderMigrationResult> => vault.withMigrationGuard(run)
  const job = (chains.get(key) ?? Promise.resolve()).then(guarded, guarded)
  const tail = job.catch(() => {})
  chains.set(key, tail)
  void tail.then(() => { if (chains.get(key) === tail) chains.delete(key) })
  return job
}
