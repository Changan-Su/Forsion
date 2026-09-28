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
  /** 读一篇的原文;不存在 → null(跳过,不算失败)。 */
  read(path: string): Promise<string | null>
  /** 比对交换写:base = 读到那版的 textFingerprint。`{ ok:false, current }` = 盘上已变、本次没写;void / ok:true = 写成。 */
  write(path: string, text: string, base: string): Promise<void | TextWriteResult>
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
      for (let i = 0; i < attempts; i++) {
        if (raw == null) return
        const next = rewriteNoteRefs(raw, backMap.get(p) ?? p, p, plan)
        if (next === raw) return
        const r = await io.write(p, next, textFingerprint(raw))
        if (!r || r.ok) {
          out.rewritten.push(p)
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
