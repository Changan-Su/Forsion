// 轻量子序列模糊匹配(移植自 Amadeus src/renderer/lib/fuzzy.ts)。命令面板用。

/**
 * 给 `query` 对 `target` 的模糊匹配打分。query 的字符未按序全部出现则返回 null。
 * 分越高越好:奖励连续段与词边界,轻微偏好更早首次命中与更短目标。
 */
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.trim().toLowerCase()
  const t = target.toLowerCase()
  if (!q) return 1
  let score = 0
  let qi = 0
  let prevMatch = -2
  let firstIdx = -1
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      if (firstIdx < 0) firstIdx = ti
      let s = 1
      if (ti === prevMatch + 1) s += 4 // 连续段
      if (ti === 0 || /[\s/\-_.]/.test(t[ti - 1])) s += 3 // 词边界
      score += s
      prevMatch = ti
      qi++
    }
  }
  if (qi < q.length) return null // 并非每个 query 字符都命中
  score -= firstIdx * 0.1
  score -= t.length * 0.02
  if (t === q) score += 10 // 完全相等
  return score
}

/** 按 `query` 对 `key(item)` 的模糊匹配过滤+排序(并列稳定)。 */
export function fuzzyRank<T>(query: string, items: T[], key: (t: T) => string): T[] {
  if (!query.trim()) return items
  const scored: Array<{ item: T; score: number }> = []
  for (const item of items) {
    const s = fuzzyScore(query, key(item))
    if (s != null) scored.push({ item, score: s })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.map((s) => s.item)
}
