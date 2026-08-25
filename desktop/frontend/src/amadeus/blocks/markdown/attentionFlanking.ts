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

const WHITESPACE = 1
const PUNCTUATION = 2
const ref = (code: number): string => `&#x${code.toString(16).toUpperCase()};`
// 内侧不需要同样的守卫 —— 代理项归类为「其它」,永远进不了编码分支。
const isSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdfff

/** encode-info.js 那张四×四表在 marker='~'(判据等同 '*')这一列的化简。 */
export function encodeSides(outside: number, inside: number): { inside: boolean; outside: boolean } {
  const kind = classifyCharacter(inside)
  const outer = !isSurrogate(outside)
  // 内侧空白:必编内侧;外侧只要不是标点也一起编(外侧是标点时开合本来就撑得住)。
  if (kind === WHITESPACE) return { inside: true, outside: outer && classifyCharacter(outside) !== PUNCTUATION }
  // 内侧标点:只有外侧是字母/汉字才需要编外侧。标点自身绝不编 —— 它是别的构造的定界符。
  if (kind === PUNCTUATION) return { inside: false, outside: outer && classifyCharacter(outside) === undefined }
  return { inside: false, outside: false } // 内侧是字母/汉字 → 本来就成立
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** 覆盖 gfm 的 `delete` handler(注册在 gfm 之后,mdast-util-to-markdown 后者胜)。 */
export const handleDelete = (node: any, _parent: unknown, state: any, info: any): string => {
  const tracker = state.createTracker(info)
  const exit = state.enter('strikethrough')
  const before = tracker.move('~~')
  let between = tracker.move(state.containerPhrasing(node, { ...tracker.current(), before, after: '~' }))
  const head = between.charCodeAt(0)
  const open = encodeSides(info.before.charCodeAt(info.before.length - 1), head)
  if (open.inside) between = ref(head) + between.slice(1)
  const tail = between.charCodeAt(between.length - 1)
  const close = encodeSides(info.after.charCodeAt(0), tail)
  if (close.inside) between = between.slice(0, -1) + ref(tail)
  const after = tracker.move('~~')
  exit()
  state.attentionEncodeSurroundingInfo = { after: close.outside, before: open.outside }
  return before + between + after
}
handleDelete.peek = (): string => '~'

/**
 * 包一层上游的 strong/emphasis handler:原样调用(不复刻 encode-info 那张四×四表,
 * 连 `_` 那条分支一起白拿),只在它刚设好的 `attentionEncodeSurroundingInfo` 上按侧撤销
 * ——外侧是代理对的一半就把那一侧关掉。containerPhrasing 在 handler 返回后才读这个标志,
 * 所以在这里改来得及。
 * ponytail: 内侧编码由上游决定,已经加上去的不撤 —— 反正这时 run 已经不成立,
 * `**x&#x20;**` 和 `**x **` 对用户是同一个结果(都退成字面),不值得为此拆它的返回串。
 */
export function guardSurrogate(base: any): any {
  const handle = (node: any, parent: unknown, state: any, info: any): string => {
    const value = base(node, parent, state, info)
    const sides = state.attentionEncodeSurroundingInfo
    if (sides) {
      if (sides.before && isSurrogate(info.before.charCodeAt(info.before.length - 1))) sides.before = false
      if (sides.after && isSurrogate(info.after.charCodeAt(0))) sides.after = false
    }
    return value
  }
  handle.peek = base.peek
  return handle
}

/** strong / emphasis —— 上游唯二会设 attentionEncodeSurroundingInfo 的 handler。 */
export const handleStrong = guardSurrogate(defaultHandlers.strong)
export const handleEmphasis = guardSurrogate(defaultHandlers.emphasis)

/** 三个 attention mark 的落盘 handler。测试直接吃这个对象,与生产同一份。 */
export const attentionHandlers = { delete: handleDelete, strong: handleStrong, emphasis: handleEmphasis }

/** 挂进编辑器:`.use(attentionSerializer)`(必须经 ctx,理由见文件头 ⚠️ 那段)。 */
export const attentionSerializer = config((ctx) => {
  ctx.update(remarkStringifyOptionsCtx, (o: any) => ({ ...o, handlers: { ...o.handlers, ...attentionHandlers } }))
})
