// @vitest-environment happy-dom
// 探针(./enterMode、./lineGap):空行编码与「旧笔记不被改写」的读写闭环。
// 三个口径:saved() = 落盘(含逐字回填);md() = 纯序列化(不逐字,验编码本身是不是不动点);结构 = 重开前后的 PM 文档。
import { afterEach, describe, expect, it } from 'vitest'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { bootEditor } from './parseFidelity.testkit'
import { setEnterModeForTest, type EnterMode } from './enterMode'
import { setCopyWholePositionForTest } from './lineGap'

afterEach(() => setEnterModeForTest('off'))

/** 结构指纹:顶层块类型 + 文字 + 软/硬换行;标题 id 不算。 */
const shape = (doc: PMNode): string => {
  const out: string[] = []
  doc.forEach((n) => {
    let t = ''
    n.descendants((c) => {
      if (c.isText) t += c.text
      else if (c.type.name === 'hardbreak') t += c.attrs.isInline ? '⏎' : '↵'
      return true
    })
    out.push(`${n.type.name}${n.attrs.amxTight ? '+t' : ''}:${t}`)
  })
  return out.join(' | ')
}

const OLD_NOTES: Array<[string, string]> = [
  ['段落之间空一行', 'one\n\ntwo\n\nthree\n'],
  ['空两行', 'a\n\n\nb\n'],
  ['空三行', 'a\n\n\n\nb\n'],
  ['文首文末有空行', '\n\nhead\n\nbody\n\n\n'],
  ['一段里三行单换行', 'line one\nline two\nline three\n'],
  ['粗体跨行', 'x **bold\nacross** y\nnext line\n'],
  ['列表项带单换行', '- item one\n  continued\n- item two\n'],
  ['引用带单换行', '> quote a\n> quote b\n\nafter\n'],
  ['callout 带单换行', '> [!note] Title\n> body a\n> body b\n'],
  ['标题后紧跟正文', '# Title\nbody right after\n\n## Sub\nmore\n'],
  ['混合', '# H\n\npara a\npara b\n\n\n- l1\n- l2\n\n> q\n\n```\ncode\n```\nafter code\n'],
]

/** [名字, 原文, 在哪段文字后面打一个 Z]。前十组 = 过关条件 3「只在别处改」;带「段内」的 = 过关条件 4(改多行段落里的一行)。 */
const EDITS: Array<[string, string, string]> = [
  ['段落之间空一行', 'one\n\ntwo\n\nthree\n', 'three'],
  ['空两行', 'a\n\n\nb\n\nedit\n', 'edit'],
  ['空三行', 'a\n\n\n\nb\n\nedit\n', 'edit'],
  ['文末有空行(改文首那块)', '\n\nhead\n\nbody\n\n\n', 'head'],
  ['文首有空行(改文末那块)', '\n\nhead\n\nbody\n\n\n', 'body'],
  ['一段里三行单换行', 'line one\nline two\nline three\n\nedit\n', 'edit'],
  ['粗体跨行', 'x **bold\nacross** y\nnext line\n\nedit\n', 'edit'],
  ['列表项带单换行', '- item one\n  continued\n- item two\n\nedit\n', 'edit'],
  ['引用带单换行', '> quote a\n> quote b\n\nedit\n', 'edit'],
  ['callout 带单换行', '> [!note] Title\n> body a\n> body b\n\nedit\n', 'edit'],
  ['标题后紧跟正文(改正文)', '# Title\nbody right after\n\n## Sub\nmore\n', 'more'],
  ['标题后紧跟正文(改别段)', '# Title\nbody right after\n\n## Sub\nmore\n\nedit\n', 'edit'],
  ['代码块后紧跟正文', '```\ncode\n```\nafter code\n\nedit\n', 'edit'],
  ['段内:改第二行', 'line one\nline two\nline three\n', 'line two'],
  ['段内:两空格硬换行', 'a one  \nb two\nc three\n', 'b two'],
  ['段内:反斜杠硬换行', 'a one\\\nb two\nc three\n', 'b two'],
  ['段内:行内 br', 'a one<br>\nb two\nc three\n', 'b two'],
  ['段内:续行缩进', 'a one\n   b two\nc three\n', 'b two'],
  ['段内:粗体跨行时改末行', 'x **bold\nacross** y\nnext line\n', 'next line'],
  ['callout 内改一行', '> [!note] Title\n> body a\n> body b\n', 'body b'],
]

const MODES: EnterMode[] = ['off', 'inline', 'line']

