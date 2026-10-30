import { describe, it, expect } from 'vitest'
import { protectTranslation } from './translationContent'

describe('translation source protection', () => {
  it('keeps inline/display math, all delimiters, code, link targets and image source byte for byte', () => {
    const source = String.raw`Spin $s=\frac{1}{2}$ and \(\lvert s,m\rangle\).

$$
\begin{pmatrix}1&0\\0&1\end{pmatrix}
$$

\[E=mc^2\]

Use \`not a math delimiter\` and ` + '`$literal$`' + ` and [manual](https://example.org/a_(b) "Title").\n\n~~~ts\nconst s = '$x$';\n~~~\n\n![figure](figure.png)`
    const p = protectTranslation(source)
    expect(p.protected).toBe(true)
    expect(p.text).not.toContain('frac')
    expect(p.text).not.toContain('https://')
    expect(p.text).not.toContain('const s')
    expect(p.text).toContain('manual')
    expect(p.restore(p.text.replace('Spin', '自旋').replace('manual', '手册'))).toBe(source.replace('Spin', '自旋').replace('manual', '手册'))
  })
  it('rejects missing, duplicate, changed and invented markers; permits translated word order', () => {
    const p = protectTranslation('First $x$ then $y$.')
    const markers = p.text.match(/ZXQ\w+?QXZ/g)!
    expect(markers).toHaveLength(2)
    expect(p.restore(p.text.replace(markers[0], ''))).toBeNull()
    expect(p.restore(p.text + markers[0])).toBeNull()
    expect(p.restore(p.text.replace(markers[0], markers[0].toLowerCase()))).toBeNull()
    expect(p.restore(p.text + markers[0].replace('_0QXZ', '_99QXZ'))).toBeNull()
    expect(p.restore(`先 ${markers[1]} 后 ${markers[0]}`)).toBe('先 $y$ 后 $x$')
  })
  it('plain prose stays streaming; escaped dollars and code containing TeX are not reinterpreted', () => {
    const plain = protectTranslation(String.raw`Costs \$5.00 and \$8.00.`)
    expect(plain.protected).toBe(false)
    const source = String.raw`Use ` + '`\(not math\)`' + String.raw` and \\(literal\\).`
    const p = protectTranslation(source)
    expect(p.restore(p.text)).toBe(source)
    expect(p.text).toContain(String.raw`\\(literal\\)`)
  })
  it('protects reference destinations, wiki links as math-free text, and bare URL targets', () => {
    const source = '[Read][book]\n\n[book]: https://example.org "Title"\n\nhttps://example.org/a\n\n[[Note]]'
    const p = protectTranslation(source)
    expect(p.text).not.toContain('https://')
    expect(p.text).not.toContain('[[Note]]')
    expect(p.restore(p.text.replace('Read', '阅读'))).toBe(source.replace('Read', '阅读'))
  })
  it('keeps collapsed and shortcut references bound to the original definition after translating their labels', () => {
    for (const link of ['[Book][]', '[Book]']) {
      const p = protectTranslation(link + '\n\n[Book]: https://example.org')
      expect(p.restore(p.text.replace('Book', '书'))).toBe('[书][Book]\n\n[Book]: https://example.org')
    }
  })
})
