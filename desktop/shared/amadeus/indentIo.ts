/** 段落缩进的落盘形态 ↔ 解析安全形态互转(2026-08-14,Tab 缩进档位)。
 *
 *  落盘 = 行首字面制表符(`\t\t正文`,用户可读、Obsidian 心智)。但 CommonMark 把行首
 *  制表符解析成缩进代码块、跟在列表后的还会被吸进列表项 —— 所以喂给 remark 之前要把
 *  围栏外的 `^\t+` 换成 `&#9;` 实体(实证:remark 把实体解析为段落文本里的字面 \t 字符,
 *  既不成代码块也不并入列表);序列化侧我们发 `&#9;` html 节点(remark-stringify 对文本
 *  里的行首 \t 自己会转义成 `&#x9;`,两种形态都要认),落盘前再统一转回字面制表符。
 *
 *  刻意的边界(记入 Log):
 *  - 外部文件里用制表符缩进的**无围栏**代码块会被读成缩进段落(4 空格缩进的不受影响);
 *  - `\t- item` / `\t> quote` 等制表符后是块级构造的行不动(保留 CommonMark 嵌套语义);
 *  - 围栏识别只认 ≤3 空格缩进的 ```/~~~/$$(CommonMark 顶层规则)——嵌套 ≥2 层列表里的
 *    围栏代码若含 `^\t` 行会被误转,属已知长尾;
 *  - 外部文件里行首**字面文本** `&#9;` 与本机制的线格式撞车:remark 解码后与我们的缩进
 *    实体不可分,首次开-存会被归一成行首字面制表符(视觉等价 —— 该实体本来就渲染为
 *    制表符;但外部工具对该行的解释从段落变缩进代码块)。编辑器内**手打**的 `&#9;`
 *    序列化自带反斜杠转义,不受影响。评审权衡后按边界记录,不为极端形态引入私有哨兵。
 */

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,}|\$\$)(.*)$/
const FENCE_CLOSE = (fence: string): RegExp =>
  fence === '$$' ? /^ {0,3}\$\$\s*$/ : new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`)
/** 该行真是围栏**开启**吗:单行 `$$E=mc^2$$` 是行内公式段落(mathLivePreview 常驻纯文本形态),
 *  余文含 `$` 一律不当开栏——否则假围栏态吞掉其后整篇的互转(评审 P1,栽过)。
 *  ``` 围栏的 info string 按 CommonMark 不许含反引号,同理拒开。 */
const opensFence = (mark: string, rest: string): boolean =>
  mark === '$$' ? !rest.includes('$') : mark[0] === '`' ? !rest.includes('`') : true

/** 制表符后是块级构造(嵌套列表/引用):CommonMark 语义保留,不转。 */
const BLOCK_CONSTRUCT = /^(?:[-*+][ \t]|\d{1,9}[.)][ \t]|>)/

/** 逐行走一遍 md,只对「围栏代码/$$ 数学/头部 frontmatter 之外」的行应用 fn。 */
function mapOutsideFences(md: string, fn: (line: string) => string): string {
  const lines = md.split('\n')
  let i = 0
  // 头部 frontmatter 整段跳过(YAML 块标量里可以合法出现制表符/实体)
  if (lines[0] === '---') {
    for (i = 1; i < lines.length; i++) if (lines[i] === '---' || lines[i] === '...') { i++; break }
  }
  let fence: string | null = null
  let changed = false
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (fence) {
      if (FENCE_CLOSE(fence).test(line)) fence = null
      continue
    }
    const open = FENCE_OPEN.exec(line)
    if (open && opensFence(open[1], open[2])) { fence = open[1]; continue }
    const next = fn(line)
    if (next !== line) { lines[i] = next; changed = true }
  }
  return changed ? lines.join('\n') : md
}

/** 磁盘 → 解析:围栏外行首字面制表符 → `&#9;` 实体(每个制表符一枚)。 */
export function tabsToEntities(md: string): string {
  if (!md.includes('\t')) return md
  return mapOutsideFences(md, (line) => {
    const m = /^(\t+)(.*)$/.exec(line)
    if (!m || !m[2] || BLOCK_CONSTRUCT.test(m[2])) return line
    return '&#9;'.repeat(m[1].length) + m[2]
  })
}

/** 序列化 → 磁盘:行首连串 `&#9;`/`&#x9;` 实体(可与字面 \t 混排:remark-stringify 只
 *  转义文本里的**首枚**行首制表符,后面的保持字面)→ 全部归一成字面制表符。
 *  用户手打的字面文本 `&#9;` 会被 remark-stringify 转义成 `\&#9;`,不会撞上这条。
 *
 *  两条对称守卫(评审后收紧,与 tabsToEntities 的 BLOCK_CONSTRUCT 互逆):
 *  - 余文是块级构造(`&#9;- item`/`&#9;>引` —— remark-stringify 的 atBreak 转义被前置
 *    html 节点击穿,`-`/`>`/`1.` 不带反斜杠):**保实体落盘**。转成 `\t- item` 就是
 *    tabsToEntities 拒转的形态,重开即缩进代码块并固化(评审 P1)。实体形态是不动点:
 *    载入解码→attr→序列化回实体,往返稳定,只是该行磁盘形态非正典。
 *  - 引用/列表**前缀之后**的实体串(`> &#9;文`:引用块内段落带了 indent attr):这些
 *    位置的缩进 md 表示不了,实体只是垃圾字符 —— 直接剥掉(用户手打的字面 &#9; 文本
 *    序列化必带 `\&#9;` 反斜杠,不会误伤)。 */
export function entitiesToTabs(md: string): string {
  if (!md.includes('&#')) return md
  return mapOutsideFences(md, (line) => {
    const m = /^((?:&#[xX]?9;|\t)+)(?=.)(.*)$/.exec(line)
    if (m && m[1].includes('&#')) {
      if (BLOCK_CONSTRUCT.test(m[2])) return line // 见头注:保实体=不动点,防重开塌代码块
      const n = (m[1].match(/&#|\t/g) ?? []).length
      return '\t'.repeat(n) + m[2]
    }
    // 引用/列表前缀后的实体串剥除(缩进语义在这些容器里 md 表示不了,留着就是磁盘垃圾)
    const pre = /^((?:> ?)+|(?:[-*+]|\d{1,9}[.)])[ \t]+)((?:&#[xX]?9;)+)(.*)$/.exec(line)
    if (pre) return pre[1] + pre[3]
    return line
  })
}

/** 缩进档位上限(与 CSS data-indent 档位数一致,超出按上限钳)。 */
export const MAX_INDENT = 8
