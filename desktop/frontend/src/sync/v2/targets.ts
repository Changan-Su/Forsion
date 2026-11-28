/**
 * 「同步到哪」的网盘 / 本地文件夹去处(智库同步第 2 步;宿主接缝 window.remoteSync.targets,契约 H-1 第 4 条、H-9)。
 * 凭据只在主进程:这里只拿去处摘要(id / 种类 / 名字 / 基础目录),Dropbox、Google Drive 的授权整条由宿主做完。
 * 旧主进程没有 targets / authStart:列不出就当「不知道」(null),界面不给加去处的入口,不当成「没有去处」。
 */
import type { SyncTargetSummary } from '../../types'
import type { BindingView, PreviewTarget } from './types'

export type TargetKind = SyncTargetSummary['kind']
export type AuthKind = 'dropbox' | 'gdrive'
export type AuthEvent = { attempt: string; ok: true; target: SyncTargetSummary; account: string } | { attempt: string; ok: false; error: string }

const api = () => (typeof window !== 'undefined' ? window.remoteSync?.targets : undefined)

/** 宿主有没有去处接缝(列 / 存)。 */
export const hasTargets = (): boolean => typeof api()?.list === 'function' && typeof api()?.save === 'function'
/** 宿主能不能在这里授权网盘(H-9;旧主进程没有)。 */
export const canAuth = (): boolean => typeof api()?.authStart === 'function' && typeof api()?.onAuth === 'function'

/** 列去处;读不到 = null(不知道),不给 []。 */
export async function listTargets(): Promise<SyncTargetSummary[] | null> {
  const a = api()
  if (!a?.list) return null
  try { const r = await a.list(); return Array.isArray(r) ? r : null } catch { return null }
}

/** 加一个本地文件夹去处。成功回摘要;失败回宿主的错误码(folder-overlaps-vault 等)。 */
export async function addFolderTarget(dir: string): Promise<{ ok: true; target: SyncTargetSummary } | { ok: false; error: string }> {
  const a = api()
  if (!a?.save) return { ok: false, error: 'no-targets' }
  try { return { ok: true, target: await a.save({ kind: 'folder', section: { path: dir } }) } } catch (e) { return { ok: false, error: codeOf(e) } }
}

export async function startAuth(kind: AuthKind, opts?: { id?: string }): Promise<{ ok: true; attempt: string; mode: 'auto' | 'manual' } | { ok: false; error: string }> {
  const a = api()
  if (!a?.authStart) return { ok: false, error: 'no-auth' }
  try { return await a.authStart(kind, opts) } catch (e) { return { ok: false, error: codeOf(e) } }
}
export async function finishAuth(attempt: string, code: string): Promise<{ ok: boolean; error?: string }> {
  try { return (await api()?.authFinish?.(attempt, code)) ?? { ok: false, error: 'no-auth' } } catch (e) { return { ok: false, error: codeOf(e) } }
}
export function cancelAuth(attempt: string): void { void api()?.authCancel?.(attempt)?.catch(() => {}) }
export function onAuth(cb: (ev: AuthEvent) => void): () => void { return api()?.onAuth?.(cb) ?? (() => {}) }

/** IPC 抛出来的是「Error invoking remote method '…': Error: folder-overlaps-vault」:取最后那个码。 */
export function codeOf(e: unknown): string {
  const s = String((e as Error)?.message ?? e)
  const m = /([a-z][a-z0-9]*(?:[-_][a-z0-9]+)+)\s*$/.exec(s)
  return m ? m[1]! : 'unknown'
}

/** 宿主 / 授权的固定错误码 → 文案键;认不得的码不露键名(H-9 第 5 条:错误只回固定码,文案在 U 包)。 */
export const TARGET_ERROR_CODES = [
  'folder-overlaps-vault', 'bad-target-dir', 'target-dir-missing', 'target-config-incomplete', 'invalid-target', 'no-such-target',
  'save-failed', 'target-location-changed', 'target-not-found', 'target-kind-changed', 'bad-target-kind',
  'no-app-key', 'no-client-id', 'loopback-unavailable', 'open-browser-failed',
  'auth-superseded', 'auth-cancelled', 'auth-timeout', 'auth-denied', 'auth-state-mismatch', 'auth-failed', 'auth-exchange-failed', 'auth-not-started',
  'dropbox-not-connected', 'gdrive-not-connected', 'no-targets', 'no-auth',
] as const
export function targetErrorKey(code: string): string {
  return (TARGET_ERROR_CODES as readonly string[]).includes(code) ? `ssync.targetErr.${code}` : 'ssync.targetErr.unknown'
}

/** 预演用的去处:改范围 / 重新同步时沿用绑定此刻的去处(网盘那一行不能按蓬洲云去预演)。 */
export function previewTargetOf(b: BindingView): PreviewTarget {
  return b.target.kind === 'remote'
    ? { kind: 'remote', targetId: b.target.targetId, dir: b.target.dir, direction: b.target.direction }
    : { kind: 'penzor' }
}

/** 这一行此刻选的是哪个去处:'penzor' 或网盘的 targetId。 */
export const currentTargetKey = (b: BindingView | undefined): string => (b?.target.kind === 'remote' ? b.target.targetId : 'penzor')
