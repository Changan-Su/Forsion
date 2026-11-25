import { readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

/**
 * electron-updater(6.8.9 `AppUpdater.differentialDownloadInstaller`)做差量时,「当前版本」的 blockmap 先读更新缓存目录里的
 * `current.blockmap`,读不到才按地址去取。这份缓存只在**差量下载**时写,而差量拿来对照的旧文件换得更勤:
 *  - Windows:`installer.exe` 是 NSIS 每次安装(手动装、整包更新都算)把自己拷进来的;
 *  - mac:`update.zip` 是上一次开着差量的应用内下载留下的。
 * 一次整包下载(官网源以前一直关着差量)或一次手动安装之后,缓存的 blockmap 就成了更早那一版的:差量照样算、拼出来的包
 * sha512 校验不过、再回落整包 —— 白下一遍差量。
 *
 * 所以开差量前核一下:blockmap 描述的文件大小和旧文件对不上,就删掉它,让 electron-updater 按地址取当前版本的 blockmap
 * (取不到就整包,和原来一样)。两版大小正好一样的情况可以忽略,而且就算漏过去,sha512 照样兜底。
 * 只读一个约 0.5 MB 的 gzip JSON 和一次 stat。任何意外一律不动(返回 false)。
 */
export async function dropStaleCurrentBlockmap(cacheDir: string, oldFileName: string): Promise<boolean> {
  const blockmapFile = join(cacheDir, 'current.blockmap')
  try {
    const old = await stat(join(cacheDir, oldFileName))
    const covered = blockmapCoveredSize(await readFile(blockmapFile))
    if (covered === old.size) return false
    await rm(blockmapFile, { force: true })
    console.log(`[updater] dropped a stale current.blockmap (covers ${covered ?? 'unreadable'} bytes, ${oldFileName} is ${old.size})`)
    return true
  } catch {
    return false // 没有缓存的 blockmap / 没有旧文件(第一次更新):electron-updater 自己会处理
  }
}

/** electron-builder blockmap(gzip 的 `{version, files: [{offset, sizes}]}`)从 0 起首尾相接描述的文件有多大;读不懂返回 null。 */
export function blockmapCoveredSize(content: Buffer): number | null {
  try {
    const map = JSON.parse(gunzipSync(content).toString('utf8'))
    if (!Array.isArray(map?.files) || !map.files.length) return null
    let end = 0
    for (const file of map.files) {
      if (!Array.isArray(file?.sizes) || Number(file.offset) !== end) return null
      for (const n of file.sizes) {
        if (!Number.isSafeInteger(n) || n <= 0) return null
        end += n
      }
    }
    return end
  } catch {
    return null
  }
}

/** 差量拿来对照的旧文件名(electron-updater 的约定):NSIS `installer.exe`、mac `update.zip`;别的平台不管。 */
export function differentialOldFile(platform: string): string | null {
  return platform === 'win32' ? 'installer.exe' : platform === 'darwin' ? 'update.zip' : null
}
