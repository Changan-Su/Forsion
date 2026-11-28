/** 智库同步 v2 的错误码 → 一句人话(设置 › 同步、入口、汇总卡共用)。E 的码见 Extend src/desktop/sync/{ipc,pair,bindings}.ts。 */
import { ipcErrorText } from '../../ipcError'
import '../../components/syncSettingsMessages'

type T = (key: string, vars?: Record<string, unknown>) => string
/** E 抛的错误码(`Error('xxx')` 经两层信封后可能带前缀)→ 一句人话。 */
const OVERLAP = new Set(['root_nested', 'primary_exists', 'folder_target_nested', 'mirror_root'])
export function syncErrorText(err: string, t: T, name = ''): string {
  const code = /([a-z][a-z0-9_-]+)\s*$/.exec(err)?.[1] ?? err
  if (code === 'not_signed_in') return t('ssync.err.signedOut')
  if (code === 'reserved') return t('ssync.err.reserved', { name })
  if (code === 'invalid_name') return t('ssync.err.invalidName')
  if (code === 'server_unsupported') return t('ssync.err.serverOld')
  if (code === 'entry_sync_active') return t('ssync.err.entryActive')
  if (code === 'scope_unreadable') return t('ssync.err.unreadable')
  if (code === 'stale') return t('ssync.stale')
  if (code === 'name_exists') return t('ssync.err.nameExists', { name })
  if (code === 'legacy_rename_unavailable') return t('ssync.act.renameCloudLegacy')
  if (code === 'target-location-changed') return t('ssync.targetChanged')
  if (code === 'takeover_in_progress') return t('ssync.err.takeoverBusy')
  if (code === 'binding_not_found') return t('ssync.err.bindingGone')
  if (code === 'deletes_changed') return t('ssync.err.deletesChanged')
  if (code === 'binding_not_running') return t('ssync.err.notRunning')
  if (OVERLAP.has(code)) return t('ssync.err.overlap')
  return t('ssync.err.generic', { error: ipcErrorText(err) })
}
