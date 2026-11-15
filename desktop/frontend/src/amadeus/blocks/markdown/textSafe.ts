// K-20b(评审 2026-09-27):段落里的字面 `- `、`1. `、`# `、`> ` 落盘不转义,重开就成了空列表 / 空标题。
//
// 病根是 milkdown 自带的 text handler(@milkdown/core `remarkHandlers.text`):值「不含 `*_\` 且以空白结尾」
// 就**原样返回、整段跳过 state.safe** —— 本意是别把行尾空格写成 `&#x20;`(边打字边自动保存时会满盘都是),
// 代价是这类文本里该转义的也一概不转义。编辑器里它仍是段落 `- `,盘上却是 `- \n`,下次打开就是一个空列表项;
// `\- ab` 退两格、`# ` 后撤销(K-21 让撤销回到字面 `# `)都会撞上。
// 修法:保留「行尾空白原样、不写 `&#x20;`」这一半,只对去掉行尾空白的主体走 state.safe;主体无需转义时
// 与原来逐字相同(不动存量落盘形态)。`\- ` 重开后是段落 `-`(行尾空格被解析器吃掉,与任何行尾空格同命)。
// 注册处:attentionFlanking.ts 的 attentionHandlers.text(经 remarkStringifyOptionsCtx;L-09b 的表格 `|` 同根,同一份实现)。
// 仪器:npm run check:unifiedkeys -- --only=K20b(切走切回往返)、textSafe.test.ts。
//
// 出口再过两道「去掉多余转义」(只在这里做,因为只有正文文字经过这里 —— HTML / 代码 / 图片说明 / 用户转义都不经过):
// 成对字面方括号 `[词]`(bracketEscape.ts,v4 整篇落盘才开)、行首 `=` / `==`(tagEscape.ts 的 unescapeHighlightInText)。
// 两道都按「safe 收到的前后文」判:after 是 safe 实际看到的下一个字(直通分支 = 尾随空白的首字)。
//
// 加粗字面化开关开着时(./literalBoldFlag,见 ./literalBold):正文里的 `*` `_` 原样写,只在行首真会变成列表项 / 分隔线时
// 照旧转义(literalStarUnsafe)。With the literal-bold switch on, `*` / `_` in text are written as-is; only a line-start
// list bullet / thematic break is escaped. 用户自己写的 `\*` 走 ./literalEscape,不经过这里。开关关着,这里与原来逐字相同。
import { literalBracketsInText } from './bracketEscape'
import { unescapeHighlightInText } from './tagEscape'
import { literalBoldEnabled } from './literalBoldFlag'

/* eslint-disable @typescript-eslint/no-explicit-any -- mdast handler 签名(同 listFormat / attentionFlanking) */
const tidy = (out: string, value: string, state: any, info: any): string =>
  unescapeHighlightInText(literalBracketsInText(out, state, info), value, info?.after)

export function handleText(node: any, _parent: unknown, state: any, info: any): string {
  if (!literalBoldEnabled() || !Array.isArray(state?.unsafe)) return textOut(node.value, state, info, PASS_THROUGH)
  const orig = state.unsafe
  state.unsafe = literalStarUnsafe(orig)
  try {
    // `*` / `_` are ordinary text now, so a value holding them may take the trailing-whitespace pass-through too
    // (else a typed space after `**b**` saves as `&#x20;`). 含星号的值也走「行尾空白原样」那条直通。
    return textOut(node.value, state, info, PASS_THROUGH_LITERAL)
  } finally {
    state.unsafe = orig
  }
}

/** milkdown's pass-through condition (value without `*_\\`, ending in whitespace). 原直通判据。 */
const PASS_THROUGH = /^[^*_\\]*\s+$/
const PASS_THROUGH_LITERAL = /^[^\\]*\s+$/

function textOut(value: string, state: any, info: any, pass: RegExp): string {
  if (pass.test(value)) {
    const body = value.replace(/\s+$/, '')
    if (!body) return value
    const tail = value.slice(body.length)
    const after = { ...info, after: tail[0] }
    const escaped: string = tidy(state.safe(body, { ...after, encode: [] }), value, state, after)
    return escaped === body ? value : escaped + tail
  }
  return tidy(state.safe(value, { ...info, encode: [] }), value, state, info)
}

/** The unsafe table with the literal-bold rule: `*` / `_` inside phrasing are not escaped; at a line start `*` is
 *  escaped only before whitespace / end (a list bullet) or as a thematic break (`***`, `* * *`), `_` only as a thematic
 *  break. 开关开着时的 unsafe 表:正文里不转义 `*` `_`;行首的 `*` 只在列表符 / 分隔线、`_` 只在分隔线时转义。 */
const literalUnsafeCache = new WeakMap<object, unknown[]>()
function literalStarUnsafe(list: any[]): unknown[] {
  const hit = literalUnsafeCache.get(list)
  if (hit) return hit
  const out: unknown[] = []
  for (const u of list) {
    const star = u?.character === '*'
    if ((!star && u?.character !== '_') || ('before' in u) || (u.inConstruct && u.inConstruct !== 'phrasing')) {
      out.push(u)
      continue
    }
    if (!u.atBreak) continue // phrasing `*` / `_`: raw 正文:原样
    const c = star ? '\\*' : '_'
    const thematic = `(?:[ \\t]*${c}){2}[ \\t${star ? '*' : '_'}]*(?:[\\r\\n]|$)`
    out.push({ atBreak: true, character: u.character, after: star ? `(?:[ \\t\\r\\n]|$|${thematic})` : thematic })
  }
  literalUnsafeCache.set(list, out)
  return out
}
/* eslint-enable @typescript-eslint/no-explicit-any */
