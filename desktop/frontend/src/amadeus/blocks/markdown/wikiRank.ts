// `[[ ]]` 候选排序。抽成纯函数只为一件事:让「附件/数据库到底露不露面」可被单测钉住。
//
// 病(用户实报「双链没有包括附件和数据库」):候选池本来就含文件,但 fuzzyScore 对**空查询**恒返回 1
// —— 刚打完 `[[` 还没输字时页面与文件同分,稳定排序把页面全排在前面,slice(0, 8) 一刀切完,
// 于是笔记数 ≥8 的 vault 里附件/数据库**永远**不出现。看起来就是「这功能没做」。
// 药:先按分排,再给文件留固定名额(有文件候选时至少露 FILE_SLOTS 条),名额从队尾挤。

import { fuzzyScore } from '../../lib/fuzzy'

export interface Cand {
  /** vault 相对路径。 */
  path: string
  /** 展示名:页面剥 .md,文件保留扩展名。 */
  base: string
  /** 文件候选(附件/.db/画板…);页面为 false。 */
  file: boolean
}

export const WIKI_LIMIT = 8
/** 文件候选的保底名额。ponytail: 定值够用;要按「文件占比」动态分配再说。 */
export const FILE_SLOTS = 2

/** 按 query 排序候选并截断;文件候选保底 FILE_SLOTS 条(不足则有多少给多少)。 */
export function pickWikiResults(cands: Cand[], query: string, limit = WIKI_LIMIT): Cand[] {
  // 名字命中优先(+1000)、仅路径命中垫底;sort 稳定 → 同分保持入参顺序(@ 提及 recents-first 不乱)。
  const scored: Array<{ c: Cand; s: number }> = []
  for (const c of cands) {
    const sName = fuzzyScore(query, c.base)
    const s = sName !== null ? sName + 1000 : fuzzyScore(query, c.path)
    if (s !== null) scored.push({ c, s })
  }
  scored.sort((a, b) => b.s - a.s)
  const ranked = scored.map((x) => x.c)
  const head = ranked.slice(0, limit)
  const spare = ranked.filter((c) => c.file && !head.includes(c)).slice(0, FILE_SLOTS)
  return spare.length ? [...head.slice(0, limit - spare.length), ...spare] : head
}