describe.each(MODES)('mode=%s', (mode) => {
  it.each(OLD_NOTES)('旧笔记原样:%s', async (_name, md) => {
    setEnterModeForTest(mode)
    const b = await bootEditor(md)
    try {
      // 不编辑直接取:逐字节等于原文
      expect(b.saved()).toBe(md)
      // 纯序列化(不逐字)再解析一次:结构不变(编码是不动点)
      const plain = b.md()
      const again = b.parse(plain)
      expect(shape(again)).toBe(shape(b.view.state.doc))
    } finally { await b.destroy() }
  })

  // 已知没过的格(探针如实记录,不是期望):off = main 现状;两空格硬换行在改同一段时被规范成 `\`(三种模式都一样);
  // 续行缩进只有被改的那一行丢了行首空格,其余行不变;callout 内改一行在 off / inline 下被拆成多段(main 现状)。
  const KNOWN: Record<string, string[]> = {
    off: ['文首有空行(改文末那块)', '标题后紧跟正文(改正文)', '段内:两空格硬换行', '段内:续行缩进', 'callout 内改一行'],
    inline: ['段内:两空格硬换行', '段内:续行缩进', 'callout 内改一行'],
    line: ['段内:两空格硬换行', '段内:续行缩进'],
  }
  for (const [_name, md, target] of EDITS) (KNOWN[mode].includes(_name) ? it.fails : it)(`改一个字,没碰的行逐字不变:${_name}`, async () => {
    setEnterModeForTest(mode)
    const b = await bootEditor(md)
    try {
      // 在含 target 的文本块里、target 之后打一个 Z
      const { state } = b.view
      let at = -1
      state.doc.descendants((n, pos) => {
        if (at < 0 && n.isTextblock) {
          const i = n.textBetween(0, n.content.size, '\n', '\ufffc').indexOf(target)
          if (i >= 0) {
            // 文本偏移 → 文档位置(逐个子节点数过去)
            let off = 0
            n.forEach((c, cOff) => {
              if (at >= 0) return
              const len = c.isText ? c.text!.length : 1
              if (off + len >= i + target.length) at = pos + 1 + cOff + (i + target.length - off)
              off += len
            })
          }
        }
        return at < 0
      })
      expect(at).toBeGreaterThan(-1)
      b.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, at)).insertText('Z'))
      const out = b.saved()
      const k = md.indexOf(target) + target.length
      const want = md.slice(0, k) + 'Z' + md.slice(k)
      if (out !== want) console.log('[diff]', mode, _name, JSON.stringify(out), 'want', JSON.stringify(want))
      expect(out).toBe(want)
      // 存出来的再当新笔记打开,不编辑直接取:逐字节相同;纯序列化重开结构不变
      const b2 = await bootEditor(out)
      try {
        expect(b2.saved()).toBe(out)
        expect(shape(b2.parse(b2.md()))).toBe(shape(b2.view.state.doc))
      } finally { await b2.destroy() }
    } finally { await b.destroy() }
  })
})

describe('路线二:只改多行段落里的一行(位置错配会把整段旧原文带回来)', () => {
  it('改第二行,第一、三行逐字不变、不重复', async () => {
    setEnterModeForTest('line')
    const md = 'alpha one\nbeta two\ngamma three\n'
    const b = await bootEditor(md)
    try {
      expect(shape(b.view.state.doc)).toBe('paragraph:alpha one | paragraph:beta two | paragraph:gamma three')
      const { state } = b.view
      let at = -1
      state.doc.descendants((n, pos) => { if (n.isTextblock && n.textContent === 'beta two') at = pos + n.nodeSize - 1; return true })
      b.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, at)).insertText('Z'))
      expect(b.saved()).toBe('alpha one\nbeta twoZ\ngamma three\n')
    } finally { await b.destroy() }
  })

  it('对照:按旧 softBreak 的做法把整段位置复制给每一行 → 没改的行领到整段旧原文', async () => {
    setEnterModeForTest('line')
    setCopyWholePositionForTest(true)
    const md = 'alpha one\nbeta two\ngamma three\n'
    const b = await bootEditor(md)
    try {
      const { state } = b.view
      let at = -1
      state.doc.descendants((n, pos) => { if (n.isTextblock && n.textContent === 'beta two') at = pos + n.nodeSize - 1; return true })
      b.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, at)).insertText('Z'))
      const out = b.saved()
      // 记下实际输出,断言它是错的(旧内容被带回 / 重复)
      console.log('[copy-position control] saved =', JSON.stringify(out))
      expect(out).not.toBe('alpha one\nbeta twoZ\ngamma three\n')
    } finally { setCopyWholePositionForTest(false); await b.destroy() }
  })
})
