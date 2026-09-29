/** 笔记改名 / 移动之后的全库 `[[链接]]` 重写 —— 宿主无关的那一半(评审 G2-04)。
 *
 *  判定照 rewriteNoteRefs(纯函数,规则见那边):快照「操作前」页表,逐页「读 → 重写 → 比对交换写」。桌面主进程
 *  自带同篇写锁(vaultHandlers.propagateRenames);web / 移动端桥没有,所以这里的写一律带基线:写口把「读到时的
 *  textFingerprint」交给宿主,宿主发现盘上已不是它(编辑器刚存过 / 别的设备刚改过)就不写、交回现文,这里拿现文
 *  重算再试,有限次仍冲突 → 记入 failed。**失败必须交回调用方去提示**,不许静默吞(被重写的笔记里链接断着,用户
 *  却以为改名一切正常)。 */
import { rewriteNoteRefs, type NoteRenamePlan } from './rewriteNoteRefs'
import { textFingerprint } from './writeConflict'
import type { TextWriteResult } from './ipc'

export interface RenamePropagationIO {
  /** 读一篇的原文;不存在 → null(快照之后被删 / 挪走:它里面的链接没改成,记入 failed,不静默跳过)。 */
  read(path: string): Promise<string | null>
  /** 比对交换写:base = 读到那版的 textFingerprint。`{ ok:false, current }` = 盘上已变、本次没写;void / ok:true = 写成。
   *  'gone' = 目标已不在(读完之后被删 / 挪走):**只更新已存在的文件**,绝不按旧路径重建 —— 记入 failed(路径已变)。 */
  write(path: string, text: string, base: string): Promise<void | TextWriteResult | 'gone'>
}

export interface RenamePropagationResult {
  /** 真被改写了的笔记(调用方据此通知开着它们的编辑器回灌)。 */
  rewritten: string[]
  /** 没能改写的笔记(读 / 写抛错,或冲突重试用尽)。 */
  failed: Array<{ path: string; error: string }>
}

/** 旧 → 新(vault 相对、含 .md;文件夹操作 = 树下每页一对)+ 操作前页表 → 逐页重写。 */
export async function propagateNoteRenames(
  io: RenamePropagationIO,
  pairsIn: Record<string, string>,
  pagesBefore: readonly string[],
  opts: { concurrency?: number; attempts?: number } = {},
): Promise<RenamePropagationResult> {
  const out: RenamePropagationResult = { rewritten: [], failed: [] }
  const pairs = new Map(Object.entries(pairsIn).filter(([o, n]) => o !== n))
  if (!pairs.size) return out
  const backMap = new Map([...pairs].map(([o, n]) => [n, o]))
  const before = [...pagesBefore].sort()
  const after = before.map((p) => pairs.get(p) ?? p).sort()
  const plan: NoteRenamePlan = { pairs, pagesBefore: before, pagesAfter: after }
  const attempts = Math.max(1, opts.attempts ?? 3)

  const one = async (p: string): Promise<void> => {
    try {
      let raw = await io.read(p)
      if (raw == null) {
        out.failed.push({ path: p, error: 'gone' })
        return
      }
      for (let i = 0; i < attempts; i++) {
        const next = rewriteNoteRefs(raw, backMap.get(p) ?? p, p, plan)
        if (next === raw) return
        const r = await io.write(p, next, textFingerprint(raw))
        if (r === 'gone') {
          out.failed.push({ path: p, error: 'gone' })
          return
        }
        if (!r || r.ok) {
          out.rewritten.push(p)
          return
        }
        if (r.current == null) {
          out.failed.push({ path: p, error: 'gone' }) // 宿主报文件已不在(读完之后被删 / 挪走):同 'gone'
          return
        }
        raw = r.current // 盘上刚被别人写过:按现文重算(对方的字一个不丢),再试
      }
      out.failed.push({ path: p, error: 'conflict' })
    } catch (e) {
      out.failed.push({ path: p, error: e instanceof Error ? e.message : String(e) })
    }
  }

  // 有界并发:web 端每篇一个往返,全库串行会把改名拖到秒级以上;并发封顶免得一次改名打满连接。
  const queue = [...after]
  const workers = Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 6, queue.length)) }, async () => {
    for (let p = queue.shift(); p !== undefined; p = queue.shift()) await one(p)
  })
  await Promise.all(workers)
  out.rewritten.sort()
  return out
}

/** 会改路径 / 删东西的结构操作(改名 / 移动 / 删除 / 回收站)。 */
export const STRUCTURE_OPS = ['renamePage', 'renamePageFile', 'movePage', 'renameFolder', 'moveFolder', 'deletePage', 'deleteFolder', 'trashEntry', 'restoreTrash'] as const

/** 把桥上的结构操作排进一条**库级有序队列**(G2-04 复核 P1):一次结构变更连同它的全库链接重写跑完,下一次才开始。
 *  否则 B→C 的重写还在跑,C→D 已按「页表里没有 B」扫完 → 前一次随后写入的 [[C]] 指向已不存在的 C,静默断链。
 *  与各桥按路径的写队列分开(结构操作内部还要占路径写锁,混成一条会自锁);重写本身不经这条队列。
 *  只管本端:别的设备上的连续改名要服务端按路径身份组合,不在这里。 */
export function queueStructureOps<T extends object>(api: T): T {
  const rec = api as unknown as Record<string, unknown>
  let tail: Promise<unknown> = Promise.resolve()
  for (const k of STRUCTURE_OPS) {
    const fn = rec[k]
    if (typeof fn !== 'function') continue
    rec[k] = (...args: unknown[]): Promise<unknown> => {
      const run = tail.then(() => (fn as (...a: unknown[]) => Promise<unknown>)(...args))
      tail = run.catch(() => {})
      return run
    }
  }
  return api
}
