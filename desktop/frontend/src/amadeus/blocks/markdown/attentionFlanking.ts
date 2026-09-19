// attention run(`~~` / `**` / `*`)的边界字符编码修正。两条毛病,同一条边界规则:
//   A. GFM 删除线**完全不做**边界编码 → 定界符自毁(用户实报,见下)。
//   B. 上游做了,但按**单个 UTF-16 码元**编码 → 外侧是 emoji 时把代理对拆坏(Codex 评审揪出)。
// A 只影响 `~~`,B 三个 mark 都有。
//
// ⚠️ 注册点不是 `toMarkdownExtensions`,是 **`remarkStringifyOptionsCtx.handlers`**:
// milkdown 的 `init` 自带一份 `remarkHandlers`(只有 text/strong/emphasis 三个,是上游
// **老版本的拷贝,一行边界编码都不做**),而 mdast-util-to-markdown 的 `configure()` 是
// 先合 `extensions` 再合 `options.handlers` → **options 那份恒胜**。所以 strong/emphasis
// 放扩展里是死代码(实测),必须经 ctx 覆盖。`delete` 碰巧 milkdown 没有,放哪都行,
// 但三个一起放同一处才不会烂 —— 见本文件末尾 attentionHandlers / attentionSerializer。
// 顺带:milkdown 那两个 handler 不做编码 → **加粗/斜体在真编辑器里跟删除线一样会自毁**
// (`**abc **尾巴` 重解析成纯文本,下次保存转义成 `\*\*abc \*\*`),覆盖成上游版顺手治了。
//
// ── A:GFM 删除线的落盘缺陷(用户实报:「划线内容有时候莫名其妙就变成字面的 ~~」)。
//
// 病:`~~` 跟 `*`/`**` 一样是 attention run,成不成立取决于**紧邻的两个字符**的类别
// (空白 / 标点 / 其它)。mdast-util-to-markdown 给 strong/emphasis 备了一整套边界字符编码
// (util/encode-info.js 的四×四表),`mdast-util-gfm-strikethrough` 的 delete handler 一条没做:
//   · 内侧空白:`~~文字。 ~~` —— 闭合定界符前是空白 → 不成立;
//   · 内侧标点 + 外侧字母/汉字:`~~**加粗**~~尾巴` —— 闭合定界符前是 `*` 后是「尾」→ 不成立。
//     (`` ~~`代码`~~字 ``、`~~（备注）~~继续` 同理。加粗/斜体不犯是因为上游会把外侧那个字
//      编码成 `&#x5C3E;`,删除线没这一步。)
// 一旦不成立:重开笔记整段退化成字面文本 → 下次保存 remark 把 `~` 转义成 `\~\~文字 \~\~`,
// **不可逆**;再划一次线只会套娃成 `~~\~\~文字 \~\~~~`(用户文件里已有 9 处)。
// 尾随空白实测是输入法打的 U+00A0,肉眼跟普通空格没区别 ——「莫名其妙」由此而来。
//
// 修法:照抄 mdast-util-to-markdown 的 strong handler,把同一套边界编码用到 `~~` 上
// (encode-info.js 的注释明说这套判据 "already forms for `*` (and GFMs `~`)")。内侧字符编成
// 字符引用留在 `~~` 里,外侧字符交给 containerPhrasing 走 `attentionEncodeSurroundingInfo`
// 编码 —— 与 `**加粗 **` 现在的落盘形态完全同款,Obsidian/CommonMark 都照常渲染。
//
// ── B:外侧编码拆坏非 BMP 字符 ──
// 外侧编码是 `containerPhrasing` 干的:`encodeCharacterReference(before.charCodeAt(0))` ——
// 按单个 UTF-16 码元走。外侧是 emoji 等非 BMP 字符时,代理对被拆成 `&#xD83D;` + 孤立低位,
// 重新解析变 U+FFFD,**用户内容被毁**,比丢一个 mark 严重得多。触发条件是「内侧空白/标点
// + 外侧非 BMP」,`**x **😀`、`` **`c`**😀 ``、`~~**x**~~😀` 都中招(实测)。
// 修法:外侧是代理对的一半时一律不请求外侧编码 —— 删除线在 encodeSides 里直接判,
// strong/emphasis 走 `guardSurrogate()` 包一层上游 handler(不复刻四×四表)。
// 代价:这些情况下 mark 退化成字面(= 修复前的行为),但一个字符都不会被改坏。
import { config, remarkStringifyOptionsCtx } from '@milkdown/kit/core'
import { defaultHandlers } from 'mdast-util-to-markdown'
import { classifyCharacter } from 'micromark-util-classify-character'
import { refDecodable } from '@amadeus-shared/links'

