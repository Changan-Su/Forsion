/**
 * 笔记正文里的 `@` 时间标记 —— **标记解析的唯一真源**。
 *
 * 语法(2026-08-31 用户拍板):
 *   `@2026-09-01`                          全天
 *   `@2026-09-01T14:30`                    带时刻
 *   `@2026-09-01T09:00/2026-09-01T10:30`   区间
 *   `@remind:2026-09-01T14:30`             额外发一条消息提醒
 * 日期串与 calendarDate 列的落盘编码**逐字相同**(@amadeus-shared/db/calDate)——
 * 下游的分桶 / 排序 / 人类可读格式化全部零适配复用,别在这里另造一套编码。
 *
 * 触发判据与编辑器的 `mentionSuggestPlugin` 同源:`@` 必须在**行首或空白之后**,
 * 所以 `foo@bar.com`、`a@b` 不会被误当标记。围栏代码块内一律不算。
 *
 * 去向(前两条互斥,提醒叠加在任意一条之上):
 *   `- [ ] 交周报 @2026-09-01`   → 待办列表(TodoListView)
 *   `周会 @2026-09-01T14:30`     → 日历日程(mdCalDbs 合成只读源)
 *   任一行带 `@remind:…`          → 到点弹通知(notificationWiring)
 *
 * ⚠️ **没有 `@` 标记的 `- [ ]` 不进任何视图**。旧口径是「全库任何 `- [ ]` 都算待办」,
 * 用户实报误报太多(笔记里的勾选框大多是排版而非待办)——现在标记是显式闸门。
 *
 * 刻意不做:表情元数据(📅 ⏫ 🔁,Obsidian Tasks 的路子,会把元数据堆进正文);
 * 正文里的自然语言解析(「下周三」)。松散输入(`@2200` / `@9-1` / `@明天`)只活在编辑器的
 * 候选面板里(frontend 的 dateQuery.ts),**落盘一律规范形式**。
 */

/** 一条带 `@` 标记的行。 */
import { isRealDate } from './db/calDate'

export interface MdMark {
  /** vault 相对路径 */
  path: string
  /** 笔记名(不含 .md) */
  title: string
  /** 最近的上级标题正文(`''` = 该行在任何标题之前) */
  heading: string
  /** 行文本:已剥掉 `@` 标记与行首块标记(`-`/`>`/`#`),含其余行内 markdown */
  text: string
  /** 这行是不是 GFM 任务项(`- [ ]` / `- [x]`);false = 普通行块 */
  isTask: boolean
  checked: boolean
  /** 日期(calDate 编码)。只写了 `@remind:` 时 = 提醒时刻本身(提醒天然带一个时间点)。 */
  due: string
  /** 提醒时刻(calDate 编码);无 = 不提醒 */
  remind?: string
  /** 1-based 行号,针对**传入的这份文本**(已剥 frontmatter 的清洗文本) */
  line: number
  /** 这一行的原文(未剥块标记、未摘标记)。回写时用它**按内容**定位,不用行号:
   *  清洗文本与磁盘文件的行号不在同一坐标系(frontmatter / 注释被剥掉了)。 */
  raw: string
  /** 本行原文在清洗文本里是第几次出现(0-based)。同一篇里两行逐字相同时靠它区分。
   *  ⚠️ 主进程回写扫描必须**同口径地跳过** frontmatter 与注释块,否则名额被算错 = 静默改错行。 */
  occ: number
}

const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*\S)\s*$/
const TASK_RE = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/
/** 开/闭围栏:整串栅栏 + 其后的 info string。⚠️ 必须捕获**长度** —— 四反引号开的块可以合法地
 *  包住三反引号(CommonMark:闭围栏字符相同且不短于开围栏、且不带 info),只认固定三个会被内部
 *  的三反引号提前收口,后面的代码示例就漏成了真标记(Codex 对抗评审实测复现)。 */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/
/** 行首块标记(引用 / 项目符号 / 有序号 / 井号):只影响展示文本,不影响是不是标记行。 */
const LEAD_RE = /^\s*(?:>\s*)*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+)?/

const SIDE = String.raw`\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?`
/** `(前导空白)@[remind:]<起[/止]>`,后面必须是空白、行尾或收尾标点。 */
const MARK_RE = new RegExp(
  String.raw`(?:^|\s)@(remind:)?(${SIDE}(?:/${SIDE})?)(?=$|[\s,;.。，、；)）\]】!?！？])`,
  'g',
)

/** 文本去掉 HTML 标签与空白后还剩东西吗 —— `* [ ] <br /> @2026-09-01` 这种占位行不算。 */
const hasContent = (s: string): boolean => s.replace(/<[^>]*>/g, '').trim().length > 0

interface Marks {
  due: string
  remind?: string
  /** 摘掉全部标记后的剩余文本(未剥行首块标记) */
  rest: string
}

/** 逐个走一行里**合法**的标记(形状对 + 日子真的存在)。解析与回写共用这一个游标 —— 两边的
 *  「哪一段才算标记」判据必须逐字同源,否则回写会改到解析器根本没认的那一段。 */
function* marksIn(s: string): Generator<{ index: number; whole: string; remind: boolean; val: string }> {
  MARK_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = MARK_RE.exec(s))) {
    if (!m[2].split('/').every(isRealDate)) continue
    yield { index: m.index, whole: m[0], remind: !!m[1], val: m[2] }
  }
}

/** 改这一行的日期:优先改日程标记,整行只有 `@remind:` 时就改它(那条本来就兼作日期)。
 *  `next` = 完整 calDate 值(可含 `起/止`)。行里没有可改的标记 = null。 */
