/** Coding Studio 文件观察和手动源码快照。无 Electron 依赖；宿主负责 IPC 信任与运行/草稿门控。 */
import { constants, promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import chokidar, { type FSWatcher } from 'chokidar'
import type { CodeStudioProjectChange, CodeStudioRestoreSummary, CodeStudioSnapshotSummary } from '../shared/codeStudio'

export const CODE_STUDIO_SNAPSHOT_MAX_FILES = 512
export const CODE_STUDIO_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024
const MAX_DIRS = 4096
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'target', 'vendor', '__pycache__'])
const SOURCE_EXT = new Set(['.html', '.htm', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts', '.css', '.scss', '.sass', '.less', '.json', '.jsonc', '.md', '.mdx', '.txt', '.yaml', '.yml', '.toml', '.xml', '.svg', '.sql', '.graphql', '.gql', '.vue', '.svelte', '.astro', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cpp', '.hpp', '.sh', '.bash', '.zsh'])
const SOURCE_NAMES = new Set(['dockerfile', 'makefile', 'license', '.gitignore', '.editorconfig', '.prettierrc', '.eslintrc'])
const SAFE_DOTFILES = new Set(['.gitignore', '.editorconfig', '.prettierrc', '.eslintrc'])
const SENSITIVE = /(^|[._-])(secrets?|credentials?|private[-_]?key|service[-_]?account)([._-]|$)/i
// tokens.ts / tokens.css / design-tokens.json 是普通设计系统源码；只排除明确像凭据存储的 token 文件。
const TOKEN_CREDENTIAL = /^(?:(?:access|refresh|auth|oauth|api)[._-])?tokens?(?:[._-](?:cache|credentials|store))?\.(?:jsonc?|ya?ml|toml|txt|ini|conf)$/i
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const inside = (root: string, candidate: string): boolean => candidate === root || candidate.startsWith(root + path.sep)
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
const slash = (value: string): string => value.split(path.sep).join('/')

function safeRelative(value: string): boolean {
  return !!value && !/[\\:\0]/.test(value) && !value.startsWith('/') && value.split('/').every((part) => !!part && part !== '.' && part !== '..')
}

function excludedPart(name: string, last: boolean, allowDotfiles: boolean): boolean {
  const n = name.toLowerCase()
  return SKIP_DIRS.has(n) || SENSITIVE.test(n) || TOKEN_CREDENTIAL.test(n) || n === 'auth.json' || n === 'auth.toml'
    || (n.startsWith('.') && !(allowDotfiles && last && SAFE_DOTFILES.has(n)))
}

function includedPath(relative: string, allowDotfiles: boolean): boolean {
  return safeRelative(relative) && !relative.split('/').some((part, index, all) => excludedPart(part, index === all.length - 1, allowDotfiles))
}

/** 白名单只决定本功能的源码范围，不尝试把任意二进制/数据库当作文本备份。 */
export function isCodeStudioSnapshotSource(relative: string): boolean {
  if (!includedPath(relative, true)) return false
  const name = path.posix.basename(relative).toLowerCase()
  return SOURCE_NAMES.has(name) || SOURCE_EXT.has(path.posix.extname(name))
}

async function realRoot(root: string): Promise<string> {
  const real = await fs.realpath(root)
  if (!(await fs.lstat(real)).isDirectory()) throw new Error('Project root is not a directory')
  return real
}

/** 检查每一段，连根内 symlink 也拒绝。不存在的末端允许创建，但现有父级必须安全。 */
async function safeTarget(root: string, relative: string): Promise<string> {
  if (!safeRelative(relative)) throw new Error(`Unsafe snapshot path: ${relative}`)
  const rootStat = await fs.lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await fs.realpath(root) !== root) throw new Error('Project root changed')
  const parts = relative.split('/')
  let current = root
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i])
    const st = await fs.lstat(current).catch((e) => { if (missing(e)) return null; throw e })
    if (!st) continue
    if (st.isSymbolicLink()) throw new Error(`Symbolic link is not a snapshot target: ${relative}`)
    if (i < parts.length - 1 && !st.isDirectory()) throw new Error(`Parent is not a directory: ${relative}`)
  }
  return current
}

interface CapturedFile { path: string; hash: string; bytes: number; mode: number; content: Buffer }
interface SnapshotEntry { path: string; hash: string; bytes: number; mode: number }
interface SnapshotManifest { version: 1; root: string; id: string; name: string; createdAt: number; entries: SnapshotEntry[] }
const summary = (m: SnapshotManifest): CodeStudioSnapshotSummary => ({ id: m.id, name: m.name, createdAt: m.createdAt, files: m.entries.length })

