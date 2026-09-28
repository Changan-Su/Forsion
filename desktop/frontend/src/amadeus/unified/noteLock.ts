/** 锁定页面(评审 C-07)的切换动作:锁定态进 UnifiedPage 的 key,切换 = 换一个实例重挂。
 *
 *  换实例前两步必须**都成功**才许切(Codex 复核 P1):①本路径待写严格落盘 —— 非严格冲洗会把写失败吞进保存链、
 *  照常返回,旧实例随即被卸载,它的退避重试也跟着没了;②读到盘上现文 —— 读不到就只能拿打开那一刻的旧路由快照
 *  重挂,锁定页显示旧正文。任一步失败:保留当前实例、不切锁定态,出一条带「重试」的提示。 */
import { amadeus } from '../api'
import { flushUnifiedPath } from './lifecycle'
import { writeNoteLocked } from './viewMemory'
import { emitAmadeusToast, shortWriteError } from './writeSafety'
import { registerMessages, translate } from '../../i18n'

registerMessages({
  'unilock.failed.lock': {
    zh: '没能锁定「{name}」：{reason}。页面保持原样，内容没有丢。',
    en: 'Couldn’t lock "{name}": {reason}. The page is unchanged and nothing was lost.',
  },
  'unilock.failed.unlock': {
    zh: '没能解锁「{name}」：{reason}。页面保持锁定。',
    en: 'Couldn’t unlock "{name}": {reason}. The page stays locked.',
  },
  'unilock.failed.save': { zh: '还有改动没保存下来（{err}）', en: 'some changes couldn’t be saved ({err})' },
  'unilock.failed.read': { zh: '读不到这篇笔记的最新内容', en: 'the latest version of the note couldn’t be read' },
  'unilock.retry': { zh: '重试', en: 'Retry' },
})

export type RemountRead = { ok: true; raw: string } | { ok: false; reason: string }

/** 换实例前的准备:本路径待写严格落盘 + 读到盘上现文。失败给出可展示的原因。 */
export async function readForRemount(path: string): Promise<RemountRead> {
  try {
    await flushUnifiedPath(path, true)
  } catch (e) {
    return { ok: false, reason: translate('unilock.failed.save', { err: shortWriteError(e) }) }
  }
  const raw = await amadeus.readTextFile(path).catch(() => null)
  return raw == null ? { ok: false, reason: translate('unilock.failed.read') } : { ok: true, raw }
}

const noteName = (p: string): string => (p.split('/').pop() ?? p).replace(/\.md$/i, '')

export function toastLockFailed(path: string, on: boolean, reason: string, retry: () => void): void {
  emitAmadeusToast({
    level: 'error',
    dedupeKey: `amx-lock:${path}`,
    text: translate(on ? 'unilock.failed.lock' : 'unilock.failed.unlock', { name: noteName(path), reason }),
    action: { label: translate('unilock.retry'), run: retry },
  })
}

/** 锁 / 解锁(⋯ 菜单、锁定条的「解锁」)。准备成功才写本机锁定态(各标签据此换实例);失败保留原状并提示重试。 */
export async function switchNoteLock(vaultRoot: string | null | undefined, path: string, on: boolean): Promise<boolean> {
  const r = await readForRemount(path)
  if (!r.ok) {
    toastLockFailed(path, on, r.reason, () => { void switchNoteLock(vaultRoot, path, on) })
    return false
  }
  writeNoteLocked(vaultRoot, path, on)
  return true
}
