/**
 * 笔记正文里的 GFM 任务项(`- [ ]` / `- [x]`)解析 —— **任务解析的唯一真源**。
 *
 * 主进程 VaultIndex 用它把全库任务摊出来(索引已持有清洗后的全文且随 watcher 增量更新,
 * 这里只是遍历字符串,不读盘);渲染层经 `vault:tasks` 拿结果喂待办视图。将来做原地回写、
 * agent 侧读取、移动端,都从这里拿 —— **禁止第二份正则**。
 *
 * 判据与编辑器侧的 `blockTriggers.matchTrigger` 同源(`- [ ] ` 三种项目符号 + 大小写 x),
 * 两边各有单测互锁:形态漂了就红。
 *
 * 刻意不做:表情元数据(📅 ⏫ 🔁)解析 —— 那是 Obsidian Tasks 的路子,会把元数据堆进正文
 * 污染纯文本可读性(其社区长期抗议未解决)。要给任务加属性走外部索引 / frontmatter / 多维表列。
 */

export interface MdTask {
  /** vault 相对路径 */
  path: string
  /** 笔记名(不含 .md) */
  title: string
  /** 最近的上级标题正文(`''` = 该任务在任何标题之前) */
  heading: string
  /** 任务文本(原样,含行内 markdown) */
  text: string
  checked: boolean
  /** 1-based 行号,针对**传入的这份文本**(已剥 frontmatter 的清洗文本) */
  line: number
}

const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*\S)\s*$/
const TASK_RE = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/
const FENCE_RE = /^ {0,3}(```|~~~)/

/** 任务文本去掉 HTML 标签与空白后还剩东西吗 —— `* [ ] <br />` 这种占位行不算待办。 */
const hasContent = (s: string): boolean => s.replace(/<[^>]*>/g, '').trim().length > 0

/**
 * 从一份 markdown 文本里摘出全部任务项。
 * `text` 应当是**已剥 frontmatter** 的正文(主进程侧由 `stripForIndex` 保证);
 * 围栏代码块内的 `- [ ]` 一律不算。
 */
export function parseMdTasks(text: string, path: string, title: string): MdTask[] {
  const out: MdTask[] = []
  let heading = ''
  let fence: string | null = null
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const f = FENCE_RE.exec(raw)
    if (f) {
      // 同种栅栏才收口(``` 不该被 ~~~ 关掉);开着栅栏时其余一概跳过。
      if (fence === null) fence = f[1]
      else if (f[1] === fence) fence = null
      continue
    }
    if (fence !== null) continue
    const h = HEADING_RE.exec(raw)
    if (h) {
      heading = h[2]
      continue
    }
    const t = TASK_RE.exec(raw)
    if (!t || !hasContent(t[3])) continue
    out.push({ path, title, heading, text: t[3].trim(), checked: t[2].toLowerCase() === 'x', line: i + 1 })
  }
  return out
}
