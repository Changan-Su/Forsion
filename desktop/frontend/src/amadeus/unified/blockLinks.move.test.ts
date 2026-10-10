import path from 'node:path'
import { describe, expect, it } from 'vitest'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { joinRel } from '@amadeus-shared/assets'
import { hrefKind, noteLinkTarget } from '../blocks/markdown/linkHref'
import { appendToNote, endsInsideOpenBlock, rebaseRelativeLinks } from './blockLinks'

/** remark 认出来的链接地址(没被认成链接的不在里面)。 */
const linkUrls = (md: string): string[] => {
  const out: string[] = []
  const walk = (n: { type: string; url?: string; children?: unknown[] }): void => {
    if (n.type === 'link') out.push(n.url ?? '')
    for (const c of n.children ?? []) walk(c as never)
  }
  walk(unified().use(remarkParse).use(remarkGfm).parse(md) as never)
  return out
}

/** 定种子的随机数(mulberry32):rnd(n) ∈ [0, n)。 */
const rng = (seed: number) => (n: number): number => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) % n
}

// B-15「移动到…」的三处落盘保真(Codex 复核):相对链接跨目录重算、目标末尾未收尾不追加、追加不改写目标原文。
describe('moveBlocksTo helpers', () => {
  it('rebases relative md links across folders, leaves images / urls / anchors / fences alone', () => {
    const md = '见 [文档](../Other.md#sec) 与 [外链](https://x.io/a) [锚](#h) ![图](pic.png)\n\n```\n[代码](a.md)\n```'
    expect(rebaseRelativeLinks(md, 'a/b', 'c')).toBe('见 [文档](../a/Other.md#sec) 与 [外链](https://x.io/a) [锚](#h) ![图](pic.png)\n\n```\n[代码](a.md)\n```')
    expect(rebaseRelativeLinks('[x](y.md)', 'a', 'a')).toBe('[x](y.md)')
    expect(rebaseRelativeLinks('[x](y.md)', '', 'd/e')).toBe('[x](../../y.md)')
  })
  // 2026-10-10:源目录名原样拼进地址 —— 带空格的写出来不是链接(一行死字),带 # ? & | 的被读的一侧读成别的东西。
  it('目录名里的空格 / 括号 / % / # / ? / | 写进地址前先编码;链接里原有的段一个字节不动', () => {
    // 负对照:目录名不编码就拼 → 前五句红
    expect(rebaseRelativeLinks('[doc](x.pdf)', 'my notes', 'other')).toBe('[doc](../my%20notes/x.pdf)')
    expect(rebaseRelativeLinks('[doc](sub/x.pdf)', 'export (1)', '')).toBe('[doc](export%20%281%29/sub/x.pdf)')
    expect(rebaseRelativeLinks('[n](y.md#节)', '50% #1/a', 'b')).toBe('[n](../50%25%20%231/a/y.md#节)')
    expect(rebaseRelativeLinks('| [d](x.pdf) |', 'a|b?c', 'z')).toBe('| [d](../a%7Cb%3Fc/x.pdf) |')
    expect(rebaseRelativeLinks('[d](x%20y.pdf "t")', '读书 笔记', '')).toBe('[d](读书%20笔记/x%20y.pdf "t")') // 原有的段原样;非 ASCII 不编码
    // 目标目录只拿来比对:带空格的公共前缀照样认得出
    expect(rebaseRelativeLinks('[d](x.pdf)', 'my notes/a', 'my notes/b')).toBe('[d](../a/x.pdf)')
  })
  it('各种目录名:写出去的仍是 remark 认的链接,读的一侧读回来还是原来那个文件', () => {
    // 读的一侧:笔记走 linkHref.noteLinkTarget;附件照主进程 resolveAttachment 带 `/` 的那一支(整段解码后按页目录拼)。
    const dirs = ['my notes', 'export (1)', '50% off', 'a#b', 'what?', 'R&D', 'a&amp;b', 'a|b', "it's", 'say "hi"', 'a`b', '[x]', 'a*b', 'foo:bar', 'a<b>', '读书\u3000笔记', 'a\u00a0b', 'v1.2', '📁 资料', 'café']
    for (const dir of dirs) for (const to of ['other', '']) {
      const out = rebaseRelativeLinks('[n](y.md) 与 [d](sub/x.pdf)', `${dir}/in`, to)
      const urls = linkUrls(out)
      expect(urls.length, `${JSON.stringify(dir)} → ${out}`).toBe(2)
      expect([hrefKind(urls[0]), hrefKind(urls[1])], out).toEqual(['note', 'file'])
      expect(noteLinkTarget(urls[0], path.posix.join(to, 't.md')), out).toBe(`${dir}/in/y.md`)
      expect(path.posix.join(to, decodeURIComponent(urls[1])), out).toBe(`${dir}/in/sub/x.pdf`)
    }
  })
  it('结果是单段文件名 / 形似域名的:补 ./(否则附件按文件名全库找、形似域名的被当成外链)', () => {
    // 负对照:不补 ./ → 红
    expect(rebaseRelativeLinks('[d](../c/x.pdf)', 'a', 'c')).toBe('[d](./x.pdf)')
    expect(rebaseRelativeLinks('[n](../c/y.md#h)', 'a', 'c')).toBe('[n](./y.md#h)')
    expect(rebaseRelativeLinks('[d](x.pdf)', 'v1.2', '')).toBe('[d](./v1.2/x.pdf)')
  })
  it('读的一侧当成外链的写法(形似域名、没写协议)不改', () => {
    // 负对照:只按协议头认外链 → 红(被改成 ../a/forsion.net/docs 这种取不到的相对路径)
    const md = '[官网](forsion.net/docs) [x](example.com) [m](mailto:a@b.c)'
    expect(rebaseRelativeLinks(md, 'a', 'c')).toBe(md)
  })
  it('第一个 # 之后的原样接回(第二个 # 以后的不丢)', () => {
    // 负对照:按 # 切开只取前两段 → 红(「#二」丢了)
    expect(rebaseRelativeLinks('[n](y.md#一#二)', 'a', 'c')).toBe('[n](../a/y.md#一#二)')
  })
  it('链接自己带着解不开的 %:读的一侧整段按字面读 —— 目录名里的 % 按字面比、按字面写;非编码不可的源目录名得写进去时才整条不动', () => {
    // 负对照 a(评审 1 的原样):源目录名里有要编码的段就不动,不看它写不写进结果 → 第二、四句红
    // 负对照 b:不分这一档,照样编码后比、编码后写 → 第一、四、五句红
    // 负对照 c(评审 2 的原样):记号不垫空格(编码后的目录名直接和链接自己的段比)→ 第一、三句红
    expect(rebaseRelativeLinks('[d](100%.pdf)', 'my notes', 'c')).toBe('[d](100%.pdf)') // 只能写成 ../my%20notes/…,读的一侧这回不解码
    expect(rebaseRelativeLinks('[d](sub/100%.pdf)', 'my notes/a', 'my notes/b')).toBe('[d](../a/sub/100%.pdf)') // 评审 1:公共的那段用不着写出来
    expect(rebaseRelativeLinks('[d](./my%20notes/100%.pdf)', '', 'my notes')).toBe('[d](../my%20notes/100%.pdf)') // 评审 2:字面叫 my%20notes 的目录 ≠ 目标目录 my notes
    expect(rebaseRelativeLinks('[d](50%/100%.pdf)', 'my notes/a', 'my notes/a/50%')).toBe('[d](./100%.pdf)') // 目录名里的 % 按字面比
    expect(rebaseRelativeLinks('[d](100%.pdf)', '50%', 'c')).toBe('[d](../50%/100%.pdf)') // % 按字面写得进去
    expect(rebaseRelativeLinks('[d](x.pdf)', '50%', 'c')).toBe('[d](../50%25/x.pdf)') // 对照:解得开的那一档,% 要编码
    expect(rebaseRelativeLinks('[d](sub/100%.pdf)', 'a', 'c')).toBe('[d](../a/sub/100%.pdf)')
  })
  it('目录名用不着编码时,结果和原先的算法逐字相同(只多出补 ./ 一处)—— 随机对拍', () => {
    // 负对照 d(评审 3 的原样):源目录名带反斜杠就整篇不动 → 红
    const old = (md: string, fromDir: string, toDir: string): string => {
      const norm = (p: string): string => { const o: string[] = []; for (const s of p.split('/')) { if (!s || s === '.') continue; if (s === '..' && o.length && o[o.length - 1] !== '..') o.pop(); else o.push(s) } return o.join('/') }
      const rel = (f: string, v: string): string => { const a = f ? f.split('/') : []; const b = v.split('/'); let i = 0; while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++; return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/') }
      return md.replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, (_m, text: string, href: string) => `[${text}](${rel(toDir, norm(joinRel(fromDir, href)))})`)
    }
    const rnd = rng(20261010)
    const pick = <T,>(xs: T[]): T => xs[rnd(xs.length)]
    const dir = (): string => Array.from({ length: rnd(4) }, () => pick(['a', 'b', 'c', '读', 'v1', 'a\\b'])).join('/')
    let backslash = 0
    for (let i = 0; i < 3000; i++) {
      const [from, to] = [dir(), dir()]
      if (from === to) continue
      const href = `${pick(['./', '../', '../../', 'a/', 'sub/'])}${Array.from({ length: rnd(3) }, () => pick(['..', '.', 'a', 'b', 'p%20q', '100%', 'z%2Fw', 'my%20notes'])).map((s) => `${s}/`).join('')}${pick(['x.pdf', 'y.md', '100%.pdf', 'p%20q.md'])}`
      const md = `[t](${href})`
      const was = old(md, from, to)
      expect([was, was.replace('](', '](./')], `${md}  ${from} → ${to}`).toContain(rebaseRelativeLinks(md, from, to))
      if (from.includes('\\') && was !== md) backslash++
    }
    expect(backslash).toBeGreaterThan(200) // 防空过
  })
  it('随机目录名 × 随机链接:改完之后读的一侧读到的还是原来那个文件;留着不改的只有「按字面读 + 源目录名非编码不可」', () => {
    // 读的一侧(主进程 resolveAttachment 带 `/` 的那一支):整段 decodeURIComponent,解不开就按字面;再按页目录拼。
    const literal = (url: string): boolean => { try { decodeURIComponent(url); return false } catch { return true } }
    const read = (url: string, dir: string): string => path.posix.join(dir, literal(url) ? url : decodeURIComponent(url))
    const rnd = rng(7)
    const pick = <T,>(xs: T[]): T => xs[rnd(xs.length)]
    const dir = (): string => Array.from({ length: rnd(4) }, () => pick(['my notes', 'a#b', '50%', 'q?', 'R&D', 'x|y', '(1)', '读 书', 'v1.2', 'plain', '%20', 'my%20notes'])).join('/')
    let [moved, movedLiteral, kept] = [0, 0, 0]
    for (let i = 0; i < 6000; i++) {
      const [from, to] = [dir(), dir()]
      if (from === to) continue
      const href = `${pick(['./', '../', '../../', 'sub/', 'plain/'])}${Array.from({ length: rnd(3) }, () => pick(['..', 'sub', 'p%20q', 'my%20notes', 'R%26D', 'plain', '50%', '%20'])).map((s) => `${s}/`).join('')}${pick(['x.pdf', 'p%20q.pdf', '读.pdf', '100%.pdf'])}`
      const want = read(href, from)
      if (want.startsWith('..')) continue // 指到库外的不看
      const md = `[t](${href})`
      const out = rebaseRelativeLinks(md, from, to)
      const note = `${href}  ${JSON.stringify(from)} → ${JSON.stringify(to)}  得 ${out}`
      if (out === md && read(href, to) !== want) { // 留着没改,而且不改就指到别处去了
        expect(literal(href), note).toBe(true)
        expect(/[\s#?&|()]/.test(from), note).toBe(true)
        kept++
        continue
      }
      const urls = linkUrls(out)
      expect(urls.length, note).toBe(1)
      if (literal(urls[0]) !== literal(href)) continue // 解不开的那段被 .. 抵掉了:原先就有的口子(见函数头注)
      expect(hrefKind(urls[0]), note).toBe('file')
      expect(read(urls[0], to), note).toBe(want)
      moved++
      if (literal(href)) movedLiteral++
    }
    expect([moved > 2000, movedLiteral > 300, kept > 50], `${moved} / ${movedLiteral} / ${kept}`).toEqual([true, true, true]) // 防空过
  })
  it('detects an unclosed fence or html comment at the end', () => {
    expect(endsInsideOpenBlock('正文\n\n```js\nconst a = 1\n')).toBe(true)
    expect(endsInsideOpenBlock('正文\n<!-- 注释没收尾\n')).toBe(true)
    expect(endsInsideOpenBlock('```js\nx\n```\n\n<!-- ok -->\n')).toBe(false)
    expect(endsInsideOpenBlock('````\n```\n````\n')).toBe(false)
  })
  it('appends without touching the original text, keeping CRLF', () => {
    expect(appendToNote('甲\n\n\n', 'X')).toBe('甲\n\n\nX\n')
    expect(appendToNote('甲', 'X')).toBe('甲\n\nX\n')
    expect(appendToNote('甲\n', 'X')).toBe('甲\n\nX\n')
    expect(appendToNote('甲\r\n乙\r\n', 'X\nY')).toBe('甲\r\n乙\r\n\r\nX\r\nY\r\n')
    expect(appendToNote('', 'X')).toBe('X\n')
  })
})
