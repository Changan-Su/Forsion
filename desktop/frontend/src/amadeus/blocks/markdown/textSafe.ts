// K-20b(评审 2026-09-27):段落里的字面 `- `、`1. `、`# `、`> ` 落盘不转义,重开就成了空列表 / 空标题。
//
// 病根是 milkdown 自带的 text handler(@milkdown/core `remarkHandlers.text`):值「不含 `*_\` 且以空白结尾」
// 就**原样返回、整段跳过 state.safe** —— 本意是别把行尾空格写成 `&#x20;`(边打字边自动保存时会满盘都是),
// 代价是这类文本里该转义的也一概不转义。编辑器里它仍是段落 `- `,盘上却是 `- \n`,下次打开就是一个空列表项;
// `\- ab` 退两格、`# ` 后撤销(K-21 让撤销回到字面 `# `)都会撞上。
// 修法:保留「行尾空白原样、不写 `&#x20;`」这一半,只对去掉行尾空白的主体走 state.safe;主体无需转义时
// 与原来逐字相同(不动存量落盘形态)。`\- ` 重开后是段落 `-`(行尾空格被解析器吃掉,与任何行尾空格同命)。
// ⚠️ 必须挂 `remarkStringifyOptionsCtx.handlers`(同 attentionFlanking.ts 顶注:options 那份恒压过 extensions)。
// 仪器:npm run check:unifiedkeys -- --only=K20b(切走切回往返)、textSafe.test.ts。
import { config, remarkStringifyOptionsCtx } from '@milkdown/kit/core'

/* eslint-disable @typescript-eslint/no-explicit-any -- mdast handler 签名(同 listFormat / attentionFlanking) */
export function handleText(node: any, _parent: unknown, state: any, info: any): string {
  const value: string = node.value
  if (/^[^*_\\]*\s+$/.test(value)) {
    const body = value.replace(/\s+$/, '')
    if (!body) return value
    const tail = value.slice(body.length)
    const escaped: string = state.safe(body, { ...info, after: tail[0], encode: [] })
    return escaped === body ? value : escaped + tail
  }
  return state.safe(value, { ...info, encode: [] })
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** 挂进 commonmarkWithIndent(paragraphIndent.ts),与 preset 同进同出。 */
export const textSafeSerializer = config((ctx) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx.update(remarkStringifyOptionsCtx, (o: any) => ({ ...o, handlers: { ...o.handlers, text: handleText } }))
})
