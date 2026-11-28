/** 智库同步 v2 的错误码 → 一句人话(设置 › 同步、入口、汇总卡共用)。E 的码见 Extend src/desktop/sync/{ipc,pair,bindings}.ts。 */
import { ipcErrorText } from '../../ipcError'
import '../../components/syncSettingsMessages'
import { TARGET_ERROR_CODES, targetErrorKey } from './targets'

type T = (key: string, vars?: Record<string, unknown>) => string
/** E 抛的错误码(`Error('xxx')` 经两层信封后可能带前缀)→ 一句人话。 */
const OVERLAP = new Set(['root_nested', 'primary_exists', 'folder_target_nested', 'mirror_root'])
/** inUseBy:remote_dir_in_use 时占着那个目录的(E-17,VsResult 带出来的)。source = remotesync:原来的网盘同步占着(E-19);
 *  takeover:占着的那条是接手旧同步时建的,用户停不掉(E-19 第 4 件),不叫人去停它。 */
export function syncErrorText(err: string, t: T, name = '', inUseBy?: { name: string; source?: string; takeover?: boolean }): string {
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
  // 退回(契约 H-14):在途那一轮先跑完;接手已完成不能退;旧同步的配置读不了 / 它的库文件夹找不到时不知道封口归谁,拒绝
  if (code === 'takeover_round_running') return t('ssync.err.takeoverRoundRunning')
  if (code === 'nothing_to_revert') return t('ssync.err.nothingToRevert')
  if (code === 'legacy_config_unreadable') return t('ssync.err.legacyConfigUnreadable')
  if (code === 'legacy_root_unavailable') return t('ssync.err.legacyRootUnavailable')
  // 点退回时接手刚好做完:新同步已停用(不替用户开回去),这一行的开关就是重新开启的入口
  if (code === 'takeover_finished') return t('ssync.err.takeoverFinished')
  if (code === 'legacy_config_changed') return t('ssync.err.legacyConfigChanged')
  if (code === 'binding_not_found') return t('ssync.err.bindingGone')
  if (code === 'deletes_changed') return t('ssync.err.deletesChanged')
  if (code === 'binding_not_running') return t('ssync.err.notRunning')
  if (code === 'remote_dir_nested') return t('ssync.err.remoteDirNested')
  if (code === 'remote_dir_in_use') {
    if (inUseBy?.source === 'remotesync') return inUseBy.name ? t('ssync.err.legacyInUse', { name: inUseBy.name }) : t('ssync.err.legacyInUseAnon')
    if (inUseBy?.name && inUseBy.takeover) return t('ssync.err.remoteDirInUseTakeover', { name: inUseBy.name })
    return inUseBy?.name ? t('ssync.err.remoteDirInUse', { name: inUseBy.name }) : t('ssync.err.remoteDirInUseAnon')
  }
  if (code === 'direction_forbids') return t('ssync.err.directionForbids')
  // 换去处(含蓬洲云 ↔ 网盘 / 文件夹,Extend #140、契约 E-16 附)的拒绝码;not_signed_in / takeover_in_progress 用上面那两句
  if (code === 'compat_mode') return t('ssync.err.compatMode')
  if (code === 'move_in_progress') return t('ssync.err.moveBusy')
  if (code === 'retarget_in_progress') return t('ssync.err.retargetBusy')
  if (code === 'unbind_in_progress' || code === 'unbinding_in_progress') return t('ssync.err.unbindBusy')
  if (code === 'binding_not_active') return t('ssync.err.notActive')
  if (code === 'first_round_in_progress') return t('ssync.err.firstRound')
  if (code === 'backup_remote_only') return t('ssync.err.backupRemoteOnly')
  if (code === 'already_local') return t('ssync.err.alreadyLocal')
  if (OVERLAP.has(code)) return t('ssync.err.overlap')
  // 网盘 / 本地文件夹去处的宿主码(预演 open() 时抛上来的):同一套人话
  if ((TARGET_ERROR_CODES as readonly string[]).includes(code)) return t(targetErrorKey(code))
  return t('ssync.err.generic', { error: ipcErrorText(err) })
}
