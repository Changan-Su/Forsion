/**
 * 更新检查的 GitHub 兜底:从 release 资产里挑 Forsion 本体 APK(纯函数;单测 `npm run test:releaseapk`)。
 *
 * ⚠️ 同一个 release 里还挂着手机操控伴随包(文件名含 `Hands`,只含无障碍服务,单装没用)。
 *    挑到它 = 用户装了伴随包、本体永远不更新、「有新版本」永远挂着。先排除 Hands,再优先 Forsion-Tangu。
 *    旧版客户端只认 `/-android(-debug)?\.apk$/i` 的第一个 —— 那些装机版改不了,所以伴随包资产名
 *    **绝不能**以 `-android(-debug).apk` 结尾(CI 由 test:releaseapk 钉住)。契约:tangu-agent/docs/phone-control.md §9.1。
 */
export interface ReleaseAsset {
  name?: unknown
  browser_download_url?: unknown
}

export const LEGACY_ANDROID_APK = /-android(-debug)?\.apk$/i

export function pickAndroidApk<T extends ReleaseAsset>(assets: T[] | null | undefined): T | undefined {
  const apks = (Array.isArray(assets) ? assets : []).filter((a) => {
    const name = String(a?.name || '')
    return LEGACY_ANDROID_APK.test(name) && !/hands/i.test(name)
  })
  return apks.find((a) => /^Forsion-Tangu-/i.test(String(a?.name || ''))) || apks[0]
}
