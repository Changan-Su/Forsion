/** v4 统一编辑器的写盘安全件(评审 2026-09-27 波次 0a:D-03 / G1-01)。
 *
 * UnifiedPage 的保存管线是「单写者、整文件覆写」—— 毁数据的缝出在「写之前不看盘上是谁的版本」:
 *  - D-03 打字中到达的外部改动:按拍板 #6 **本地胜**,但被盖掉的盘上版本必须先另存冲突副本 + error 级提示;
 *  - G1-01 同篇多开:writeTextFile 带基线指纹做比对交换写(主进程拒写就回盘上现文),陈旧实例不再盲写。
 * 这里只放**与组件状态无关**的件(命名 / 提示);状态机本身在 UnifiedPage(pipe)里。
 */
import { amadeus } from '../api'
import { conflictCopyPath, conflictCopyVariant } from '@amadeus-shared/writeConflict'
import { registerMessages, translate } from '../../i18n'

registerMessages({
  'unisave.conflict.toast': {
    zh: '「{name}」在你编辑时被别处改过。已保留你的版本，被覆盖的那一版另存为「{copy}」。',
    en: '"{name}" was changed elsewhere while you were editing. Your version was kept, and the overwritten version was saved as "{copy}".',
  },
  'unisave.conflict.open': { zh: '打开副本', en: 'Open copy' },
})

/** `amadeus:toast` 的事件载荷(编辑器层 → amadeusOverlays)。只有 text 时走底部吐司;带 level / action 的
 *  在主窗走右上角通知栈(error 常驻手动关,能挂动作钮),见 amadeusOverlays 的 onToast。 */
export interface AmadeusToastDetail {
  text: string
  level?: 'info' | 'success' | 'warning' | 'error'
  action?: { label: string; run(): void }
  dedupeKey?: string
}

export function emitAmadeusToast(detail: AmadeusToastDetail): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('amadeus:toast', { detail }))
}

const noteName = (p: string): string => (p.split('/').pop() ?? p).replace(/\.md$/i, '')

/** 把即将被本地版本盖掉的盘上内容另存为冲突副本,返回副本路径。
 *  命名与云同步引擎同一口径(shared/writeConflict):同分钟撞名按 `-2/-3…` 递增;已有**同内容**副本就直接复用
 *  (同一版本不出第二份)。写不进去就抛 —— 调用方据此**不许**覆盖原文件(宁可这次保存卡住重试,不吃掉别人的改动)。 */
export async function writeConflictCopy(path: string, content: string, now = new Date()): Promise<string> {
  const first = conflictCopyPath(path, now)
  for (let n = 1; n <= 50; n++) {
    const candidate = conflictCopyVariant(first, n)
    const existing = await amadeus.readTextFile(candidate)
    if (existing === content) return candidate
    if (existing != null) continue
    await amadeus.writeTextFile(candidate, content, { create: true })
    return candidate
  }
  throw new Error('Too many conflict copies in one minute')
}

/** D-03 / G1-01:error 级提示 + 「打开副本」。同一篇的连续冲突合并成一条(dedupeKey)。 */
export function toastConflictCopy(path: string, copy: string): void {
  emitAmadeusToast({
    level: 'error',
    dedupeKey: `amx-conflict:${path}`,
    text: translate('unisave.conflict.toast', { name: noteName(path), copy: noteName(copy) }),
    action: {
      label: translate('unisave.conflict.open'),
      // 走导航门面事件(amadeusOverlays → openNote):副本是刚写出来的新文件,按名字解析可能还没进页面清单。
      run: () => { window.dispatchEvent(new CustomEvent('amadeus:navigate-note', { detail: { path: copy }, cancelable: true })) },
    },
  })
}