/* eslint-disable @typescript-eslint/no-explicit-any */
const WHITESPACE = 1
const PUNCTUATION = 2
const ref = (code: number): string => `&#x${code.toString(16).toUpperCase()};`
const isSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdfff
/**
 * 外侧字符**只有是字母/汉字时**才值得编码。其余一律不编:
 *  · 空白/标点:内侧处理完后贴着定界符的是 `;`(字符引用的尾巴)或原本的标点,开合本来就成立;
 *    上游 encode-info 在「内外都是空白」时也编外侧 → 软换行被编成 `&#xA;`,磁盘上两行并成一行(09-18 评审实测);
 *  · 代理项:外侧编码按单个 UTF-16 码元走,会把 emoji 拆坏(Codex 08-25);
 *  · NaN:外侧是空文本兄弟 / 容器边界(`''.charCodeAt(-1)`),classifyCharacter 把它当字母 → 落 `&#xNAN;` 垃圾(09-18 评审实测)。
 * 内侧不需要这层 —— 代理项归类为「其它」,永远进不了编码分支;空串由 isEmpty 在更早处挡掉。
 */
const encodableOutside = (code: number): boolean =>
  !Number.isNaN(code) && !isSurrogate(code) && refDecodable(code) && classifyCharacter(code) === undefined

// 能不能编看 refDecodable(@amadeus-shared/links,micromark 的拒收表,与索引侧解码共用):C0/C1 控制符、代理项、
// 非字符的引用一律解成 U+FFFD,字就永久丢了(09-18 三轮评审:乱码网页的「智能引号」U+0091–0094 正落在 C1)。不能编就不编。

/**
 * `*` run 的内侧边缘紧挨另一个定界符时,上游 encode-info 只看到那个定界符(标点),会白编或错判:
 *  · `~`(嵌套删除线)/ `_`:在 micromark 核心 attention 的 attentionMarkers 里,紧挨它的 run 总能开/合,外侧不必编;
 *  · `*`(嵌套的加粗/斜体):**同字符会并成一个 run**(`***重点***`),真正决定开合的是最里层的边缘字 ——
 *    是字母就不必编(`***重点***后面` 不再白编成 `&#x540E;`),是标点就必须编(`!甲***\_***` 不编 `甲` 就开不起来;
 *    09-18 fuzz 实测,原先一刀切「贴着 `*` 就不编」把这类该编的也拦了)。
 * ⚠️ 只对 strong/emphasis 成立:GFM 的 `~~` 有自己的 tokenizer,flanking 不看 attentionMarkers
 *    (`~~**加粗**~~尾巴` 实测不成立,必须编外侧)—— 所以 encodeSides 不用它。
 */
function outsideNeedless(node: any, inner: number, tail: boolean): boolean {
  if (inner === 0x7e || inner === 0x5f) return true
  if (inner === 0x2a) return edgeKind(node, tail) !== 'punct'
  return false
}

