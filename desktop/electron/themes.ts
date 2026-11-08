/**
 * 拖入式主题读盘。纯 fs(不 import electron),故主进程与 vitest 都能用。
 * 主进程把 themesDir(<home>/themes)传进来;渲染端拿到 {id,manifest,css} 后用 <style> 注入。
 * 第一方语言(Genesis / Glass / Soft)都随包内置,不再往磁盘种主题;旧版种进去的 Soft 怎么处理见 themeMigrations.ts。
 */
import { readFile, readdir } from 'fs/promises'
import { join } from 'path'
import { fingerprint, readSoftMigrationMarker } from './themeMigrations'

/** 合法主题 id:kebab,且不得是保留字 lovable(bundle 基底,磁盘不可覆盖)。防 data-theme/元素 id 注入。 */
const THEME_ID_RE = /^[a-z0-9-]+$/
export function isValidThemeId(id: string): boolean {
  return id !== 'lovable' && THEME_ID_RE.test(id)
}

export interface DiskTheme {
  id: string
  manifest: Record<string, unknown>
  css: string
  /** 这套主题是从哪个 id 迁出来的(主进程写的迁移标记,不来自 theme.json);渲染层据此把正用旧 id 的人切过来一次。 */
  migratedFrom?: string
}

/** [data-theme=<id>] 选择器(带不带引号、方括号里有没有空格都算;id 已过 isValidThemeId,没有正则元字符)。 */
const scopeSelector = (id: string, flags = ''): RegExp => new RegExp(`\\[\\s*data-theme\\s*=\\s*(["']?)${id}\\1\\s*\\]`, flags)

/** 读 themesDir 下每个合法子目录的 theme.json + theme.css。逐项 try/catch:一套坏主题不拖垮整张列表。
 *  主题的身份是**目录名**(manifest.id 被目录名压过)。theme.json 的 id 和目录名不同时,那个 id 表示这份 CSS 是写给谁的:
 *  商店主题(market-<UUID>)一律、以及 CSS 里从没出现过自己目录名的主题(如迁移出来的 soft-custom),
 *  读盘时把 [data-theme=<json id>] 映射成 [data-theme="<目录名>"](只改返回给渲染层的文本,磁盘文件不动)。 */
export async function readThemesDir(dir: string): Promise<DiskTheme[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const marker = entries.length ? await readSoftMigrationMarker(dir) : null
  const out: DiskTheme[] = []
  for (const e of entries) {
    if (!e.isDirectory() || !isValidThemeId(e.name)) continue
    try {
      const manifest = JSON.parse(await readFile(join(dir, e.name, 'theme.json'), 'utf8'))
      if (!manifest || typeof manifest !== 'object') continue
      const raw = await readFile(join(dir, e.name, 'theme.css'), 'utf8')
      let css = raw
      const authoredFor = typeof manifest.id === 'string' && manifest.id !== e.name && isValidThemeId(manifest.id) ? manifest.id : null
      if (authoredFor && (/^market-[0-9a-f-]{36}$/.test(e.name) || !scopeSelector(e.name).test(css))) {
        css = css.replace(scopeSelector(authoredFor, 'g'), `[data-theme="${e.name}"]`)
      }
      const item: DiskTheme = { id: e.name, manifest: { ...manifest, id: e.name }, css }
      // 只认迁移时那份 CSS:同名目录是后来别人建的,就不算迁移出来的
      if (marker && marker.to === e.name && marker.css === fingerprint(raw)) item.migratedFrom = marker.from
      out.push(item)
    } catch (err) {
      console.warn(`[themes] 跳过无效主题 "${e.name}":`, (err as Error)?.message)
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id))
  return out
}
