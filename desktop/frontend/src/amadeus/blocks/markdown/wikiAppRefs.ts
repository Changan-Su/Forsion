// `[[` 补全里的应用 / 窗口候选与分类(契约 shared/appRefs.ts)。纯函数,单测钉在 wikiAppRefs.test.ts;
// 分类条的口径对齐聊天引用菜单(views/chat2/refPicker):全部 / 窗口 / 应用 / 笔记,←/→ 循环切。
import { fuzzyScore } from '../../lib/fuzzy'
import { appRefToken, type AppRef, type AppRefList } from '../../../../../shared/appRefs'

export const WIKI_CATS = ['all', 'window', 'app', 'note'] as const
export type WikiCat = typeof WIKI_CATS[number]

/** 「全部」里窗口 / 应用各露几条(其余进各自的分类看);单独一类时的上限。 */
export const ALL_WINDOWS = 4
export const ALL_APPS = 3
export const APP_REF_LIMIT = 12

/** 这次面板出哪几个分类。宿主没有应用引用接口 → 空(不出分类条,面板与从前逐字相同);
 *  窗口 / 应用两格在有接口时恒出(列表是开面板后才取回来的,先占位免得分类条晚一拍蹦出来把候选顶下去),
 *  「笔记」只在候选池里有东西时出(非笔记库宿主传空页面表)。 */
export function wikiCats(offerApps: boolean, hasNotes: boolean): WikiCat[] {
  if (!offerApps) return []
  return hasNotes ? [...WIKI_CATS] : ['all', 'window', 'app']
}

/** 规则同聊天那边的 moveRefCat(views/chat2/refPicker.ts):→ 往右到头停住,← 往回,在「全部」上不接。 */
export function moveWikiCat(cats: readonly WikiCat[], active: WikiCat, key: string): WikiCat | null {
  if (!cats.length || (key !== 'ArrowLeft' && key !== 'ArrowRight')) return null
  const index = Math.max(0, cats.indexOf(active))
  if (key === 'ArrowLeft') return index > 0 ? cats[index - 1] : null
  return cats[Math.min(index + 1, cats.length - 1)]
}

/** 查询串是不是还在「找目标」:带 `#` `|` `^` = 用户在写笔记的锚点 / 别名,不拿窗口标题去撞(浏览器标题里常有 `|`)。 */
export const appRefQueryOk = (query: string): boolean => !/[#|^]/.test(query)

/** 手写到一半的应用 / 窗口引用(`[[app://com.…`):不是笔记名,不给「新建链接」行。 */
export const isAppRefQuery = (query: string): boolean => /^\s*(?:app|window):\/\//.test(query)

export interface AppRefCand {
  ref: AppRef
  /** 右侧灰字:窗口 = 它属于哪个应用;应用没有。 */
  hint?: string
}

/** 某一类候选按 query 过滤排序。空查询保持宿主给的顺序(窗口前到后、应用在跑的在前);
 *  窗口先比标题(+1000),标题不中再比所属应用名 —— 打应用名能带出它开着的窗口。 */
export function pickAppRefs(list: AppRefList | null, query: string, kind: 'window' | 'app', limit = APP_REF_LIMIT): AppRefCand[] {
  if (!list || !appRefQueryOk(query)) return []
  const cands: Array<AppRefCand & { alt?: string }> = kind === 'window'
    ? list.windows.map((w) => ({ ref: { kind: 'window', id: w.id, name: w.title }, hint: w.app, alt: w.app }))
    : list.apps.map((a) => ({ ref: { kind: 'app', id: a.id, name: a.name } }))
  if (!query.trim()) return cands.slice(0, limit).map(({ ref, hint }) => ({ ref, hint }))
  const scored: Array<{ c: AppRefCand; s: number }> = []
  for (const { alt, ...c } of cands) {
    const sName = fuzzyScore(query, c.ref.name)
    const s = sName !== null ? sName + 1000 : alt ? fuzzyScore(query, alt) : null
    if (s !== null) scored.push({ c, s })
  }
  scored.sort((a, b) => b.s - a.s)
  return scored.slice(0, limit).map((x) => x.c)
}

/** 选中候选后写进 `[[` 与 `]]` 之间的内文:`[[` + 它 + `]]` 就是 appRefToken(ref)。 */
export const appRefInner = (ref: AppRef): string => appRefToken(ref).slice(2, -2)