/** encode-info.js 那张四×四表在 marker='~'(判据等同 '*')这一列的化简,外侧收紧见 encodableOutside。 */
export function encodeSides(outside: number, inside: number): { inside: boolean; outside: boolean } {
  const kind = classifyCharacter(inside)
  // 内侧空白 → 必编内侧(编完内侧边缘是 `;` = 标点,于是与下一条同一情形)。
  if (kind === WHITESPACE) return { inside: true, outside: encodableOutside(outside) }
  // 内侧标点 → 外侧是字母/汉字时定界符不成立,编外侧(编完是 `&` = 标点)。标点自身绝不编 —— 它是别的构造的定界符。
  if (kind === PUNCTUATION) return { inside: false, outside: encodableOutside(outside) }
  return { inside: false, outside: false } // 内侧是字母/汉字 → 本来就成立
}

/**
 * 外侧那个字编了会出事的两种邻居,宁可不编(= 修复前行为):
 *  · 前一个兄弟是以 `\X` 结尾的文本:X 编成 `&#x..;` 之后那个反斜杠转义掉 `&`,字母永久变字面 `&#x61;`(09-18 fuzz);
 *  · 边缘字在裸 URL 里:GFM 自动链接把 `&#x63;` 吞进链接地址,链接文字/地址都变样(09-18 三轮评审)。
 * ponytail: 只认 http(s):// 与 www. 两种裸链接;裸邮箱(a@b.co)同理会被截短,真遇到再加。
 */
const URL_TAIL = /(?:https?:\/\/|www\.)[^\s<]*$/i
const URL_HEAD = /^(?:https?:\/\/|www\.)/i
const sibling = (parent: any, state: any, offset: number): any =>
  parent?.children?.[state.indexStack[state.indexStack.length - 1] + offset]
const unsafeBefore = (parent: any, state: any): boolean => {
  const prev = sibling(parent, state, -1)
  return prev?.type === 'text' && (prev.value.charAt(prev.value.length - 2) === '\\' || URL_TAIL.test(prev.value))
}
const unsafeAfter = (parent: any, state: any): boolean => {
  const next = sibling(parent, state, 1)
  return next?.type === 'text' && URL_HEAD.test(next.value)
}

/**
 * 空 mark(只剩空文本,或只套着别的空 mark):milkdown 的 moveSpaces 把 mark 里唯一的空格挪到外面后留下的空壳。
 * 典型:整行划线盖过 `**甲** **乙**`,两段加粗之间那个空格上的删除线 → 落 `~~~~`,重开是字面(09-18 评审实测);
 * 空格上同时挂加粗+删除线 → 外层也空,落 `****`(二轮评审实测,故递归)。
 * 丢掉:返回空串,peek 也给空(与空文本兄弟同一口径,相邻 handler 读到 NaN → 不编外侧)。
 * 叶子(图片/行内代码/break)不是空 —— 只有 text 看 value,只有 attention mark 才往下递归。
 */
const ATTENTION = new Set(['delete', 'strong', 'emphasis'])
const isEmpty = (node: any): boolean =>
  Array.isArray(node?.children) &&
  node.children.every((c: any) => (c.type === 'text' ? !c.value : ATTENTION.has(c.type) && isEmpty(c)))

/**
 * 复制成**纯文本**(给微信/别的应用的人看)时不做边界编码:`**注意：**&#x540E;面` 那种字符引用是落盘格式的事。
 * 在序列化层关掉而不是事后正则还原 —— 正则分不清行内代码/代码块里用户自己写的 `&#x41;`(二轮评审实测会改坏)。
 * 代价:纯文本里的 `**注意：**后面` 贴回 markdown 编辑器仍是字面(= 修复前的剪贴板形态)。
 */
// ponytail: 模块级开关;serialize 是同步的所以安全,哪天变异步就得换成 ctx 作用域的开关。
let plainText = false
export function withoutBoundaryRefs<T>(fn: () => T): T {
  plainText = true
  try {
    return fn()
  } finally {
    plainText = false
  }
}

const NONE = { inside: false, outside: false }

