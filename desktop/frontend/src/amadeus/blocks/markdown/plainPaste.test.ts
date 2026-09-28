// D-10(拍板 #12)纯文本多行粘贴的判定与转换。接线(真 paste 事件 → 一行一段 → 落盘)在台架:npm run check:pastefidelity。
import { describe, expect, it } from 'vitest'
import { isPlainMultiline, looksLikeMarkdown, plainLinesToParagraphs, singleLinePasteMode } from './plainPaste'

describe('plainPaste', () => {
  it('地址 / 终端输出 / 纯文本邮件 = 纯文本多行', () => {
    for (const t of ['Alice Zhang\nRoom 1203\nBeijing 100000', '收件人：张三\r\n电话：138', 'total 8\n-rw-r--r--  1 u staff 0 file', '5 * 3 = 15\nsnake_case ok'])
      expect(isPlainMultiline(t), t).toBe(true)
  })
  it('像 markdown 的保留 CommonMark 语义(块级或成对行内标记)', () => {
    for (const t of ['- a\n- b', '1. a\n2. b', '# 标题\n正文', '> 引用\n续', '```\ncode\n```', '| a | b |\n|---|---|', 'a\n---', '**要点**第一行\n第二行', '见 [文档](https://x.com)\n下一行', '[[笔记]]\n下一行', '- [ ] 待办\n- [x] 完成',
      // Codex 复核漏判的三类:无首尾 `|` 的 GFM 表格、缩进代码(4 空格 / Tab)、`%%` 注释(含跨行)
      'Name | Age\n--- | ---\nAda | 37', 'a | b\n:-- | --:\n1 | 2', '    x = 1\n    y = 2', '说明\n\tcode', '%%\n注释\n%%', '可见 %%藏%% 字\n下一行'])
      expect(looksLikeMarkdown(t), t).toBe(true)
  })
  it('单行 / 已是一行一段的不处理(转换后重入即停)', () => {
    expect(isPlainMultiline('单行文字')).toBe(false)
    expect(isPlainMultiline('尾随换行\n')).toBe(false)
    expect(isPlainMultiline(plainLinesToParagraphs('a\nb\nc'))).toBe(false)
  })
  it('单个 \\n → 段落分隔;已有空行与 CRLF', () => {
    expect(plainLinesToParagraphs('a\nb\n\nc')).toBe('a\n\nb\n\nc')
    expect(plainLinesToParagraphs('a\r\nb\rc')).toBe('a\n\nb\n\nc')
  })
})

describe('singleLinePasteMode(D-13:单行粘进一段已有文字的中间)', () => {
  it('解析出块结构 → 原文逐字;单段落 → 照常解析;首尾空白 → 补回', () => {
    expect(singleLinePasteMode('2024. A good year', ['ordered_list'])).toBe('literal')
    expect(singleLinePasteMode('# 标题', ['heading'])).toBe('literal')
    expect(singleLinePasteMode('**粗**', ['paragraph'])).toBe('default')
    expect(singleLinePasteMode(' world ', ['paragraph'])).toBe('inline-ws')
    expect(singleLinePasteMode('a', [])).toBe('literal')
  })
})
