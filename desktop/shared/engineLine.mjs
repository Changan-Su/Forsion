// 引擎 npm 热更新按「安装包线」分发(2026-10-28):dist-tag `desktop-<桌面版本>` 只指向给这一版桌面做的热更新,
// 桌面的更新器只查自己这条线的标签,不看 latest —— latest 上可能是别的线的引擎,号更高也不该装。
//
// ⚠️ 别改名、别挪位置:发布门禁(tangu-agent/scripts/engine-release-gate.mjs)按「基线桌面 tag 里有没有这个文件」
// 判断那份安装包的更新器认不认本线标签。没有它的旧安装包(≤ 2.13.8-beta.2)只读 latest。
import { parseReleaseVersion } from './releaseVersion.mjs'

/** 安装包修订(+build.N)与原版同线;npm 标签里不放 `+`。 */
export function engineLineTag(desktopVersion) {
  const parsed = parseReleaseVersion(desktopVersion)
  if (!parsed) throw new Error(`Invalid desktop version: ${desktopVersion}`)
  return `desktop-${parsed.version.split('+')[0]}`
}
