/**
 * 同步通知(智库同步第 1 步起读状态源,和左栏、面板、状态栏同一份):只在状态转移时弹,首次读到(启动 / 新出现的一路)不弹。
 *   - 一路进了「出错」:弹一次,说清哪个库、什么错
 *   - 一轮跑完多了没传上的文件:弹一次,说清是哪个文件、什么原因(一轮里陆续失败的攒到这轮结束再说,不刷屏)
 *   - 从没有到有「等你定」:弹一次
 *   - 一轮跑完(核对 / 同步 → 空闲):沿用「在线同步完成」那条(事件缺省关)
 * 远程服务那一路的通知按它的报告另弹(额度满 / 冲突副本 / 删除闸),这里跳过。
 * 状态源每秒都可能变:判定和记账放同一个纯函数,单测在 syncNotices.test.ts。
 */
import type { SyncFailure, SyncFeedPhase, SyncFeedReport, SyncTarget } from '../../../shared/vaultSync'
import { vaultReviewCount } from '../../../shared/vaultSync'

export interface FeedMemo { phase: SyncFeedPhase; failures: Set<string>; review: number }

export type SyncNotice =
  | { kind: 'error'; feed: string; vault: SyncFeedReport['vault']; error: string }
  | { kind: 'failed'; feed: string; vault: SyncFeedReport['vault']; failures: SyncFailure[]; target: SyncTarget }
  | { kind: 'review'; feed: string; vault: SyncFeedReport['vault']; n: number }
  | { kind: 'done'; feed: string; vault: SyncFeedReport['vault'] }

const running = (p: SyncFeedPhase): boolean => p === 'checking' || p === 'transferring' || p === 'starting'

export function takeSyncNotices(memo: Map<string, FeedMemo> | null, feeds: SyncFeedReport[]): { notices: SyncNotice[]; memo: Map<string, FeedMemo> } {
  const next = new Map<string, FeedMemo>()
  const notices: SyncNotice[] = []
  for (const f of feeds) {
    if (f.engine === 'remote' || f.phase === 'off') continue
    const prev = memo?.get(f.id)
    const review = vaultReviewCount(f)
    const paths = new Set(f.failures.map((x) => x.path))
    if (!prev) { next.set(f.id, { phase: f.phase, failures: paths, review }); continue } // 第一次看到:只记,不弹
    if (f.phase === 'error' && prev.phase !== 'error') notices.push({ kind: 'error', feed: f.id, vault: f.vault, error: f.error ?? '' })
    let failures = prev.failures
    if (!running(f.phase)) {
      const fresh = f.failures.filter((x) => !prev.failures.has(x.path))
      if (fresh.length) notices.push({ kind: 'failed', feed: f.id, vault: f.vault, failures: fresh, target: f.target })
      failures = paths // 好了的那几个也从记账里拿掉:之后再失败还会说
    }
    if (review > 0 && prev.review === 0) notices.push({ kind: 'review', feed: f.id, vault: f.vault, n: review })
    if (running(prev.phase) && f.phase === 'idle') notices.push({ kind: 'done', feed: f.id, vault: f.vault })
    next.set(f.id, { phase: f.phase, failures, review })
  }
  return { notices, memo: next }
}
