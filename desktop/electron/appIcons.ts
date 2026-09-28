/**
 * bundle id → App 图标(dataURL),给电脑历史的时间线画图标行。事件里只有 bundle id 没有路径:
 * 经 Spotlight(mdfind)按 bundle id 找 .app,再取 QuickLook 缩略图。找不到(Spotlight 关了 / 已卸载)回 null,
 * 渲染层画首字母方块。结果按进程缓存(App 图标一次运行内不会变)。
 * ⚠️ 别换回 app.getFileIcon:Chromium 在 macOS 上按扩展名取图标,所有 .app 都是同一枚灰色通用图标(实测)。
 */
import { execFile } from 'node:child_process'
import os from 'node:os'
import { promisify } from 'node:util'
import { nativeImage } from 'electron'

const execFileP = promisify(execFile)
/** 拼进 mdfind 查询串前的校验:不许引号 / 反斜杠 / 通配符。 */
const BUNDLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/
const MAX_IDS = 64
const cache = new Map<string, string | null>()

/** `mdfind -attr kMDItemCFBundleIdentifier` 的输出 → bundle id → .app 路径;同一 id 多份时优先应用 / 系统目录。 */
export function parseMdfindBundles(out: string, home = os.homedir()): Map<string, string> {
  const preferred = ['/Applications/', '/System/Applications/', '/System/Library/CoreServices/', `${home}/Applications/`]
  const rank = (p: string): number => { const i = preferred.findIndex((d) => p.startsWith(d)); return i < 0 ? preferred.length : i }
  const best = new Map<string, string>()
  for (const line of out.split('\n')) {
    const m = /^(\/.+\.app)\s+kMDItemCFBundleIdentifier = (\S+)\s*$/.exec(line)
    if (!m) continue
    const cur = best.get(m[2])
    if (!cur || rank(m[1]) < rank(cur)) best.set(m[2], m[1])
  }
  return best
}

export async function appIconDataUrls(ids: unknown): Promise<Record<string, string | null>> {
  const want = [...new Set(Array.isArray(ids) ? ids : [])]
    .filter((id): id is string => typeof id === 'string' && BUNDLE_ID_RE.test(id)).slice(0, MAX_IDS)
  const miss = want.filter((id) => !cache.has(id))
  if (miss.length && process.platform === 'darwin') {
    const query = miss.map((id) => `kMDItemCFBundleIdentifier == '${id}'`).join(' || ')
    const out = await execFileP('/usr/bin/mdfind', ['-attr', 'kMDItemCFBundleIdentifier', query], { timeout: 5_000, maxBuffer: 4 << 20 })
      .then((r) => r.stdout, () => null)
    // mdfind 本身失败(超时等)不缓存,下次再试
    if (out !== null) {
      const paths = parseMdfindBundles(out)
      await Promise.all(miss.map(async (id) => {
        const p = paths.get(id)
        let url: string | null = null
        if (p) {
          try {
            const img = await nativeImage.createThumbnailFromPath(p, { width: 48, height: 48 })
            if (!img.isEmpty()) url = img.toDataURL()
          } catch { /* 取不到按无图标 */ }
        }
        cache.set(id, url)
      }))
    }
  }
  return Object.fromEntries(want.map((id) => [id, cache.get(id) ?? null]))
}
