// D-11(评审 2026-09-27):用户写的反斜杠转义往返保真。
//
// 病:micromark 把 `\#`、`\[`、`\=`、`\%`、`\$`、`\*`… 解析成字面字符,mdast / PM 里**不留转义的痕迹**;被编辑的块
// 重新序列化时,转义只按 to-markdown 自己的判据重加 —— `\#notatag`(句中)→ `#notatag` 进了标签索引,`\[\[x\]\]`
// 先被 safe 转义成 `\[\[`、再被 normalizeSerializedMd 的 unescapeWikiOutsideFences 当成「新打的双链」剥掉 → 真双链;
// `\=\=` / `\%\%` 在 Obsidian 里变成高亮 / 隐藏注释。打开时编辑器也照样把它们渲染成双链 / 高亮 / 公式 / 标签胶囊。
//
// 修法(读侧记位置、写侧原样发):
//  · 读侧:mathLivePreview 的 escapeRecorder 已经在 fromMarkdown 里记下每个 `\X` 在 text.value 里的下标(R-01 用它
//    给公式补反斜杠)。公式体之外的那些记录留给这里(LITERAL_ESCAPES),splitLiteralEscapes 把 text 拆成
//    `text / amadeusEscape / text`,解析成一个 `amadeusEscaped` mark(inclusive:false,PM 里就是原字符)。
//  · 写侧:mark 的 toMarkdown 把文字交给 `amadeusEscape` handler,每个 ASCII 标点前发 ESCAPE_SENTINEL(不是 `\`)——
//    normalizeSerializedMd 里一串正则按 `\X` 剥「序列化器自己加的」转义(`\[\[`、行首 `\#`、`\==`、公式里的、`> \[!`),
//    直接写 `\` 会被一并剥掉。规范化链**末尾**(normalizeSerializedMd / normalizeFragmentMd)再把占位换回 `\`。
//    所有落盘 / 片段 / 剪贴板路径都经这两个函数之一;直接拿 serializerCtx 裸输出的(parseFidelity.testkit.serialize、
//    UnifiedSpike 台架)会看到占位 —— 它们本来就「自己再规范化」。
//  · 显示侧:buildBlockString 把带这个 mark 的定界符(`[ ] $ = % #`)换成占位,双链 / 公式 / 高亮注释 / 标签胶囊
//    五个消费者一处全认(见 mathLivePreview.buildBlockString)。
// 只前置 ASCII 标点:用户在两个转义字符之间打字会继承 mark,字母前加 `\` 就成了字面反斜杠。
// 仪器:check:rtcorpus 的 d11.*(被编辑的块里逐字 + 看得见字面)、literalEscape.test.ts。
import { config, remarkStringifyOptionsCtx } from '@milkdown/kit/core'
import { $markSchema, $remark } from '@milkdown/kit/utils'
import { LITERAL_ESCAPES } from './mathLivePreview'

/* eslint-disable @typescript-eslint/no-explicit-any */
type MdNode = any

export const ESCAPE_MARK = 'amadeusEscaped'
const NODE = 'amadeusEscape'
/** 序列化期的转义占位(见文件头)。NUL:micromark 把源文里的 NUL 换成 U+FFFD,解析出来的正文里不会有它。 */
export const ESCAPE_SENTINEL = '\u0000'
const ASCII_PUNCT = /[!-/:-@[-`{-~]/g
const SENTINEL_RE = /\u0000(?=[!-/:-@[-`{-~])/g

/** 规范化链末尾:占位换回反斜杠(normalizeSerializedMd / normalizeFragmentMd 的最后一步)。 */
export function restoreEscapeSentinels(md: string): string {
  return md.includes(ESCAPE_SENTINEL) ? md.replace(SENTINEL_RE, '\\') : md
}

/** text 按 LITERAL_ESCAPES 记下的下标拆成 text / amadeusEscape(连续的转义字符并成一个节点)。导出供单测。 */
export function splitLiteralEscapes(tree: MdNode): void {
  const visit = (n: MdNode): void => {
    const kids = n?.children
    if (!Array.isArray(kids)) return
    let touched = false
    const out: MdNode[] = []
    for (const k of kids) {
      const idx: number[] | undefined = k?.type === 'text' ? k.data?.[LITERAL_ESCAPES] : undefined
      if (!idx?.length) {
        visit(k)
        out.push(k)
        continue
      }
      touched = true
      const { [LITERAL_ESCAPES]: _drop, ...data } = k.data
      const base = Object.keys(data).length ? { ...k, data } : (({ data: _d, ...rest }) => rest)(k)
      const value: string = k.value
      const set = new Set(idx.filter((i) => i >= 0 && i < value.length))
      let i = 0
      while (i < value.length) {
        const esc = set.has(i)
        let j = i + 1
        while (j < value.length && set.has(j) === esc) j++
        out.push(esc ? { type: NODE, value: value.slice(i, j) } : { ...base, value: value.slice(i, j) })
        i = j
      }
    }
    if (touched) n.children = out
  }
  visit(tree)
}

/** 读侧 remark:挂在 PARSE_FIDELITY 里紧跟 mathEscapeRemark(记录由它留下,见 restoreMathEscapes)。 */
export const literalEscapeRemark = $remark('amadeusLiteralEscape', () => () => splitLiteralEscapes)

/** 转义过的字符:PM 里是原字符 + 这个 mark。priority 100 = 其它 mark(粗体 / 链接)先开,它最后把文字吃掉(同 inlineCode)。 */
export const literalEscapeSchema = $markSchema(ESCAPE_MARK, () => ({
  inclusive: false,
  priority: 100,
  parseDOM: [{ tag: 'span[data-amx-esc]' }],
  toDOM: () => ['span', { 'data-amx-esc': '' }, 0],
  parseMarkdown: {
    match: (node) => node.type === NODE,
    runner: (state, node, markType) => {
      state.openMark(markType)
      state.addText(String((node as MdNode).value ?? ''))
      state.closeMark(markType)
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === ESCAPE_MARK,
    runner: (state, _mark, node) => {
      state.addNode(NODE, undefined, node.text ?? '')
      return true
    },
  },
}))

/** to-markdown handler:原样发,只在 ASCII 标点前补占位(字母继承了 mark 也不加)。 */
const handleEscape = (node: MdNode): string => String(node.value ?? '').replace(ASCII_PUNCT, (c) => ESCAPE_SENTINEL + c)
// 前一段文字按「后面紧跟 `\`」判转义:它若以字面反斜杠结尾,须写成 `\\`,否则与这里的 `\X` 拼成别的转义。
handleEscape.peek = (): string => '\\'

const literalEscapeHandlers = config((ctx) => {
  ctx.update(remarkStringifyOptionsCtx, (o: any) => ({ ...o, handlers: { ...o.handlers, [NODE]: handleEscape } }))
})

/** 与 preset 同进同出的附属插件(mark + handler),挂在 commonmarkWithIndent。 */
export const literalEscapePlugins = [literalEscapeSchema, literalEscapeHandlers].flat()
/* eslint-enable @typescript-eslint/no-explicit-any */
