import type { AppUpdater, UpdateCheckResult } from 'electron-updater'
import type { UpdateInfo } from 'builder-util-runtime'
import { isRevisionUpgrade } from '../shared/releaseVersion.mjs'

/**
 * electron-updater ignores metadata before its public support/rollout callbacks.
 * Intercept only a pinned same-version +build.N upgrade and preserve both guards.
 * This isolated bridge to 6.x's private JS method is covered with the real library.
 */
export async function checkRevisionUpdate(updater: AppUpdater, current: string, target: string): Promise<UpdateCheckResult | null> {
  if (!isRevisionUpgrade(target, current)) return updater.checkForUpdates()
  const internal = updater as unknown as { isUpdateAvailable(info: UpdateInfo): Promise<boolean> }
  const original = internal.isUpdateAvailable
  if (typeof original !== 'function' || typeof updater.isUpdateSupported !== 'function' || typeof updater.isUserWithinRollout !== 'function') {
    throw new Error('This electron-updater does not support revision checks')
  }
  const check = async (info: UpdateInfo): Promise<boolean> => {
    if (info.version !== target) return original.call(updater, info)
    return !!(await updater.isUpdateSupported(info)) && !!(await updater.isUserWithinRollout(info))
  }
  internal.isUpdateAvailable = check
  try { return await updater.checkForUpdates() }
  finally { if (internal.isUpdateAvailable === check) internal.isUpdateAvailable = original }
}
