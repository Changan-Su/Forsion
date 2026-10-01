/** 页面版本历史(评审 C-20)的渲染层一半:恢复动作 + 文案。存储与快照在主进程(electron/amadeus/fs/pageHistory.ts)。
 *
 *  恢复 = ①本路径待写**严格**落盘并读到盘上现文(noteLock.readForRemount,同锁定页面那套)→ ②主进程按现文指纹比对、
 *  先给现文补一份快照、再原子写回选中版本(恢复本身可撤回:恢复前的内容就在历史里)→ ③本窗同路径的实例走**现有外部回灌**
 *  (announceUnifiedWrite → peerWrote → reconcile:最小差异事务、不进撤销栈,拍板 #7);别的窗口由主进程发 externalChange。
 *  不另写一套刷新,也不换 key 重挂。任一步失败:笔记保持原样,出一条带「重试」的提示。
 *  锁定页面(C-07)上只能看、不能恢复(面板里「恢复此版本」置灰并说明)。 */
import { Suspense } from 'react'
import type { PageHistoryEntry } from '@amadeus-shared/ipc'
import { textFingerprint } from '@amadeus-shared/writeConflict'
import { amadeus } from '../api'
import { registerMessages, translate } from '../../i18n'
import { formatDateTime } from '../../format/time'
import { announceUnifiedWrite } from './lifecycle'
import { readForRemount } from './noteLock'
import { emitAmadeusToast, shortWriteError } from './writeSafety'
import { lazyRetry } from '../../lazyRetry'

registerMessages({
  'pghist.menu': { zh: '版本历史', en: 'Version history' },
  'pghist.close': { zh: '关闭', en: 'Close' },
  'pghist.listLabel': { zh: '历史版本', en: 'Saved versions' },
  'pghist.loading': { zh: '正在读取…', en: 'Loading…' },
  'pghist.loadFailed': { zh: '读不到版本历史：{reason}', en: 'Couldn’t load version history: {reason}' },
  'pghist.empty': {
    zh: '还没有历史版本。编辑这篇笔记后，大约每 5 分钟会自动留一份。',
    en: 'No saved versions yet. While you edit this note, a version is kept about every 5 minutes.',
  },
  'pghist.tab.content': { zh: '内容', en: 'Content' },
  'pghist.tab.diff': { zh: '与当前对比', en: 'Compare with current' },
  'pghist.diff.current': { zh: '当前', en: 'Current' },
  'pghist.diff.version': { zh: '此版本', en: 'This version' },
  'pghist.same': { zh: '与当前内容相同。', en: 'Same as the current content.' },
  'pghist.tooLarge': { zh: '内容太大，无法对比。', en: 'Too large to compare.' },
  'pghist.previewFailed': { zh: '读不到这个版本。', en: 'This version couldn’t be read.' },
  'pghist.restore': { zh: '恢复此版本', en: 'Restore this version' },
  'pghist.restoreHint': { zh: '恢复前会先把当前内容存进版本历史。', en: 'The current content is saved to version history before restoring.' },
  'pghist.lockedHint': { zh: '页面已锁定，解锁后才能恢复。', en: 'This page is locked. Unlock it to restore a version.' },
  'pghist.confirm.title': { zh: '恢复到 {time} 的版本？', en: 'Restore the version from {time}?' },
  'pghist.confirm.msg': {
    zh: '笔记会换成这个版本的内容。当前内容会先存进版本历史，之后还能恢复回来。',
    en: 'The note will be replaced with this version. The current content is saved to version history first, so you can switch back later.',
  },
  'pghist.confirm.ok': { zh: '恢复', en: 'Restore' },
  'pghist.done': { zh: '已恢复到 {time} 的版本', en: 'Restored the version from {time}' },
  'pghist.failed': { zh: '没能恢复「{name}」：{reason}。笔记保持原样。', en: 'Couldn’t restore "{name}": {reason}. The note is unchanged.' },
  'pghist.failed.conflict': { zh: '这篇笔记刚被别处改动了', en: 'the note was just changed elsewhere' },
  'pghist.failed.gone': { zh: '这篇笔记已经不在了', en: 'the note no longer exists' },
  'pghist.retry': { zh: '重试', en: 'Retry' },
})

const noteName = (p: string): string => (p.split('/').pop() ?? p).replace(/\.md$/i, '')

function toastRestoreFailed(path: string, reason: string, retry?: () => void): void {
  emitAmadeusToast({
    level: 'error',
    dedupeKey: `amx-hist-restore:${path}`,
    text: translate('pghist.failed', { name: noteName(path), reason }),
    ...(retry ? { action: { label: translate('pghist.retry'), run: retry } } : {}),
  })
}

/** 把 path 恢复成 entry 那一版。成功 → true(调用方关面板);失败已出提示 → false。 */
export async function restorePageVersion(path: string, entry: PageHistoryEntry): Promise<boolean> {
  const restore = amadeus.restorePageHistory
  if (!restore) return false
  const retry = (): void => { void restorePageVersion(path, entry) }
  const prep = await readForRemount(path)
  if (!prep.ok) {
    toastRestoreFailed(path, prep.reason, retry)
    return false
  }
  let r: Awaited<ReturnType<typeof restore>>
  try {
    r = await restore(path, entry.id, textFingerprint(prep.raw))
  } catch (e) {
    toastRestoreFailed(path, shortWriteError(e), retry)
    return false
  }
  if (!r.ok) {
    // 盘上不是刚读到的那版 = 准备与恢复之间别处写了一发:没写,重试会重新冲洗 + 重读。文件没了就不给重试。
    if (r.current == null) toastRestoreFailed(path, translate('pghist.failed.gone'))
    else toastRestoreFailed(path, translate('pghist.failed.conflict'), retry)
    return false
  }
  announceUnifiedWrite(path, {}) // 新 owner = 本窗这篇的每个实例都回灌(发起方本来就不是哪个实例)
  emitAmadeusToast({ level: 'success', text: translate('pghist.done', { time: formatDateTime(entry.at) }) })
  return true
}

// 面板懒加载:它带着 diff2html(样式 + 渲染器),不进编辑器首包。
const PageHistoryPanel = lazyRetry(() => import('./PageHistoryPanel'))

/** 「⋯ → 版本历史」的挂载点(amadeusViews 与台架共用)。入口显隐 = v4 笔记 && canPageHistory()(amadeus/lib/hostCaps)。
 *  locked = 锁定页面(C-07):能看历史,不能恢复(锁定就是「别改它」,要恢复先解锁)。 */
export function PageHistoryHost({ path, locked, onClose }: { path: string; locked: boolean; onClose: () => void }) {
  return <Suspense fallback={null}><PageHistoryPanel path={path} locked={locked} onClose={onClose} /></Suspense>
}