/** 覆盖 gfm 的 `delete` handler(注册在 gfm 之后,mdast-util-to-markdown 后者胜)。 */
export const handleDelete = (node: any, parent: unknown, state: any, info: any): string => {
  if (isEmpty(node)) return ''
  const tracker = state.createTracker(info)
  const exit = state.enter('strikethrough')
  const before = tracker.move('~~')
  let between = tracker.move(state.containerPhrasing(node, { ...tracker.current(), before, after: '~' }))
  const head = between.charCodeAt(0)
  const open = plainText ? NONE : encodeSides(info.before.charCodeAt(info.before.length - 1), head)
  if (open.inside) between = ref(head) + between.slice(1)
  const tail = between.charCodeAt(between.length - 1)
  const close = plainText ? NONE : encodeSides(info.after.charCodeAt(0), tail)
  if (close.inside) between = between.slice(0, -1) + ref(tail)
  const after = tracker.move('~~')
  exit()
  state.attentionEncodeSurroundingInfo = {
    after: close.outside && !unsafeAfter(parent, state),
    before: open.outside && !unsafeBefore(parent, state),
  }
  return before + between + after
}
handleDelete.peek = (node: any): string => (isEmpty(node) ? '' : '~')

/**
 * 包一层上游的 strong/emphasis handler:原样调用(不复刻 encode-info 那张四×四表),只在它刚设好的
 * `attentionEncodeSurroundingInfo` 上按侧撤销 —— 外侧不是字母/汉字(encodableOutside)就把那一侧关掉。
 * containerPhrasing 在 handler 返回后才读这个标志,所以在这里改来得及。
 * ponytail: 内侧编码由上游决定,已经加上去的不撤 —— `*` 定界下上游只在内侧空白时编内侧,编完贴着
 * 定界符的是 `;`,外侧空白/标点照样成立,所以撤外侧永远安全。
 *
 * ⚠️ **一律写 `*`,不认 node.marker 的 `_`**(09-18 二轮评审):借 `_` 会把上游带进 encode-info 的 `_` 分支,
 * 它在「内外都是字母」时**按单个 UTF-16 码元编内侧** —— `_开心😀_` 的 emoji 被拆成 U+FFFD、空内容落
 * `&#xNAN;`、`__甲___乙_` 相邻自毁。汉字两侧永远是「字母」,`_` 没有便宜的安全子集。
 * 代价:`_斜体_`/`__加粗__` 下次保存规范成 `*`(渲染完全相同;用户库 WMOSv11 零处 `_`)。
 */
export function guardSurrogate(base: any): any {
  const handle = (node: any, parent: unknown, state: any, info: any): string => {
    if (isEmpty(node)) return ''
    const value = base(node, parent, state, info)
    const sides = state.attentionEncodeSurroundingInfo
    if (sides) {
      const k = node.type === 'strong' ? 2 : 1 // 一律 `*`:定界符长度固定
      const head = value.charCodeAt(k)
      const tail = value.charCodeAt(value.length - k - 1)
      if (sides.before && (plainText || outsideNeedless(node, head, false) || unsafeBefore(parent, state) ||
        !encodableOutside(info.before.charCodeAt(info.before.length - 1)))) sides.before = false
      if (sides.after && (plainText || outsideNeedless(node, tail, true) || unsafeAfter(parent, state) ||
        !encodableOutside(info.after.charCodeAt(0)))) sides.after = false
    }
    return value
  }
  handle.peek = (node: any, parent: unknown, state: any): string => (isEmpty(node) ? '' : base.peek(node, parent, state))
  return handle
}

/** strong / emphasis —— 上游唯二会设 attentionEncodeSurroundingInfo 的 handler。 */
export const handleStrong = guardSurrogate(defaultHandlers.strong)
export const handleEmphasis = guardSurrogate(defaultHandlers.emphasis)

/**
 * 相邻的同类 attention 节点先并成一个再写。milkdown 只并 props 完全相同的相邻 mark,而 `marker` 就在 props 里:
 * `__甲__`(旧笔记 / `_x_` 输入规则)旁边 ⌘B 出来的 `*` 加粗是两个节点 —— 一律写 `*` 之后拼成 `**甲****乙**`,
 * 重开退成字面(09-18 fuzz:混 `_` 的 2 万段里 ~1500 条都是这一形)。marker 既然已不落盘,合并就是无损的。
 */
