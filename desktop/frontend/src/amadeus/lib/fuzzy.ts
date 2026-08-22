// Lightweight subsequence fuzzy matching, reused by the Quick switcher and [[ autocomplete.

/**
 * Score how well `query` fuzzy-matches `target`. Returns null when the query's
 * characters don't all appear, in order, in the target. Higher score = better match.
 * Rewards contiguous runs and matches at word boundaries; mildly prefers an earlier
 * first match and a shorter target.
 */
export function fuzzyScore(query: string, target: string): number | null {
  const raw = query.trim().toLowerCase()
  // 查询里的分隔符不当数(空格/连字符/下划线/点/斜杠互通):用户打「moc forsion」要能找到
  // 「moc-forsion」—— 目标侧照旧保留分隔符,词首加分那一条还靠它。
  const q = raw.replace(/[\s\-_/.]+/g, '')
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
      if (ti === prevMatch + 1) s += 4 // contiguous run
      if (ti === 0 || /[\s/\-_.]/.test(t[ti - 1])) s += 3 // word boundary
      score += s
      prevMatch = ti
      qi++
    }
  }
  if (qi < q.length) return null // not every query char matched
  score -= firstIdx * 0.1
  score -= t.length * 0.02
  if (t === raw || t === q) score += 10 // exact
  return score
}

/** Filter+sort `items` by fuzzy match of `query` against `key(item)` (stable for ties). */
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
