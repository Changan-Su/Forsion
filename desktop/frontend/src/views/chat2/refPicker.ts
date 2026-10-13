// 聊天输入框 `[[` 引用菜单的候选与分类(纯函数,单测钉这里)。排序沿用 ./refRank。
import type { AppRef } from '../../../../shared/appRefs'
import { rankRefs } from './refRank'

/** [[ 引用候选:note=vault 笔记(p=vault 相对 .md 路径);session=历史会话(p=标题,供打分);
 *  app=电脑上的应用 / 打开的窗口(p=名字或窗口标题);都不是 = 工作区文件(p=cwd 相对路径)。 */
export type RefCand = {
  p: string
  note?: true
  session?: { id: string; title: string; summary?: string | null }
  app?: AppRef
  /** 菜单右侧那行小字(应用 / 窗口用;别的种类由 Composer 现拼)。 */
  desc?: string
}

export const REF_CATS = ['all', 'window', 'app', 'note', 'file', 'session'] as const
export type RefCat = typeof REF_CATS[number]

export const catOf = (c: RefCand): Exclude<RefCat, 'all'> => (c.app ? c.app.kind : c.session ? 'session' : c.note ? 'note' : 'file')

/** 这次菜单该出哪几个分类:没有候选的种类不出空标签;只剩一种时不出分类条(返回空)。 */
export function refCats(cands: readonly RefCand[]): RefCat[] {
  const has = new Set(cands.map(catOf))
  const cats = REF_CATS.filter((c) => c !== 'all' && has.has(c))
  return cats.length > 1 ? ['all', ...cats] : []
}

/** 分类像是接在查询词后面的几个字(同 ⌘P 快切,用户 08-20 定的心智:光标是一条线 `查询词|全部 窗口 应用 …`):
 *  → 往右一格,到头停住不绕圈;← 往回一格,已经在第一格(全部)时不接 —— 那一下是移光标回去改字。
 *  null = 这个键不归分类条。光标不在查询词末尾时由调用方直接不问(两个键都只移光标)。 */
export function moveRefCat(cats: readonly RefCat[], active: RefCat, key: string): RefCat | null {
  if (!cats.length || (key !== 'ArrowLeft' && key !== 'ArrowRight')) return null
  const index = Math.max(0, cats.indexOf(active))
  if (key === 'ArrowLeft') return index > 0 ? cats[index - 1] : null
  return cats[Math.min(index + 1, cats.length - 1)]
}

/** 某个分类下的候选。「全部」没打字时按「窗口 → 应用 → 其余」各取几条(不然全是名字最短的那几个);打了字就混排。 */
export function pickerMatches(cands: RefCand[], query: string, cat: RefCat): RefCand[] {
  // 窗口 / 应用没打字时保持原顺序(窗口前到后、应用在跑的在前);rankRefs 的空查询是按名字长短排的
  if (cat !== 'all') { const own = cands.filter((c) => catOf(c) === cat); return !query && (cat === 'window' || cat === 'app') ? own.slice(0, 10) : rankRefs(own, query, 10) }
  if (query) return rankRefs(cands, query, 10)
  const wins = cands.filter((c) => c.app?.kind === 'window').slice(0, 4)   // 已是前到后的顺序
  const apps = cands.filter((c) => c.app?.kind === 'app').slice(0, 3)      // 已是在跑的在前
  return [...wins, ...apps, ...rankRefs(cands.filter((c) => !c.app), '', 10 - Math.min(5, wins.length + apps.length))]
}