/** O_NOFOLLOW 防末端软链；前后 fstat 防边读边写导致快照混入半文件。 */
async function readRegular(file: string, maxBytes = CODE_STUDIO_SNAPSHOT_MAX_BYTES): Promise<{ content: Buffer; mode: number }> {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const before = await handle.stat()
    if (!before.isFile()) throw new Error(`Not a regular source file: ${file}`)
    if (before.size > maxBytes) throw new Error(`Source snapshot exceeds the 16 MB limit: ${file}`)
    const content = await handle.readFile()
    const after = await handle.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || content.length !== after.size) throw new Error(`File changed while reading: ${file}`)
    if (content.length > maxBytes) throw new Error(`Source snapshot exceeds the 16 MB limit: ${file}`)
    return { content, mode: before.mode & 0o777 }
  } finally { await handle.close() }
}

async function captureSources(root: string): Promise<CapturedFile[]> {
  const files: CapturedFile[] = []
  let bytes = 0
  let directories = 0
  const walk = async (relative: string): Promise<void> => {
    if (++directories > MAX_DIRS) throw new Error(`Source snapshot exceeds the ${MAX_DIRS} directory scan limit`)
    const dir = relative ? await safeTarget(root, relative) : root
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name
      if (!includedPath(rel, true) || entry.isSymbolicLink()) continue
      if (entry.isDirectory()) { await walk(rel); continue }
      if (!entry.isFile() || !isCodeStudioSnapshotSource(rel)) continue
      if (files.length >= CODE_STUDIO_SNAPSHOT_MAX_FILES) throw new Error('Source snapshot exceeds the 512 file limit')
      const file = await safeTarget(root, rel)
      const { content, mode } = await readRegular(file, CODE_STUDIO_SNAPSHOT_MAX_BYTES - bytes)
      // 伪装成源码扩展名的二进制也不落快照；失败明确，不伪称完整源码已保存。
      try { if (content.includes(0)) throw new Error(); new TextDecoder('utf-8', { fatal: true }).decode(content) }
      catch { throw new Error(`Source file is not UTF-8 text: ${rel}`) }
      files.push({ path: rel, hash: digest(content), bytes: content.length, mode, content })
      bytes += content.length
    }
  }
  await walk('')
  return files
}

// 快照/恢复每真实根串行，别的项目不互相阻塞。catch 后续仍能继续，settled 后释放键。
const chains = new Map<string, Promise<unknown>>()
async function serialized<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const next = (chains.get(root) ?? Promise.resolve()).catch(() => {}).then(operation)
  chains.set(root, next)
  try { return await next } finally { if (chains.get(root) === next) chains.delete(root) }
}

/** dataDir 由宿主传 forsionHomeDir()/coding-history；函数再分桶，永远不把历史写进项目。 */
async function historyDirectory(root: string, dataDir: string): Promise<string> {
  // 先解析现有祖先再创建，避免 dataDir 的父软链指回项目时先把历史目录建进项目才发现越界。
  let ancestor = path.resolve(dataDir)
  const tail: string[] = []
  for (;;) {
    const st = await fs.lstat(ancestor).catch((e) => { if (missing(e)) return null; throw e })
    if (st) break
    tail.unshift(path.basename(ancestor))
    const parent = path.dirname(ancestor)
    if (parent === ancestor) throw new Error('Snapshot history has no existing parent directory')
    ancestor = parent
  }
  const resolved = path.join(await fs.realpath(ancestor), ...tail)
  if (inside(root, resolved)) throw new Error('Snapshot history must be outside the project')
  await fs.mkdir(resolved, { recursive: true, mode: 0o700 })
  const base = await fs.realpath(resolved)
  if (inside(root, base)) throw new Error('Snapshot history must be outside the project')
  const dir = path.join(base, digest(root))
  await fs.mkdir(dir, { mode: 0o700 }).catch((e) => { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e })
  const st = await fs.lstat(dir)
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Unsafe snapshot history directory')
  return dir
}

async function writeSnapshot(root: string, history: string, files: CapturedFile[], name?: string): Promise<SnapshotManifest> {
  const createdAt = Date.now()
  const id = `${createdAt}-${randomUUID()}`
  const temp = path.join(history, `.tmp-${id}`)
  const manifest: SnapshotManifest = {
    version: 1, root, id, name: name?.trim().slice(0, 120) || new Date(createdAt).toISOString(), createdAt,
    entries: files.map(({ path, hash, bytes, mode }) => ({ path, hash, bytes, mode })),
  }
  await fs.mkdir(temp, { mode: 0o700 })
  try {
    await fs.mkdir(path.join(temp, 'files'), { mode: 0o700 })
    const blobs = new Set<string>()
    for (const file of files) {
      if (blobs.has(file.hash)) continue
      await fs.writeFile(path.join(temp, 'files', file.hash), file.content, { flag: 'wx', mode: 0o600 })
      blobs.add(file.hash)
    }
    await fs.writeFile(path.join(temp, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 })
    await fs.rename(temp, path.join(history, id))
    return manifest
  } catch (e) {
    await fs.rm(temp, { recursive: true, force: true }).catch(() => {})
    throw e
  }
}

