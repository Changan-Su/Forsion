/**
 * 云同步·纯决策核心:给定某路径的三方状态(本地文件 hash / shadow 基线 / 服务端 seq+hash),
 * 判定该做什么。无 IO、无副作用 —— 单测在 reconcile.test.ts 铺满判定矩阵。
 *
 * 语义约定(与计划一致):
 * - LWW + 冲突副本:双方都动过且内容不同 → 服务端版本落原路径,本地版本存冲突副本(绝不静默丢);
 * - 编辑胜删除:一端删、另一端改 → 保留改动(拉回或推回);
 * - shadow 即墓碑知识源:在 shadow 但服务端没有 = 云端已删;不在 shadow 的本地文件 = 本地新增。
 */

export interface ShadowEntry {
  /** 服务端 per-file CAS 版本号(上次同步确认时)。 */
  seq: number
  /** 上次同步确认的内容 sha256(hex)。 */
  hash: string
  /** 本地文件当时的 stat,用于扫描时跳过未变文件(不匹配才重新读 hash)。 */
  size: number
  mtimeMs: number
}

export interface RemoteInfo {
  seq: number
  /** 服务端 content_hash;理论上恒有值,null 视作未知(永不与本地相等)。 */
  hash: string | null
}

export type Decision =
  | { kind: 'none' }
  /** 内容已一致,只需把服务端 seq/hash 记进 shadow。 */
  | { kind: 'adopt' }
  | { kind: 'pull' }
  | { kind: 'push'; baseSeq: number }
  | { kind: 'pushCreate' }
  | { kind: 'pushDelete' }
  | { kind: 'deleteLocal' }
  | { kind: 'dropShadow' }
  /** 双方都动了且内容不同:服务端赢原路径,本地内容另存冲突副本再推。 */
  | { kind: 'conflict' }

/** 三方对账判定。local = 本地当前内容 hash(文件不存在传 null)。 */
export function decide(
  local: string | null,
  shadow: ShadowEntry | null,
  remote: RemoteInfo | null,
): Decision {
  if (local === null && shadow === null && remote === null) return { kind: 'none' }

  if (remote === null) {
    // 服务端没有:要么从未上云,要么云端已删(shadow 区分两者)。
    if (local === null) return shadow ? { kind: 'dropShadow' } : { kind: 'none' }
    if (!shadow) return { kind: 'pushCreate' }
    return local === shadow.hash
      ? { kind: 'deleteLocal' } // 本地未动 → 云端删除生效
      : { kind: 'pushCreate' } // 本地改过 → 编辑胜删除,重新上云
  }

  if (local === null) {
    // 本地没有:要么本地删了,要么从未拉下。
    if (!shadow) return { kind: 'pull' }
    return remote.seq === shadow.seq
      ? { kind: 'pushDelete' } // 服务端自基线未动 → 本地删除生效
      : { kind: 'pull' } // 服务端改过 → 编辑胜删除,拉回
  }

  // 双方都有。
  if (!shadow) {
    // 从未同步过的同路径文件(首次配对/shadow 丢失)。
    return local === remote.hash ? { kind: 'adopt' } : { kind: 'conflict' }
  }
  const localDirty = local !== shadow.hash
  const remoteMoved = remote.seq !== shadow.seq
  if (!localDirty && !remoteMoved) return { kind: 'none' }
  if (!localDirty) return { kind: 'pull' }
  if (!remoteMoved) return { kind: 'push', baseSeq: shadow.seq }
  if (local === remote.hash) return { kind: 'adopt' }
  // 远端 seq 动了但内容仍是我们的基线:别的设备把同样的字节原样重写了一遍,或改过又改回了基线。
  // 两种都按「远端相对基线无变化」处理 —— 与 diff3(ours, base, theirs=base) = ours 同一结论,只是省掉
  // 拿不到 base 时退化成冲突副本的那一步。语义上只看终态字节,不看中间版本(Codex 09-22 评审点出:
  // 若产品要「回退意图压过本地改动」,那是另一套协议,这里刻意不做)。
  if (remote.hash === shadow.hash) return { kind: 'push', baseSeq: remote.seq }
  return { kind: 'conflict' }
}

import { diff3Merge } from 'node-diff3'

/** diff3 行级三方合并;有冲突块 → null(绝不把冲突标记写进笔记)。 */
export function mergeText3(ours: string, base: string, theirs: string): string | null {
  const regions = diff3Merge(ours.split('\n'), base.split('\n'), theirs.split('\n'), { excludeFalseConflicts: true })
  const out: string[] = []
  for (const r of regions as Array<{ ok?: string[]; conflict?: unknown }>) {
    if (r.conflict) return null
    if (r.ok) out.push(...r.ok)
  }
  return out.join('\n')
}

/** 删除保护阈值:全量对账计划里的删除数是否大到必须人工确认。
 *  ponytail: 双规则(绝对 200 / 已跟踪数的半数且 ≥5);误挡 = 状态条一次「确认删除」。 */
export function shouldTripMassDelete(delCount: number, tracked: number, absMax = 200): boolean {
  return delCount >= absMax || (tracked >= 5 && delCount >= Math.max(5, Math.ceil(tracked / 2)))
}

/** 冲突副本路径:`a/b/Note.md` → `a/b/Note (conflict 2026-07-10 1532).md`。 */
export function conflictCopyPath(serverPath: string, now: Date): string {
  const slash = serverPath.lastIndexOf('/')
  const dir = slash < 0 ? '' : serverPath.slice(0, slash + 1)
  const base = slash < 0 ? serverPath : serverPath.slice(slash + 1)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  const p = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}${p(now.getMinutes())}`
  return `${dir}${stem} (conflict ${stamp})${ext}`
}
