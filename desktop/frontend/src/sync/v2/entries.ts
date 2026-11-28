/**
 * 完整模式下左栏 / 笔记菜单 / 顶栏云按钮的同步入口(智库同步第 2 步,契约 §3.10「入口改道」):
 *   不在范围里 → 「同步这个文件夹… / 同步这篇…」:打开设置 › 同步那个库那一行,带上这一项(页面替它算关联闭包、出汇总卡);
 *   正好是范围里的一项 → 「停止同步这一项」(纯收缩,直接 setScope;去掉后一项不剩就去设置页关开关);
 *   被别的项 / 整个库盖住 → 「同步设置…」。
 * 范围以 vaultsync:status 为准(vaultSyncStore 轮询的那份 v2),不另读盘。
 */
import { usePageStore } from '@amadeus/store/pageStore'
import { translate } from '../../i18n'
import { ipcErrorText } from '../../ipcError'
import { useApp } from '../../stores/appStore'
import { refreshVaultSync, useVaultSyncRaw } from '../vaultSyncStore'
import { vaultSync } from './client'
import { useSyncMode } from './mode'
import { openSyncSettings } from './openSyncSettings'
import { removeItem, scopeCovers } from './scope'
import type { ScopeItemKind, VaultSyncStatus } from './types'
import '../../components/syncSettingsMessages'

export type EntryState = 'explicit' | 'covered' | false

function primaryOf(st: VaultSyncStatus | null, root: string | null): VaultSyncStatus['bindings'][number] | undefined {
  if (!st || !root) return undefined
  // 开没开、是不是主绑定要确知(status 缺这两个字段时由 store 用 get 补;补不上 = 不当主绑定,入口去设置页)
  return st.bindings.find((b) => b.root === root && b.enabled === true && b.role === 'primary')
}

/** 这一项在不在这个库正在同步的范围里。 */
export function entrySyncState(root: string | null, path: string, st: VaultSyncStatus | null = useVaultSyncRaw.getState().v2): EntryState {
  const b = primaryOf(st, root)
  return b ? scopeCovers(b.scope, path) : false
}

/** React 里用:跟着模式与 v2 状态重算。返回 null = 不是完整模式(调用方照旧画今天的入口)。 */
export function useV2EntrySync(root: string | null, path: string | null): EntryState | null {
  const full = useSyncMode((s) => s.mode === 'full')
  const st = useVaultSyncRaw((s) => s.v2)
  if (!full) return null
  return path ? entrySyncState(root, path, st) : false
}

export const isFullSyncNow = (): boolean => useSyncMode.getState().mode === 'full'

/** 菜单上的那句话(注册表里的 title 要在调用期求值,别在模块加载时定格)。 */
export function entryLabel(state: EntryState, kind: ScopeItemKind): string {
  if (state === 'explicit') return translate('ssync.entry.stop')
  if (state === 'covered') return translate('ssync.entry.settings')
  return translate(kind === 'folder' ? 'ssync.entry.folder' : 'ssync.entry.note')
}

/** 点了入口:正好在范围里的停掉这一项,其余去设置 › 同步那一行。 */
export function runEntry(path: string, kind: ScopeItemKind): void {
  const root = usePageStore.getState().vaultRoot
  const state = entrySyncState(root, path)
  if (state === 'explicit') { void stopSyncEntry(root, path); return }
  openSyncSettings({ ...(root ? { root } : {}), ...(state ? {} : { path, kind }) })
}

/** 「停止同步这一项」:范围里去掉正好这一项(引擎认的纯收缩,不出汇总卡)。 */
export async function stopSyncEntry(root: string | null, path: string): Promise<boolean> {
  const b = primaryOf(useVaultSyncRaw.getState().v2, root)
  if (!b) return false
  const next = removeItem(b.scope, path)
  // 去掉后一项不剩:不在这里替人关掉整个库,去设置页那一行(开关在那)。
  // 去掉了还被别的项盖着(同时勾了 Work/ 和 Work/A.md):提示「已停止」是假的,也去那一行自己挑(Codex P1-2)
  if (!next || scopeCovers(next, path)) { openSyncSettings({ ...(root ? { root } : {}) }); return false }
  const r = await vaultSync.setScope(b.id, next)
  const name = (path.split('/').pop() ?? path).replace(/\.md$/i, '')
  useApp.getState().toast(r.ok ? translate('ssync.entry.stopped', { name }) : translate('ssync.entry.stopFailed', { error: r.ok ? '' : ipcErrorText(r.error) }), !r.ok)
  refreshVaultSync()
  return r.ok
}