function validId(id: string): boolean { return /^\d{13}-[a-f0-9-]{36}$/.test(id) }

async function readManifest(root: string, history: string, id: string): Promise<SnapshotManifest> {
  if (!validId(id)) throw new Error('Invalid snapshot ID')
  const file = await safeTarget(history, `${id}/manifest.json`)
  let raw: unknown
  try { raw = JSON.parse((await readRegular(file, 256 * 1024)).content.toString('utf8')) }
  catch (e) { throw new Error(`Cannot read snapshot ${id}: ${(e as Error).message}`) }
  const m = raw as SnapshotManifest
  if (!m || m.version !== 1 || m.root !== root || m.id !== id || !Number.isFinite(m.createdAt) || m.createdAt <= 0 || typeof m.name !== 'string' || m.name.length > 120 || !Array.isArray(m.entries)) throw new Error(`Invalid snapshot manifest: ${id}`)
  if (m.entries.length > CODE_STUDIO_SNAPSHOT_MAX_FILES) throw new Error('Snapshot manifest exceeds the 512 file limit')
  const seen = new Set<string>()
  let total = 0
  for (const e of m.entries) {
    if (!e || typeof e.path !== 'string' || !isCodeStudioSnapshotSource(e.path) || seen.has(e.path) || !/^[a-f0-9]{64}$/.test(e.hash) || !Number.isSafeInteger(e.bytes) || e.bytes < 0 || !Number.isInteger(e.mode) || e.mode < 0 || e.mode > 0o777) throw new Error(`Unsafe snapshot manifest entry: ${e?.path ?? id}`)
    seen.add(e.path)
    total += e.bytes
  }
  if (total > CODE_STUDIO_SNAPSHOT_MAX_BYTES) throw new Error('Snapshot manifest exceeds the 16 MB limit')
  return m
}

export async function createCodeStudioSnapshot(root: string, dataDir: string, name?: string): Promise<CodeStudioSnapshotSummary> {
  const real = await realRoot(root)
  return serialized(real, async () => {
    const history = await historyDirectory(real, dataDir)
    return summary(await writeSnapshot(real, history, await captureSources(real), name))
  })
}

export async function listCodeStudioSnapshots(root: string, dataDir: string): Promise<CodeStudioSnapshotSummary[]> {
  const real = await realRoot(root)
  return serialized(real, async () => {
    const history = await historyDirectory(real, dataDir)
    const entries = await fs.readdir(history, { withFileTypes: true })
    const result: CodeStudioSnapshotSummary[] = []
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (!entry.isDirectory() || entry.isSymbolicLink() || !validId(entry.name)) throw new Error(`Invalid snapshot directory: ${entry.name}`)
      result.push(summary(await readManifest(real, history, entry.name)))
    }
    return result.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
  })
}

/** 捕获后的每次写/删都再次比对内容。不存在也属于状态，避免覆盖并发新建文件。 */
async function matchesCurrent(root: string, relative: string, expected?: CapturedFile): Promise<boolean> {
  try {
    const target = await safeTarget(root, relative)
    const current = await readRegular(target)
    return !!expected && current.mode === expected.mode && digest(current.content) === expected.hash
  } catch (e) { return missing(e) && !expected }
}

