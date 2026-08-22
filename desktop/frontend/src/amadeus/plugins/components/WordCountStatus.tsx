// Status-bar item contributed by the built-in "word-count" plugin: character count of the
// active page. v3 读 pageStore 的 blocks,v4 问 unified 实例 —— 两条都在 lib/activeNote。

import { useNoteChars } from '../../lib/activeNote'

export function WordCountStatus() {
  const chars = useNoteChars()
  if (chars == null) return null
  return <span className="status-item">{chars} 字</span>
}
