/**
 * 主进程迁移出来的磁盘主题接管旧选择(electron/themeMigrations.ts:改过的旧 Soft 整目录另存成 soft-custom)。
 * 全局语言正是旧 id 的、以及单独把语言设成旧 id 的 Space,切到迁移后的 id —— 观感和升级前一样。
 *
 * 状态记在 localStorage(同源的各窗口共用),键 = 前缀 + 迁移后的 id:
 * - 没有 → 第一次看到:记成 adopted,全局语言和各 Space 都切过去。
 * - adopted → 已经接管过,但用户还没自己换过语言:全局语言仍是旧 id 的照样切。这是给同时启动的几个窗口用的 ——
 *   恢复出来的分离窗口在主窗口接管之前就读走了旧值,不切的话它会把旧值写回去(Space 不用管:主窗口写进同源存储,
 *   别的窗口经 storage 事件收到)。也顺带让「记了标记、语言没写进去」的那次在下次启动补上。
 * - done → 用户之后自己换过语言(markLanguageChosen),之后选回内置的 Soft 也不再切走。
 * 只有真看到迁移标记、且迁移后的主题已经合进注册表时才动:列表读失败返回空,不能把这件事当成已做过(读失败 ≠ 没迁移)。
 */
import type { SpaceAppearance } from '../../../shared/spaceAppearance'

export const MIGRATED_FLAG_PREFIX = 'forsion_theme_migrated.'

export interface MigratedAdoption {
  lang: string
  spaces: Array<{ id: string; appearance: SpaceAppearance }>
}

export function adoptMigratedLanguage(
  list: ReadonlyArray<{ id: string; migratedFrom?: string }>,
  current: string,
  spaces: Readonly<Record<string, SpaceAppearance>>,
  hasLanguage: (id: string) => boolean,
): MigratedAdoption {
  let lang = current
  const changed = new Map<string, SpaceAppearance>()
  for (const t of list) {
    const from = t.migratedFrom
    if (!from || from === t.id || !hasLanguage(t.id)) continue
    const flag = MIGRATED_FLAG_PREFIX + t.id
    let first: boolean
    try {
      const state = localStorage.getItem(flag)
      if (state === 'done') continue
      first = state === null
      if (first) localStorage.setItem(flag, 'adopted')
    } catch {
      continue // 存不下标记就不动:否则以后每次启动都会把用户的选择改回去
    }
    if (lang === from) lang = t.id
    if (!first) continue
    for (const [id, appearance] of Object.entries(spaces)) {
      const cur = changed.get(id) ?? appearance
      if (cur.lang === from) changed.set(id, { ...cur, lang: t.id })
    }
  }
  return { lang, spaces: [...changed].map(([id, appearance]) => ({ id, appearance })) }
}

/** 用户自己换了设计语言:接管到此为止(adopted → done),之后选回旧 id 不再被切走。 */
export function markLanguageChosen(): void {
  try {
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k?.startsWith(MIGRATED_FLAG_PREFIX)) keys.push(k)
    }
    for (const k of keys) if (localStorage.getItem(k) === 'adopted') localStorage.setItem(k, 'done')
  } catch { /* 无存储 */ }
}