function mergeSiblings(node: any): any[] {
  const out: any[] = []
  for (const child of node.children) {
    const last = out[out.length - 1]
    if (last && ATTENTION.has(child.type) && child.type === last.type) last.children = [...last.children, ...child.children]
    else out.push(child)
  }
  return out
}

/**
 * 相邻两个 `*` run(斜体紧贴加粗,或反过来)在磁盘上拼成一个 `***`。micromark 核心 attention
 * (micromark-core-commonmark/lib/attention.js)判这个 run 能不能合前一个、开后一个:
 *   close = 前是字母 || (前是标点 && 后不是字母);open = 后是字母 || (后是标点 && 前不是字母)
 * 两侧同类(都字母 / 都标点)才能既合又开。一侧字母一侧标点 → `*斜体***「注意」**` 加粗开不起来、
 * `**注意：***斜体*` 斜体合不上 → 重开退字面,下次保存转义,不可逆(纯 `*` 文档修复前后都坏的大头,09-18 fuzz)。
 * 修:把**字母那一侧**的边缘字编成字符引用(`斜&#x4F53;`),边缘就成了 `;` / `&` —— 两侧都是标点,既合又开。
 * 在 mdast 上拆出一个字符引用节点原样写出(见 CHAR_REF),不必在 handler 的输出串里找位置;按**整码点**编,emoji 不拆。
 * `~~` 不参与:它在 attentionMarkers 里,任何邻居都撑得住;不同字符的 run 也不会拼在一起。
 */
const STAR = new Set(['strong', 'emphasis'])
const blank = (c: any): boolean => (c.type === 'text' ? !c.value : ATTENTION.has(c.type) && isEmpty(c))

/** 沿首/尾穿过 strong/emphasis 钻到边缘叶子(跳过空文本/空壳),返回它所在的容器和下标。 */
function edgeLeaf(node: any, tail: boolean): { host: any; index: number } | null {
  let host = node
  for (;;) {
    const kids: any[] = host.children ?? []
    let i = tail ? kids.length - 1 : 0
    while (i >= 0 && i < kids.length && blank(kids[i])) i += tail ? -1 : 1
    if (i < 0 || i >= kids.length) return null
    if (!STAR.has(kids[i].type)) return { host, index: i }
    host = kids[i]
  }
}

/** 边缘字的类别,口径同 micromark:按 UTF-16 码元分类(代理项算字母);空白会被上游编成 `&#x..;`,算标点。 */
function edgeKind(node: any, tail: boolean): 'letter' | 'punct' | 'ok' {
  const at = edgeLeaf(node, tail)
  if (!at) return 'ok'
  const leaf = at.host.children[at.index]
  if (leaf.type === 'delete' || leaf.type === 'break') return 'ok' // `~` 在 attentionMarkers 里;break 不贴 run
  if (leaf.type !== 'text') return 'punct' // 行内代码 ` / 链接 [ ) / 图片 ! / html < > —— 边缘都是标点
  const v: string = leaf.value
  const code = tail ? v.charCodeAt(v.length - 1) : v.charCodeAt(0)
  // 尾边是 `*`/`_`/`~`:落盘是 `\*`,run 前一个字就是定界符 → attentionMarkers 例外,总能合(头边不同:后一个字是 `\`)。
  if (tail && (code === 0x2a || code === 0x5f || code === 0x7e)) return 'ok'
  if (classifyCharacter(code) !== undefined) return 'punct'
  // 字母侧但编不了(控制符/非字符会解成 U+FFFD、裸 URL 会被自动链接吞):放弃,= 修复前行为。
  const cp = tail ? (v.codePointAt(v.length - (v.length > 1 && isSurrogate(code) ? 2 : 1)) as number) : (v.codePointAt(0) as number)
  if (!refDecodable(cp) || (tail ? URL_TAIL.test(v) : URL_HEAD.test(v))) return 'ok'
  return 'letter'
}

