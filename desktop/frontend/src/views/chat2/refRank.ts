// 聊天输入框 `[[` 引用候选的排序。抽成纯函数只为可被单测钉住(同 amadeus 的 wikiRank)。
//
// 原样包含的照旧排前面:名字前缀命中 > 名字包含 > 仅路径包含,同档路径短者先。
// 不够 limit 条再拿模糊命中补位(字符按序出现即可、分隔符不计 —— 「moc forsion」找得到 MOC-Forsion,
// 与笔记里 `[[` 同一把尺 amadeus/lib/fuzzy)。
// 用户实报:聊天里的 `[[` 只认连续子串,少打一个字、多打一个空格就一条都不出。
// ⚠️ 模糊只比**名字**,不比整条路径:菜单开着时 Enter 是「选中候选」而不是「发送」(Composer2 onKeyDown),
//    几千条长路径做子序列匹配几乎什么都能命中 —— 正文里随手打的 `[[` 会把发送键一直扣住。

import { fuzzyScore } from '../../amadeus/lib/fuzzy'

/** 候选的名字:路径最后一段,笔记剥 .md。 */
const baseOf = (c: { p: string; note?: true }): string => (c.note ? c.p.replace(/\.md$/i, '') : c.p).split('/').pop()!

export function rankRefs<T extends { p: string; note?: true }>(cands: T[], query: string, limit = 10): T[] {
  const q = query.toLowerCase()
  const pool = q ? cands.filter((c) => c.p.toLowerCase().includes(q)) : cands
  const tier = (c: T): number => {
    const base = baseOf(c).toLowerCase()
    return (base.startsWith(q) ? 0 : base.includes(q) ? 1 : 2) * 10000 + c.p.length
  }
  const hits = [...pool].sort((a, b) => tier(a) - tier(b)).slice(0, limit)
  if (!q || hits.length >= limit) return hits
  const taken = new Set(hits)
  const fuzzy: Array<{ c: T; s: number }> = []
  for (const c of cands) {
    if (taken.has(c)) continue
    const s = fuzzyScore(q, baseOf(c))
    if (s !== null) fuzzy.push({ c, s })
  }
  fuzzy.sort((a, b) => b.s - a.s)
  return [...hits, ...fuzzy.slice(0, limit - hits.length).map((x) => x.c)]
}
