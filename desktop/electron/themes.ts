/**
 * 拖入式主题读盘 + 首次种入。纯 fs(不 import electron),故主进程与 vitest 都能用。
 * 主进程把 themesDir(~/.tangu/themes)传进来;渲染端拿到 {id,manifest,css} 后用 <style> 注入。
 */
import { readFile, writeFile, mkdir, readdir, stat } from 'fs/promises'
import { join } from 'path'
import { SEED_THEMES } from './seedThemes'

/** 合法主题 id:kebab,且不得是保留字 lovable(bundle 基底,磁盘不可覆盖)。防 data-theme/元素 id 注入。 */
const THEME_ID_RE = /^[a-z0-9-]+$/
export function isValidThemeId(id: string): boolean {
  return id !== 'lovable' && THEME_ID_RE.test(id)
}

export interface DiskTheme {
  id: string
  manifest: Record<string, unknown>
  css: string
}

/** 读 themesDir 下每个合法子目录的 theme.json + theme.css。逐项 try/catch:一套坏主题不拖垮整张列表。 */
export async function readThemesDir(dir: string): Promise<DiskTheme[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const out: DiskTheme[] = []
  for (const e of entries) {
    if (!e.isDirectory() || !isValidThemeId(e.name)) continue
    try {
      const manifest = JSON.parse(await readFile(join(dir, e.name, 'theme.json'), 'utf8'))
      if (!manifest || typeof manifest !== 'object') continue
      let css = await readFile(join(dir, e.name, 'theme.css'), 'utf8')
      if (/^market-[0-9a-f-]{36}$/.test(e.name) && typeof manifest.id === 'string' && isValidThemeId(manifest.id)) {
        for (const quote of ['\"', "'", '']) css = css.split(`[data-theme=${quote}${manifest.id}${quote}]`).join(`[data-theme=\"${e.name}\"]`)
      }
      out.push({ id: e.name, manifest: { ...manifest, id: e.name }, css })
    } catch (err) {
      console.warn(`[themes] 跳过无效主题 "${e.name}":`, (err as Error)?.message)
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id))
  return out
}

/** 仅当 themesDir 整个目录不存在(首次运行)时种入内嵌默认主题;此后文件夹完全归用户。 */
export async function seedDefaultThemes(dir: string): Promise<void> {
  try {
    await stat(dir)
    return // 已存在 → 用户领地,绝不覆盖
  } catch { /* 不存在 → 种入 */ }
  try {
    for (const t of SEED_THEMES) {
      const d = join(dir, t.id)
      await mkdir(d, { recursive: true })
      await writeFile(join(d, 'theme.json'), t.json, 'utf8')
      await writeFile(join(d, 'theme.css'), t.css, 'utf8')
    }
  } catch (err) {
    console.warn('[themes] 种入默认主题失败:', (err as Error)?.message)
  }
}
