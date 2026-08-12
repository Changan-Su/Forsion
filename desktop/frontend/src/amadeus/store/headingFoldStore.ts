/** 标题小节折叠(Obsidian 式)的状态与判定。折叠 UI 本身住在 PageView(行级:标题行折起其后
 *  连续的行,直到下一个同级或更高级标题行)—— 这里只管「记什么、存哪」。
 *
 *  ⚠️ 两处曾经错的地方,别改回去:
 *   1. **必须按笔记路径分桶**。块 id 是每份文件自己的小整数(`<!-- a 3 -->`),跨笔记必然重号 ——
 *      早先那句「别页的 id 撞不上」是错的:A 笔记折了 3 号,B 笔记的 3 号也会跟着折。
 *   2. 状态**只存 localStorage,绝不写进 .md**。折叠是纯本地观感,写进文件就会污染 vault、
 *      跟着云同步跑到别的设备、还让每折一次都产生一次文件改动与同步冲突(Obsidian 自己也是
 *      存 workspace.json)。块 id 本身落在笔记里,所以重开笔记折叠仍在。
 *  ponytail: 键只用笔记路径不带 vault —— 两个 vault 里同路径的笔记会共用折叠态,纯观感不值当加一层。 */
import { create } from 'zustand'

const KEY = 'amadeus.heading.fold'

/** 块内容的标题层级(1-6);不是标题行 → 0。取第一行,`#` 后必须有空白。
 *  CommonMark 允许最多三个前导空格,一并认(否则从别处粘来的笔记没有折叠箭头)。 */
export function headingLevel(content: string | undefined): number {
  const first = (content ?? '').split('\n', 1)[0] ?? ''
  const m = /^ {0,3}(#{1,6})\s/.exec(first)
  return m ? m[1].length : 0
}

/** 块**任意一行**上出现的最小标题级别(整块没有标题 → 0)—— 小节边界只能按它判。
 *
 *  ⚠️ 块只由 `<!-- a id -->` 切分,**不按段落/空行拆**(编辑器里 Enter 是块内换行,Shift+Enter 才切块;
 *  外来 .md 更是整篇进一个块)。所以「## 二」经常躺在上一个块的**中间**,只看首行的 headingLevel()
 *  完全看不见它 —— 折叠就一路吞到文末(用户实报「直接把后面所有内容都折叠了」)。
 *  ponytail: 行级折叠切不开块,所以含边界标题的那一行整行留下(宁可少折,不吞掉下一节)。 */
export function sectionBoundaryLevel(content: string | undefined): number {
  const s = content ?? ''
  if (!s.includes('#')) return 0 // 绝大多数块没有 '#':先短路,别在每次按键都扫全文
  let best = 0
  let fence = false
  for (const line of s.split('\n')) {
    if (/^ {0,3}(```|~~~)/.test(line)) {
      fence = !fence // 代码块里的 `# 注释` 不是标题
      continue
    }
    if (fence) continue
    const m = /^ {0,3}(#{1,6})\s/.exec(line)
    if (!m) continue
    if (!best || m[1].length < best) best = m[1].length
    if (best === 1) break
  }
  return best
}

const load = (): Record<string, string[]> => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, string[]>
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

interface State {
  /** 笔记路径 → 折起的标题块 id 列表 */
  byPage: Record<string, string[]>
  toggle(page: string, blockId: string): void
}

export const useHeadingFold = create<State>((set) => ({
  byPage: load(),
  toggle: (page, blockId) =>
    set((s) => {
      const cur = s.byPage[page] ?? []
      const next = cur.includes(blockId) ? cur.filter((x) => x !== blockId) : [...cur, blockId]
      const byPage = { ...s.byPage }
      if (next.length) byPage[page] = next
      else delete byPage[page]
      try {
        localStorage.setItem(KEY, JSON.stringify(byPage))
      } catch {
        /* 配额满/隐私模式:折叠仍在本次会话生效 */
      }
      return { byPage }
    }),
}))

/** 某页折起的标题块 id 集合(渲染层用)。 */
export function foldedSet(byPage: Record<string, string[]>, page: string): Set<string> {
  return new Set(byPage[page] ?? [])
}
