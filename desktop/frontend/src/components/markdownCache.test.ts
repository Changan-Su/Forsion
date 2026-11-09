import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'
import remarkCjkFriendly from 'remark-cjk-friendly/parseOnly'
import remarkCjkFriendlyStrikethrough from 'remark-cjk-friendly-gfm-strikethrough/parseOnly'
import remarkRehype from 'remark-rehype'
import rehypeKatex from 'rehype-katex'
import { VFile } from 'vfile'
import type { Root } from 'hast'
import { parseMarkdown, remarkCachedParse } from './markdownParse'
import { rehypeCachedKatex } from './rehypeCachedKatex'
import { remarkHeadingAnchors } from './streamingMarkdown'

describe('Markdown parse cache', () => {
  const reference = unified().use(remarkParse).use(remarkMath).use(remarkGfm)
    .use(remarkCjkFriendly).use(remarkCjkFriendlyStrikethrough)
  it.each([
    '**中文：**正文 ~~删除~~\n\n- [x] task\n\nA | B\n---|---\nx | y',
    '# title\r\n\r\n$x^2$\n\n$$\na+b\n$$\n\n```math\nc+d\n```',
    '[link][ref] and footnote[^n]\n\n[ref]: https://example.com\n[^n]: text',
    '> quoted\n>\n> - nested\n\n    code\n\n\uFEFF# literal',
  ])('retains the original grammar and isolates returned trees: %s', (source) => {
    expect(parseMarkdown(source)).toEqual(reference.parse(source))
    const mutated = parseMarkdown(source)
    mutated.children.length = 0
    expect(parseMarkdown(source)).toEqual(reference.parse(source))
  })
  it('never reuses a previous message heading prefix', () => {
    const make = (prefix: string) => unified().use(remarkParse).use(remarkCachedParse).use(remarkHeadingAnchors, { prefix })
    const a = make('a'), b = make('b')
    const first = a.runSync(a.parse('# Same heading'))
    const second = b.runSync(b.parse('# Same heading'))
    expect(JSON.stringify(first)).toContain('a-0')
    expect(JSON.stringify(second)).toContain('b-0')
    expect(JSON.stringify(second)).not.toContain('a-0')
  })
})

describe('KaTeX fragment cache', () => {
  const parser = unified().use(remarkParse).use(remarkMath).use(remarkRehype)
  const original = rehypeKatex()
  const cached = rehypeCachedKatex()
  it.each([
    'Inline $x^2+y^2=z^2$ twice $x^2+y^2=z^2$.',
    '$$\nx=\\frac{a+b}{c}\n$$\n\n```math\nx=\\frac{a+b}{c}\n```',
    '$x$\n\n$$\nx\n$$',
    '$\\unknownCommand{x}$ and $\\sqrt{$',
    '> $\\unknownCommand{x}$\n\n- $$\\unknownCommand{x}$$',
    '$\\href{javascript:alert(1)}{unsafe}$',
    '$\\gdef\\foo{bar}\\foo$ then $\\foo$',
  ])('matches uncached output, errors and repeated rendering: %s', (source) => {
    const tree = parser.runSync(parser.parse(source)) as Root
    const expected = structuredClone(tree), expectedFile = new VFile(source)
    original(expected, expectedFile)
    for (let i = 0; i < 2; i++) {
      const result = structuredClone(tree), file = new VFile(source)
      cached(result, file)
      expect(result).toEqual(expected)
      const diagnostic = (m: VFile['messages'][number]) => [m.reason, m.line, m.column,
        m.ancestors?.map((n) => [n.type, 'tagName' in n ? n.tagName : null, n.position])]
      expect(file.messages.map(diagnostic)).toEqual(expectedFile.messages.map(diagnostic))
      result.children.length = 0 // downstream transforms must not mutate cached fragments
    }
  })
})