function encodeEdge(node: any, tail: boolean): boolean {
  const at = edgeLeaf(node, tail)
  if (!at) return false
  const kids: any[] = at.host.children
  const v: string = kids[at.index].value
  const cut = tail ? v.length - (v.length > 1 && isSurrogate(v.charCodeAt(v.length - 1)) ? 2 : 1) : 0
  // 前面是反斜杠不用管:CHAR_REF 的 peek 报 `&`,前面的文本会把结尾反斜杠转义成 `\\`(实测三种反斜杠数都往返)。
  const cp = v.codePointAt(cut) as number
  const parts = [
    { type: 'text', value: v.slice(0, cut) },
    { type: CHAR_REF, value: ref(cp) },
    { type: 'text', value: v.slice(cut + (cp > 0xffff ? 2 : 1)) },
  ]
  kids.splice(at.index, 1, ...parts.filter((p) => p.type === CHAR_REF || p.value))
  return true
}

/**
 * 编码出来的字符引用用**自有节点类型**原样写出,不用 mdast 的 `html`:containerPhrasing 见到下一个兄弟是 html
 * 会把前面的行尾改写成空格 → 被编的字前面若是换行,两行就并成一行(09-18 三轮评审实测,软/硬换行都中)。
 * peek 报 `&`(真实首字符):前面文本以反斜杠结尾时会被正确转义成 `\\`。
 */
const CHAR_REF = 'amadeusCharRef'
const handleCharRef = (node: any): string => node.value
handleCharRef.peek = (): string => '&'

/** root 预处理:整棵树序列化只进一次,之后 containerPhrasing 看到的就是并好、隔好的兄弟。 */
function prepare(node: any): void {
  if (!Array.isArray(node?.children)) return
  node.children = mergeSiblings(node)
  // 编码只会把字母变成标点、不会反过来,所以反复扫到不动点必然收敛:只有一个字的中间 mark 被下一对编掉后,
  // 它和上一对的关系从「字母+字母」变成「字母+标点」,得回头再判(09-18 三轮评审:`*斜***甲***「注」*`)。
  // ponytail: 预测不到的翻转仍在 —— 嵌套 mark 或删除线 handler 自己在 containerPhrasing 里编掉的边缘字,
  // 这里看到的还是字母。修复前同样坏,真要治得把所有外侧编码都搬进这趟预处理。
  for (let changed = !plainText; changed; ) {
    changed = false
    const live = node.children.filter((c: any) => !blank(c))
    for (let i = 1; i < live.length; i++) {
      const [a, b] = [live[i - 1], live[i]]
      if (!STAR.has(a.type) || !STAR.has(b.type)) continue
      const ak = edgeKind(a, true)
      const bk = edgeKind(b, false)
      if (ak === 'letter' && bk === 'punct') changed = encodeEdge(a, true)
      else if (ak === 'punct' && bk === 'letter') changed = encodeEdge(b, false)
      if (changed) break
    }
  }
  for (const child of node.children) prepare(child)
}
const handleRoot = (node: any, parent: unknown, state: any, info: any): string => {
  prepare(node)
  return defaultHandlers.root(node, parent as any, state, info)
}

/** attention mark 的落盘 handler(+ root 预处理)。测试直接吃这个对象,与生产同一份。 */
export const attentionHandlers = {
  root: handleRoot,
  delete: handleDelete,
  strong: handleStrong,
  emphasis: handleEmphasis,
  [CHAR_REF]: handleCharRef,
}

/** 挂进编辑器:`.use(attentionSerializer)`(必须经 ctx,理由见文件头 ⚠️ 那段)。 */
export const attentionSerializer = config((ctx) => {
  ctx.update(remarkStringifyOptionsCtx, (o: any) => ({ ...o, handlers: { ...o.handlers, ...attentionHandlers } }))
})