export async function restoreCodeStudioSnapshot(root: string, dataDir: string, id: string): Promise<CodeStudioRestoreSummary> {
  const real = await realRoot(root)
  return serialized(real, async () => {
    const history = await historyDirectory(real, dataDir)
    const manifest = await readManifest(real, history, id)
    // 在动任何项目文件之前校验所有 blob；损坏/恶意历史不会造成半恢复。
    const targetFiles = new Map<string, { entry: SnapshotEntry; content: Buffer }>()
    for (const entry of manifest.entries) {
      const blob = await safeTarget(history, `${id}/files/${entry.hash}`)
      const { content } = await readRegular(blob)
      if (content.length !== entry.bytes || digest(content) !== entry.hash) throw new Error(`Snapshot content is corrupt: ${entry.path}`)
      targetFiles.set(entry.path, { entry, content })
    }
    const currentFiles = await captureSources(real)
    const currentByPath = new Map(currentFiles.map((f) => [f.path, f]))
    const backup = await writeSnapshot(real, history, currentFiles)
    const report: CodeStudioRestoreSummary = { restored: [], deleted: [], conflicts: [], backupId: backup.id }
    const names = new Set([...currentByPath.keys(), ...targetFiles.keys()])
    for (const relative of names) {
      const expected = currentByPath.get(relative)
      const desired = targetFiles.get(relative)
      if (!await matchesCurrent(real, relative, expected)) { report.conflicts.push(relative); continue }
      if (desired && expected?.hash === desired.entry.hash && expected.mode === desired.entry.mode) continue
      try {
        const target = await safeTarget(real, relative)
        if (!desired) {
          // 再查一次紧贴 unlink；它本身不跟随末端 symlink。
          if (!await matchesCurrent(real, relative, expected)) { report.conflicts.push(relative); continue }
          await fs.unlink(target)
          report.deleted.push(relative)
          continue
        }
        await fs.mkdir(path.dirname(target), { recursive: true })
        await safeTarget(real, relative)
        const temp = path.join(path.dirname(target), `.coding-restore-${randomUUID()}`)
        try {
          await fs.writeFile(temp, desired.content, { flag: 'wx', mode: desired.entry.mode })
          await fs.chmod(temp, desired.entry.mode) // writeFile 的 mode 会受 umask 影响，恢复应保留原权限。
          // 临时文件准备期间也可能有外部写入，覆盖前重新 hash 而不只依赖 mtime。
          if (!await matchesCurrent(real, relative, expected)) { report.conflicts.push(relative); continue }
          await fs.rename(temp, target)
          report.restored.push(relative)
        } finally { await fs.rm(temp, { force: true }).catch(() => {}) }
      } catch (e) {
        throw new Error(`Restore failed for ${relative}; recovery snapshot ${backup.id}: ${(e as Error).message}`)
      }
    }
    return report
  })
}

/** 单消费者 watcher，可切项目/销毁；不使用 recursive fs.watch 的隐式软链跟随。 */
export function createCodeStudioProjectWatcher(
  onChange: (event: CodeStudioProjectChange) => void,
  onError?: (error: Error, root?: string) => void,
  options: { usePolling?: boolean } = {},
): { setRoot(root: string | null): Promise<void>; close(): void } {
  let watcher: FSWatcher | null = null
  let generation = 0
  let closed = false
  let cancelReady: (() => void) | null = null
  const clear = (): void => {
    cancelReady?.(); cancelReady = null
    const old = watcher; watcher = null
    if (old) void old.close().catch((error) => onError?.(error as Error))
  }
  return {
    async setRoot(root) {
      const gen = ++generation
      clear()
      if (!root || closed) return
      const real = await realRoot(root)
      if (gen !== generation || closed) return
      const begin = (usePolling: boolean): Promise<void> => new Promise((resolve, reject) => {
        if (gen !== generation || closed) { resolve(); return }
        const next = chokidar.watch(real, {
          // chokidar 5 的 nonpersistent native 分支漏装 error listener；用 persistent 并显式 close。
          ignoreInitial: true, followSymlinks: false, persistent: true, usePolling,
          interval: 300, binaryInterval: 1000,
          awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 30 },
          ignored: (candidate, stat) => {
            if (candidate === real) return false
            const rel = slash(path.relative(real, candidate))
            return !includedPath(rel, false) || !!stat?.isSymbolicLink()
          },
        })
        watcher = next
        let settled = false
        const finish = (error?: Error): void => {
          if (settled) return
          settled = true
          if (watcher === next) cancelReady = null
          if (error) reject(error); else resolve()
        }
        cancelReady = () => finish()
        next.on('all', (_event, candidate) => {
          if (gen !== generation || closed || watcher !== next) return
          const rel = slash(path.relative(real, candidate))
          if (rel && !includedPath(rel, false)) return
          void (rel ? safeTarget(real, rel) : Promise.resolve(real)).then(() => {
            if (gen === generation && !closed && watcher === next) onChange({ root: real, path: rel || null })
          }).catch(() => {})
        })
        next.once('ready', () => {
          if (watcher !== next || gen !== generation || closed) return
          finish()
          // Native → polling 的交接间隙可能错过文件事件；就绪后主动要求一次重扫。
          if (usePolling && gen === generation && !closed && watcher === next) onChange({ root: real, path: null })
        })
        next.on('error', (error) => {
          if (gen !== generation || closed || watcher !== next) return
          const err = error instanceof Error ? error : new Error(String(error))
          watcher = null
          if (!usePolling && ['EMFILE', 'ENOSPC', 'ENOSYS'].includes((err as NodeJS.ErrnoException).code || '')) {
            // 资源上限/不支持原生观察时有界降级，不把静态文件树伪装成实时状态。
            void next.close().then(() => begin(true), (e: Error) => {
              if (gen === generation && !closed) onError?.(e, real)
              throw e
            }).then(() => finish(), (e: Error) => finish(e))
          } else {
            void next.close().catch(() => {})
            onError?.(err, real)
            finish(err)
          }
        })
      })
      await begin(options.usePolling ?? false)
    },
    close() { closed = true; generation++; clear() },
  }
}