export function withDue(raw: string, next: string): string | null {
  const all = [...marksIn(raw)]
  const hit = all.find((x) => !x.remind) ?? all[0]
  if (!hit) return null
  const token = `${hit.whole.startsWith('@') ? '' : hit.whole[0]}@${hit.remind ? 'remind:' : ''}${next}`
  return raw.slice(0, hit.index) + token + raw.slice(hit.index + hit.whole.length)
}

/** 勾/取消勾这一行的 GFM 勾选框。不是任务行 = null。 */
export function withChecked(raw: string, checked: boolean): string | null {
  const m = /^(\s*[-*+]\s+\[)[ xX](\]\s)/.exec(raw)
  if (!m) return null
  return raw.slice(0, m[1].length) + (checked ? 'x' : ' ') + raw.slice(m[1].length + 1)
}

/**
 * 把「清洗文本里第 `occ` 条内容为 `raw` 的行」映射回**磁盘原文**的行号;找不到 = -1。
 *
 * 回写一律**按内容定位,不用行号** —— `MdMark.line` 是清洗文本的坐标系,与磁盘文件差着
 * frontmatter 与注释那些被剥掉的行。这里与 `stripForIndex` 同口径地跳过那两样,让两边数的是
 * 同一批行;不跳的话,注释体里一行逐字相同的文本会占掉名额 → **静默改错行**(毁档级)。
 *
 * 方向性保证:本函数产出的行集合 ⊆ 解析器计数的行集合(带注释分隔符的行两边都排除,
 * 只有「多行注释把两行合并成一行」这种极端形态会让解析器多数一条)。所以最坏结果是**找不到**
 * (回写失败 → 退回「跳到笔记里改」),**永远不会**落到另一行上。
 */
export function findMarkLine(fileText: string, raw: string, occ: number): number {
  const lines = fileText.split(/\r?\n/)
  let i = 0
  if (lines[0] === '---') { // 开头 YAML frontmatter,口径同 stripForIndex 的正则
    let j = 1
    while (j < lines.length && !/^---[ \t]*$/.test(lines[j])) j++
    if (j < lines.length) i = j + 1
  }
  let open = false
  let seen = 0
  for (; i < lines.length; i++) {
    const l = lines[i]
    const wasOpen = open
    for (let k = 0; ;) {
      const at = open ? l.indexOf('-->', k) : l.indexOf('<!--', k)
      if (at < 0) break
      k = at + (open ? 3 : 4)
      open = !open
    }
    if (wasOpen || open || l.includes('<!--') || l.includes('-->')) continue
    if (l === raw && seen++ === occ) return i
  }
  return -1
}

/** 摘出一行里的标记;一条都没有 = null。同类多写只取第一条(后面的当噪音丢掉)。 */
export function extractMarks(s: string): Marks | null {
  let due = ''
  let remind = ''
  let rest = ''
  let at = 0
  for (const mk of marksIn(s)) {
    if (mk.remind) { if (!remind) remind = mk.val }
    else if (!due) due = mk.val
    rest += s.slice(at, mk.index) + ' ' // 留一个空格:`a @… b` 摘完不能粘成 `ab`
    at = mk.index + mk.whole.length
  }
  rest += s.slice(at)
  if (!due && !remind) return null
  return { due: due || remind, remind: remind || undefined, rest: rest.replace(/\s+/g, ' ').trim() }
}

/**
 * 从一份 markdown 文本里摘出全部带 `@` 标记的行。
 * `text` 应当是**已剥 frontmatter** 的正文(主进程侧由 `stripForIndex` 保证)。
 */
export function parseMdMarks(text: string, path: string, title: string): MdMark[] {
  const out: MdMark[] = []
  let heading = ''
  let fence: string | null = null
  const lines = text.split(/\r?\n/)
  // 同名行计数。⚠️ **每一行都要数**(围栏行、围栏内、标题、空行一律算) —— 主进程回写是按
  // 「清洗文本的第 occ 条同文行」在磁盘文件里找的,那边只会跳过 frontmatter 与注释(= stripForIndex
  // 剥掉的那两样)。这里少数一行,两边名额就错位,轻则改不动、重则**静默改错行**。
  const seen = new Map<string, number>()
  const push = (m: Marks, body: string, isTask: boolean, checked: boolean, line: number, raw: string, occ: number): void => {
    if (!hasContent(body)) return
    out.push({ path, title, heading, text: body, isTask, checked, due: m.due, remind: m.remind, line, raw, occ })
  }
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const occ = seen.get(raw) ?? 0
    seen.set(raw, occ + 1)
    const f = FENCE_RE.exec(raw)
    if (f) {
      // 收口三条件:同种栅栏(``` 不该被 ~~~ 关掉)、不短于开围栏、且不带 info string。
      if (fence === null) fence = f[1]
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = null
      continue
    }
    if (fence !== null) continue
    const h = HEADING_RE.exec(raw)
    if (h) {
      const m = extractMarks(h[2])
      // 标题自己带标记时,它归属的仍是**上一级**标题上下文;换 heading 在这之后。
      if (m) push(m, m.rest, false, false, i + 1, raw, occ)
      heading = m ? m.rest : h[2]
      continue
    }
    const t = TASK_RE.exec(raw)
    if (t) {
      const m = extractMarks(t[3])
      if (m) push(m, m.rest, true, t[2].toLowerCase() === 'x', i + 1, raw, occ)
      continue
    }
    const m = extractMarks(raw)
    if (m) push(m, m.rest.replace(LEAD_RE, '').trim(), false, false, i + 1, raw, occ)
  }
  return out
}
