/**
 * 同步引擎(Forsion 自研,见 NOTICE.md 合规边界):plan-then-execute 全量对账。
 *
 *  scan 本地(hash,带 stat 缓存)+ walk 远端 → 每 key 三方 decide → 计划 → 安全闸 → 执行。
 *
 * 安全性质:
 *  - 冲突/首次合流不同内容:本地版存冲突副本(独占创建,撞名递增),远端版落原路径 → 多设备一轮收敛
 *  - 删除闸:批量删除挂起(pendingDeletions),其余操作照常;确认后 allowMassDelete 重跑放行
 *  - 执行前重验(stale-plan guard):pull 覆盖前 / deleteLocal 前重查本地,scan 后被用户改过 → 不盲动
 *  - 任何单文件失败只记 errors、不更新该 key 基线 → 下轮重derive收敛;基线最后统一落盘(崩溃幂等)
 */
import { promises as fs, createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { decide } from './decide'
import { compileIgnore } from './ignore'
import { walkLocalFiles, atomicWrite, sha256, type LocalFile } from './fsLocal'
import { loadPrev, savePrev } from './prevSync'
import type { PlanItem, PrevState, RemoteEntity, SyncOptions, SyncReport } from './types'

const DEFAULT_MAX_FILE = 100 * 1024 * 1024
const MASS_DELETE_ABS = 200
const WALK_TIMEOUT_MS = 120_000
const TRANSFER_TIMEOUT_MS = 300_000
const RM_TIMEOUT_MS = 60_000
const CONCURRENCY = 4

/** 与 amadeus/sync/reconcile.ts 同款阈值:绝对值 ≥200,或追踪≥5 且删除数≥max(5, 一半)。 */
export function shouldTripMassDelete(delCount: number, tracked: number, absMax = MASS_DELETE_ABS): boolean {
  if (delCount >= absMax) return true
  if (tracked >= 5 && delCount >= Math.max(5, Math.ceil(tracked / 2))) return true
  return false
}

/** `Note.md` → `Note (conflict 2026-07-20 1530).md`(n≥2 加 `-n`)。 */
export function conflictCopyName(relPath: string, now: Date, n = 1): string {
  const dir = path.posix.dirname(relPath)
  const base = path.posix.basename(relPath)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  const p = (x: number): string => String(x).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}${p(now.getMinutes())}`
  const suffix = n === 1 ? '' : `-${n}`
  const name = `${stem} (conflict ${stamp}${suffix})${ext}`
  return dir === '.' ? name : `${dir}/${name}`
}

function hashFile(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(absPath)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')))
  })
}

/** 远端 key 安全校验:拒绝越权路径(../、绝对路径、反斜杠、NUL、空段)——远端内容不可信。
 *  长度上限 512 与 Penzor 服务端 isSafePath 同一口径(超限文件不参与同步,而非推到一半被拒)。 */
export function isSafeKey(key: string): boolean {
  if (!key || key.length > 512) return false
  if (key.includes('\\') || key.includes('\0') || key.startsWith('/')) return false
  return key.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
}

/** 读文件;只把 ENOENT 当"不存在",其他错误(权限/IO)必须抛——吞掉会把没读成的文件误判为可删。 */
async function readIfExists(abs: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(abs)
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw e
  }
}

/** 超时即 abort(信号透传后端):防"被判超时的上传仍在后台完成,盖掉后来的新版本"。 */
async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number, label: string): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await Promise.race([
      fn(ctrl.signal),
      new Promise<never>((_, reject) => {
        ctrl.signal.addEventListener('abort', () => reject(new Error(`timeout after ${ms}ms: ${label}`)), { once: true })
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++]
      await fn(item)
    }
  })
  await Promise.all(workers)
}

/** 空目录自底向上清理(非递归 rmdir,只删空的),到 root 为止。 */
async function removeEmptyDirs(absFile: string, root: string): Promise<void> {
  let dir = path.dirname(absFile)
  const stop = path.resolve(root)
  while (path.resolve(dir) !== stop && path.resolve(dir).startsWith(stop)) {
    try {
      await fs.rmdir(dir)
    } catch {
      return
    }
    dir = path.dirname(dir)
  }
}

/** 本地版让位冲突副本(独占创建防覆盖,同分钟撞名 -2/-3…)。返回副本相对路径。 */
async function materializeConflictCopy(localRoot: string, relPath: string, data: Buffer): Promise<string> {
  const now = new Date()
  for (let n = 1; n <= 50; n++) {
    const rel = conflictCopyName(relPath, now, n)
    const abs = path.join(localRoot, ...rel.split('/'))
    try {
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await fs.writeFile(abs, data, { flag: 'wx' })
      return rel
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') throw e
    }
  }
  throw new Error(`cannot materialize conflict copy for ${relPath}`)
}

export async function runSync(opts: SyncOptions): Promise<SyncReport> {
  const startedAt = Date.now()
  const report: SyncReport = {
    ok: false,
    startedAt,
    finishedAt: 0,
    pushed: 0,
    pulled: 0,
    deletedLocal: 0,
    deletedRemote: 0,
    conflicts: 0,
    skippedLarge: [],
    pendingDeletions: 0,
    errors: [],
  }
  const maxFile = opts.maxFileSize === 0 ? Number.POSITIVE_INFINITY : (opts.maxFileSize ?? DEFAULT_MAX_FILE)
  const ignored = compileIgnore(opts.ignoreGlobs)
  const rootResolved = path.resolve(opts.localRoot)
  const absOf = (key: string): string => {
    const p = path.resolve(rootResolved, ...key.split('/'))
    if (p !== rootResolved && !p.startsWith(rootResolved + path.sep)) throw new Error(`key escapes root: ${key}`)
    return p
  }
  const deleteLocalFile = opts.deleteLocalFile ?? (async (p: string) => fs.rm(p, { force: true }))

  let prev: PrevState
  const localMap = new Map<string, LocalFile & { h: string }>()
  const remoteMap = new Map<string, RemoteEntity>()
  try {
    prev = await loadPrev(opts.statePath, opts.fingerprint)

    // ── scan 本地 + hash(stat 缓存命中则免重哈希)──
    const locals = (await walkLocalFiles(opts.localRoot)).filter((f) => !ignored(f.key))
    for (const f of locals) {
      if (!isSafeKey(f.key)) {
        // 本地也可能出超长 key(readdir 出不来 ../ 与 \0,唯长度可能超):不参与同步,别推到服务端反复被拒
        report.skippedLarge.push(f.key)
        continue
      }
      const pe = prev.entries[f.key]
      const h = pe && pe.sz === f.size && pe.mt === f.mtimeMs ? pe.h : await hashFile(f.absPath)
      localMap.set(f.key, { ...f, h })
    }

    // ── walk 远端(key 不可信:越权/畸形一律拒收并留痕)──
    const walked = await withTimeout((signal) => opts.remote.walk(signal), WALK_TIMEOUT_MS, 'remote walk')
    for (const e of walked) {
      if (!isSafeKey(e.key)) {
        report.errors.push(`unsafe remote key skipped: ${JSON.stringify(e.key)}`)
        continue
      }
      if (!ignored(e.key)) remoteMap.set(e.key, e)
    }

    // 远端列表空但基线足量且本地有货:更像列举失败/远端被外力清空,绝不据此推删除。
    // 阈值≥5 与删除闸同一口径:小库删空是正常态(如仅剩 1 文件被另一设备删除),
    // 且其损失有界、走回收站可回收。远端确已重置想以本地为准重推:换个远端目录/前缀
    // (新指纹 = 首次合流,全量上推)。
    const trackedLive = Object.keys(prev.entries).filter((k) => !ignored(k))
    if (remoteMap.size === 0 && trackedLive.length >= 5 && localMap.size > 0) {
      throw new Error('remote-empty-suspicious: 远端列表为空但基线非空,已中止(远端确已重置的话,换个远端目录/前缀走首次合流)')
    }
  } catch (e) {
    report.errors.push(`setup: ${String((e as Error)?.message || e)}`)
    report.finishedAt = Date.now()
    return report
  }

  // ── 计划 ──
  const keys = new Set<string>([...localMap.keys(), ...remoteMap.keys()])
  for (const k of Object.keys(prev.entries)) if (!ignored(k)) keys.add(k)
  const plan: PlanItem[] = []
  const forgets: string[] = []
  for (const key of keys) {
    const local = localMap.get(key) ?? null
    const remote = remoteMap.get(key) ?? null
    if ((local && local.size > maxFile) || (remote && remote.size > maxFile)) {
      report.skippedLarge.push(key)
      continue
    }
    const pe = prev.entries[key]
    const d = decide(local ? { h: local.h } : null, pe ? { h: pe.h, r: pe.r } : null, remote ? { id: remote.id } : null)
    if (d === 'noop') {
      // 命中即刷新 stat 缓存(mtime 变了但内容没变的情况)
      if (local && pe && (pe.sz !== local.size || pe.mt !== local.mtimeMs)) {
        prev.entries[key] = { ...pe, sz: local.size, mt: local.mtimeMs }
      }
      continue
    }
    if (d === 'forget') {
      forgets.push(key)
      continue
    }
    plan.push({ key, kind: d })
  }

  // ── 方向过滤(remotely-save 式「同步方式」;单向 = 增量,绝不传播删除)──
  //  push:conflict/join 改推本地版(备份语义本地为真源;CAS 后端仍会拦截远端并发写)
  //  pull:conflict/join 保持原语义(拉远端,本地不同先出冲突副本)——本地数据不丢
  const direction = opts.direction ?? 'both'
  let directed = plan
  if (direction === 'push') {
    directed = plan
      .filter((p) => p.kind === 'push' || p.kind === 'conflict' || p.kind === 'join')
      .map((p) => (p.kind === 'push' ? p : { key: p.key, kind: 'push' as const }))
  } else if (direction === 'pull') {
    directed = plan.filter((p) => p.kind === 'pull' || p.kind === 'conflict' || p.kind === 'join')
  }

  // ── 删除闸:挂起本轮全部删除,其余照常(tracked 只数未被忽略的基线,防忽略规则稀释比例闸)──
  const delItems = directed.filter((p) => p.kind === 'deleteLocal' || p.kind === 'pushDelete')
  const tracked = Object.keys(prev.entries).filter((k) => !ignored(k)).length
  const tripped = !opts.allowMassDelete && shouldTripMassDelete(delItems.length, tracked)
  const executable = tripped ? directed.filter((p) => p.kind !== 'deleteLocal' && p.kind !== 'pushDelete') : directed
  if (tripped) report.pendingDeletions = delItems.length

  if (opts.dryRun) {
    for (const key of forgets) delete prev.entries[key]
    report.plan = directed
    report.ok = true
    report.finishedAt = Date.now()
    return report
  }

  // ── 执行 ──
  let done = 0
  const total = executable.length
  const bump = (key: string): void => {
    done++
    opts.onProgress?.(done, total, key)
  }

  const concurrency = Math.min(16, Math.max(1, Math.floor(opts.concurrency ?? CONCURRENCY)))
  await runPool(executable, concurrency, async (item) => {
    const { key, kind } = item
    const abs = absOf(key)
    try {
      if (kind === 'push') {
        const data = await fs.readFile(abs)
        const h = sha256(data)
        // 条件写:远端在场 → 期望还是基线身份;远端缺席(首推/编辑赢删除复活)→ 期望不存在(create)。
        // 哑后端忽略该参;CAS 后端(Penzor)据此把 walk→push 窗口的并发写变成 409 而非静默覆盖。
        const expectedId = remoteMap.get(key) ? (prev.entries[key]?.r ?? null) : null
        const ent = await withTimeout(
          (signal) => opts.remote.writeFile(key, data, localMap.get(key)?.mtimeMs ?? Date.now(), signal, expectedId),
          TRANSFER_TIMEOUT_MS,
          `push ${key}`,
        )
        const st = await fs.stat(abs).catch(() => null)
        prev.entries[key] = { h, r: ent.id, sz: data.byteLength, mt: st ? Math.floor(st.mtimeMs) : (localMap.get(key)?.mtimeMs ?? 0) }
        report.pushed++
      } else if (kind === 'pull') {
        const remote = remoteMap.get(key)!
        const data = await withTimeout((signal) => opts.remote.readFile(key, signal), TRANSFER_TIMEOUT_MS, `pull ${key}`)
        // stale-plan guard:scan 之后本地被改/新建(内容与计划所见不符)→ 本地版先存冲突副本;
        // scan 时本地不存在(scanned 为空)而现在有文件 = 执行窗口里新建的,同样必须让副本
        const scanned = localMap.get(key)
        const cur = await readIfExists(abs)
        if (cur && sha256(cur) !== (scanned?.h ?? null)) {
          await materializeConflictCopy(opts.localRoot, key, cur)
          report.conflicts++
        }
        await atomicWrite(abs, data, remote.mtimeMs)
        const st = await fs.stat(abs)
        prev.entries[key] = { h: sha256(data), r: remote.id, sz: data.byteLength, mt: Math.floor(st.mtimeMs) }
        report.pulled++
      } else if (kind === 'pushDelete') {
        await withTimeout((signal) => opts.remote.rm(key, signal, prev.entries[key]?.r ?? null), RM_TIMEOUT_MS, `rm ${key}`)
        delete prev.entries[key]
        report.deletedRemote++
      } else if (kind === 'deleteLocal') {
        // stale-plan guard:重验本地仍与基线一致才删;被改过 → 留给下轮重derive(会变成 conflict/push);
        // 读失败(非 ENOENT)会 throw 记 errors,绝不把"读不了"当"可删"
        const pe = prev.entries[key]
        const cur = await readIfExists(abs)
        if (cur === null || (pe && sha256(cur) === pe.h)) {
          await deleteLocalFile(abs)
          await removeEmptyDirs(abs, opts.localRoot)
          delete prev.entries[key]
          report.deletedLocal++
        }
      } else if (kind === 'join' || kind === 'conflict') {
        const remote = remoteMap.get(key)!
        const data = await withTimeout((signal) => opts.remote.readFile(key, signal), TRANSFER_TIMEOUT_MS, `pull ${key}`)
        const cur = await readIfExists(abs)
        if (cur && sha256(cur) === sha256(data)) {
          // 内容其实一致 → 收敛基线即可
          const st = await fs.stat(abs)
          prev.entries[key] = { h: sha256(data), r: remote.id, sz: data.byteLength, mt: Math.floor(st.mtimeMs) }
        } else {
          if (cur) {
            await materializeConflictCopy(opts.localRoot, key, cur)
            report.conflicts++
          }
          await atomicWrite(abs, data, remote.mtimeMs)
          const st = await fs.stat(abs)
          prev.entries[key] = { h: sha256(data), r: remote.id, sz: data.byteLength, mt: Math.floor(st.mtimeMs) }
          report.pulled++
        }
      }
    } catch (e) {
      report.errors.push(`${kind} ${key}: ${String((e as Error)?.message || e)}`)
    }
    bump(key)
  })

  for (const key of forgets) delete prev.entries[key]

  try {
    await savePrev(opts.statePath, prev)
  } catch (e) {
    report.errors.push(`save state: ${String((e as Error)?.message || e)}`)
  }

  report.ok = report.errors.length === 0
  report.finishedAt = Date.now()
  return report
}
