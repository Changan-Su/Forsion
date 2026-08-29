/** PDF 链接子路径编解码往返 + PDF 目标识别。 */
import { describe, it, expect } from 'vitest'
import {
  isPdfLinkInner, encodePdfSubpath, parsePdfSubpath, parsePdfLinkInner, buildPdfLink,
  parseLineSubpath, splitLinkInner, findHeadingIndex,
  parseMediaSubpath, encodeMediaSubpath, parseMediaLinkInner, buildMediaLink, mediaLabel, isMediaPath,
  withTextFragment, webCiteKey,
  parseBlockSubpath, trailingBlockId, isLoneBlockId,
} from './pdfLink'

describe('pdfLink codec', () => {
  it('encode/parse 往返:page + color + annot', () => {
    const loc = { page: 3, color: 'yellow', annot: 'a1' }
    expect(parsePdfSubpath(encodePdfSubpath(loc))).toEqual(loc)
    expect(encodePdfSubpath(loc)).toBe('page=3&color=yellow&annot=a1')
  })

  it('encode 只有 page', () => {
    expect(encodePdfSubpath({ page: 5 })).toBe('page=5')
    expect(parsePdfSubpath('page=5')).toEqual({ page: 5 })
  })

  it('parse 容忍前导 # 与顺序', () => {
    expect(parsePdfSubpath('#annot=x&page=2')).toEqual({ page: 2, annot: 'x' })
  })

  it('page 非法/缺失 → null(不能定位)', () => {
    expect(parsePdfSubpath('color=red')).toBeNull()
    expect(parsePdfSubpath('page=0')).toBeNull()
    expect(parsePdfSubpath('')).toBeNull()
  })

  it('page 落地钳到 >=1', () => {
    expect(encodePdfSubpath({ page: 0 })).toBe('page=1')
    expect(encodePdfSubpath({ page: -3 })).toBe('page=1')
  })

  it('color 含特殊字符走 encode/decode', () => {
    const s = encodePdfSubpath({ page: 1, color: '#ff0 亮' })
    expect(parsePdfSubpath(s)).toEqual({ page: 1, color: '#ff0 亮' })
  })

  it('isPdfLinkInner 识别 .pdf(含子路径/别名/路径)', () => {
    expect(isPdfLinkInner('report.pdf')).toBe(true)
    expect(isPdfLinkInner('report.pdf#page=2')).toBe(true)
    expect(isPdfLinkInner('a/b.pdf|封面')).toBe(true)
    expect(isPdfLinkInner('note#heading')).toBe(false)
    expect(isPdfLinkInner('pic.png')).toBe(false)
  })

  it('parsePdfLinkInner 拆 target + loc;非 pdf → null', () => {
    expect(parsePdfLinkInner('report.pdf#page=3&annot=a1')).toEqual({
      target: 'report.pdf', loc: { page: 3, annot: 'a1' },
    })
    expect(parsePdfLinkInner('report.pdf')).toEqual({ target: 'report.pdf', loc: null })
    expect(parsePdfLinkInner('report.pdf#page=2|别名')?.loc).toEqual({ page: 2 }) // 规范序:target#sub|alias
    expect(parsePdfLinkInner('note#page=2')).toBeNull()
  })

  it('buildPdfLink 生成可粘贴 wikilink', () => {
    expect(buildPdfLink('report.pdf', { page: 3, annot: 'a1' })).toBe('[[report.pdf#page=3&annot=a1]]')
  })
})

describe('q=引语(临时高亮,不写盘)', () => {
  it('编解码往返:空格/中文/& 都能安全带过去', () => {
    const loc = { page: 12, q: 'The aim of this book & 中文' }
    const sub = encodePdfSubpath(loc)
    expect(sub).toBe('page=12&q=The%20aim%20of%20this%20book%20%26%20%E4%B8%AD%E6%96%87')
    expect(parsePdfSubpath(sub)).toEqual(loc)
  })
  it('模型手写没编码(空格原样)也认', () => {
    expect(parsePdfSubpath('page=3&q=the aim of this book')?.q).toBe('the aim of this book')
  })
  it('裸 % 不合法也不废掉整条引用', () => {
    expect(parsePdfSubpath('page=3&q=100%的把握')?.q).toBe('100%的把握')
  })
  it('没写 q → 不带该字段', () => {
    expect(parsePdfSubpath('page=3')).toEqual({ page: 3 })
  })
})

describe('行号锚点(代码/文本引用,GitHub #L 约定)', () => {
  it('单行/范围/小写 l/L42-48 缩写都认', () => {
    expect(parseLineSubpath('L42')).toEqual({ from: 42 })
    expect(parseLineSubpath('#L42')).toEqual({ from: 42 })
    expect(parseLineSubpath('L42-L48')).toEqual({ from: 42, to: 48 })
    expect(parseLineSubpath('L42-48')).toEqual({ from: 42, to: 48 })
    expect(parseLineSubpath('l7-l9')).toEqual({ from: 7, to: 9 })
  })
  it('倒序/相等范围折叠成单行;0 与非法形态一律 null', () => {
    expect(parseLineSubpath('L9-L3')).toEqual({ from: 9 })
    expect(parseLineSubpath('L5-L5')).toEqual({ from: 5 })
    expect(parseLineSubpath('L0')).toBeNull()
    expect(parseLineSubpath('Lx')).toBeNull()
    expect(parseLineSubpath('page=3')).toBeNull()
    expect(parseLineSubpath('标题')).toBeNull()
    expect(parseLineSubpath('L42extra')).toBeNull()
  })
})

describe('splitLinkInner(带锚点的通用内文拆分)', () => {
  it('target/subpath/别名拆解', () => {
    expect(splitLinkInner('src/a.ts#L42')).toEqual({ target: 'src/a.ts', subpath: 'L42' })
    expect(splitLinkInner('笔记#秋日')).toEqual({ target: '笔记', subpath: '秋日' })
    expect(splitLinkInner('a.ts#L1|别名')).toEqual({ target: 'a.ts', subpath: 'L1' })
    expect(splitLinkInner('无锚点')).toEqual({ target: '无锚点', subpath: null })
    expect(splitLinkInner('尾空#')).toEqual({ target: '尾空', subpath: null })
  })
})

describe('findHeadingIndex(标题锚点解析,嵌套链按祖先校验)', () => {
  // 标题文本 = PM 纯文本(格式字符已不在;`_` 是正文)
  const hs = [
    { level: 1, text: '总览' },      // 0
    { level: 2, text: 'API A' },     // 1
    { level: 3, text: 'Usage' },     // 2
    { level: 2, text: 'API_B' },     // 3
    { level: 3, text: 'Usage' },     // 4
    { level: 2, text: '加粗节' },    // 5
    { level: 2, text: 'foo_bar' },   // 6
    { level: 2, text: 'foobar' },    // 7
  ]
  it('单段:全文档首个同名(Obsidian 同语义)、大小写不敏感;锚点侧剥行内格式', () => {
    expect(findHeadingIndex(hs, 'Usage')).toBe(2)
    expect(findHeadingIndex(hs, 'usage')).toBe(2)
    expect(findHeadingIndex(hs, '**加粗**节')).toBe(5) // 锚点从原文 md 抄来带格式
  })
  it('精确匹配压过剥格式:`foo_bar` 与 `foobar` 是两个标题,绝不并档(Codex 二审)', () => {
    expect(findHeadingIndex(hs, 'foo_bar')).toBe(6)
    expect(findHeadingIndex(hs, 'foobar')).toBe(7)
    expect(findHeadingIndex(hs, 'API_B#Usage')).toBe(4)
    expect(findHeadingIndex(hs, 'APIB#Usage')).toBe(-1) // 没有叫 APIB 的父标题,不许蹭 API_B
  })
  it('嵌套链:两个父标题下都有同名子标题时,链对得上的那个才中(Codex 一审 high)', () => {
    expect(findHeadingIndex(hs, 'API A#Usage')).toBe(2)
    expect(findHeadingIndex(hs, 'API_B#Usage')).toBe(4)
    expect(findHeadingIndex(hs, '总览#API_B#Usage')).toBe(4)
  })
  it('允许跳级;链不匹配 → -1(不跳,绝不静默跳错)', () => {
    expect(findHeadingIndex(hs, '总览#Usage')).toBe(2) // 跳过中间级
    expect(findHeadingIndex(hs, '不存在#Usage')).toBe(-1)
    expect(findHeadingIndex(hs, 'API A#没有这节')).toBe(-1)
    expect(findHeadingIndex(hs, '')).toBe(-1)
  })
})

describe('媒体时间锚点 #t=', () => {
  it('解析三形:纯秒 / MM:SS / HH:MM:SS,小数秒保留', () => {
    expect(parseMediaSubpath('t=95')).toEqual({ at: 95 })
    expect(parseMediaSubpath('#t=01:35')).toEqual({ at: 95 })
    expect(parseMediaSubpath('t=1:02:30')).toEqual({ at: 3750 })
    expect(parseMediaSubpath('t=95.5')).toEqual({ at: 95.5 })
  })

  it('区间:to > at 才留,倒序/相等一律折叠成单点', () => {
    expect(parseMediaSubpath('t=95,120')).toEqual({ at: 95, to: 120 })
    expect(parseMediaSubpath('t=95,95')).toEqual({ at: 95, badTo: true })
    expect(parseMediaSubpath('t=120,95')).toEqual({ at: 120, badTo: true })
    expect(parseMediaSubpath('t=,120')).toEqual({ at: 0, to: 120 })
    // 终点坏掉时**降级成单点锚 + badTo 标记**,不整条判非法 —— 判非法会让起点也丢掉、从 0 秒
    // 起播(更坏);而 badTo 保证「降级 ≠ 静默」:引用条的 title 据此说明终点被忽略(Codex 三/四审)。
    expect(parseMediaSubpath('t=95,foo')).toEqual({ at: 95, badTo: true })
    expect(parseMediaSubpath('t=95,')).toEqual({ at: 95, badTo: true })
    expect(parseMediaSubpath('t=95,80')).toEqual({ at: 95, badTo: true })
    expect(parseMediaSubpath('t=95,1:35')).toEqual({ at: 95, badTo: true })   // 钟表形态的终点同样只是降级
    expect(parseMediaSubpath('t=95,120,200')).toEqual({ at: 95, to: 120 }) // 多出的段忽略
  })

  it('⚠️ `t=1:35` 判非法 —— 抄 Logseq #9920 的血(10:44 被当成 10 小时 44 分)', () => {
    expect(parseMediaSubpath('t=1:35')).toBeNull()
    // 光杆 `t=` 是非法,**不是**「从 0 秒开始」—— 静默变 0 秒正是本模块要堵的失败形态(Codex 评审)
    expect(parseMediaSubpath('t=')).toBeNull()
    expect(parseMediaSubpath('#t=  ')).toBeNull()
    // 超长数字串 Number() 给 Infinity,能溜过「>= 0」的守卫,一路走到 currentTime = Infinity
    expect(parseMediaSubpath('t=' + '9'.repeat(400))).toBeNull()
    expect(parseMediaSubpath('t=1e9')).toBeNull() // 科学计数法不在 NPT 语法里
    expect(parseMediaSubpath('t=99:30')).toBeNull() // MM 必须 00-59
    expect(parseMediaSubpath('t=abc')).toBeNull()
    expect(parseMediaSubpath('t=-5')).toBeNull()
  })

  it('与其余三族锚点互斥:page= / L42 / 标题一概不认(反之亦然)', () => {
    expect(parseMediaSubpath('page=3')).toBeNull()
    expect(parseMediaSubpath('L42')).toBeNull()
    expect(parseMediaSubpath('某标题')).toBeNull()
    expect(parseLineSubpath('t=95')).toBeNull()
    expect(parsePdfSubpath('t=95')).toBeNull()
  })

  it('parseMediaLinkInner:非音视频后缀 → 整条 null(笔记标题锚不许被抢走)', () => {
    expect(parseMediaLinkInner('笔记.md#t=90')).toBeNull()
    expect(parseMediaLinkInner('书.pdf#page=3')).toBeNull()
    expect(parseMediaLinkInner('a.mp4#t=95')).toEqual({ target: 'a.mp4', loc: { at: 95 } })
    expect(parseMediaLinkInner('声音.m4a#t=01:35')).toEqual({ target: '声音.m4a', loc: { at: 95 } })
  })

  it('锚点解不开时 loc=null 而非整条 null —— 调用方照样渲播放器,不许落「嵌入丢失」', () => {
    expect(parseMediaLinkInner('a.mp4#t=1:35')).toEqual({ target: 'a.mp4', loc: null })
    expect(parseMediaLinkInner('a.mp4#page=3')).toEqual({ target: 'a.mp4', loc: null })
    expect(parseMediaLinkInner('a.mp4')).toEqual({ target: 'a.mp4', loc: null })
  })

  it('别名先剥再判:`[[a.mp4#t=95|01:35]]` 的别名不进 target', () => {
    expect(parseMediaLinkInner('a.mp4#t=95|01:35')).toEqual({ target: 'a.mp4', loc: { at: 95 } })
    expect(parseMediaLinkInner('dir/a.mp4|封面')).toEqual({ target: 'dir/a.mp4', loc: null })
  })

  it('encode 恒整数秒;buildMediaLink 缺省补人类可读别名', () => {
    expect(encodeMediaSubpath({ at: 95.7 })).toBe('t=96')
    expect(encodeMediaSubpath({ at: 95, to: 120 })).toBe('t=95,120')
    expect(buildMediaLink('a.mp4', { at: 95 })).toBe('[[a.mp4#t=95|01:35]]')
    expect(buildMediaLink('a.mp4', { at: 95 }, '')).toBe('[[a.mp4#t=95]]')
    expect(buildMediaLink('a.mp4', { at: 95 }, '这一段')).toBe('[[a.mp4#t=95|这一段]]')
  })

  it('mediaLabel 与 npt 解析口径对称(往返)', () => {
    for (const s of [0, 5, 95, 3750, 3599]) {
      expect(parseMediaSubpath(`t=${mediaLabel(s)}`)).toEqual({ at: s })
    }
  })

  it('isMediaPath 刻意不含 mkv/avi(那份是文件图标口径,合并会渲染出播不动的黑框)', () => {
    expect(isMediaPath('a.mp4')).toBe(true)
    expect(isMediaPath('a.flac')).toBe(true)
    expect(isMediaPath('a.mkv')).toBe(false)
    expect(isMediaPath('a.avi')).toBe(false)
    expect(isMediaPath('a.md')).toBe(false)
  })

  it('withTextFragment 把引语挂成 Chromium 的文本片段(逗号/&必须编码,否则从中截断)', () => {
    expect(withTextFragment('https://a.com/p', 'the aim of this book'))
      .toBe('https://a.com/p#:~:text=the%20aim%20of%20this%20book')
    // 页面自带锚点 → 追加而不是覆盖(#install:~:text= 是规范形态,两者共存)
    expect(withTextFragment('https://a.com/p#install', 'the aim of this book'))
      .toBe('https://a.com/p#install:~:text=the%20aim%20of%20this%20book')
    // 分隔符必须编码
    expect(withTextFragment('https://a.com/p', 'foo, bar & baz qux')).toContain('%2C')
    expect(withTextFragment('https://a.com/p', 'foo, bar & baz qux')).toContain('%26')
  })

  it('withTextFragment 该不挂就不挂(挂错比不挂更坏)', () => {
    // 模型自己写了片段指令 → 听它的,别叠第二条
    const own = 'https://a.com/p#:~:text=already%20here'
    expect(withTextFragment(own, '别的句子')).toBe(own)
    // 太短的链接文字(「点这里」)当搜索词多半命中无关处
    expect(withTextFragment('https://a.com/p', '点这里')).toBe('https://a.com/p')
    // 自动链接:文字就是 URL 本身,搜它没有意义
    expect(withTextFragment('https://a.com/page', 'https://a.com/page')).toBe('https://a.com/page')
    // 非 http(s) 一律不碰
    expect(withTextFragment('mailto:a@b.com', 'the aim of this book')).toBe('mailto:a@b.com')
  })

  it('webCiteKey 剥掉 fragment —— 同一页的不同引语必须复用同一个 webview', () => {
    expect(webCiteKey('https://a.com/p#:~:text=x')).toBe('https://a.com/p')
    expect(webCiteKey('https://a.com/p')).toBe('https://a.com/p')
  })
})

describe('块锚点 #^abc(Obsidian 互操作)', () => {
  it('parseBlockSubpath:`#` 前缀可有可无,字符集照 Obsidian', () => {
    expect(parseBlockSubpath('^abc123')).toBe('abc123')
    expect(parseBlockSubpath('#^abc123')).toBe('abc123')
    expect(parseBlockSubpath('#^a-b-2')).toBe('a-b-2')
    expect(parseBlockSubpath('  ^x1  ')).toBe('x1')
  })

  it('畸形形态一律 null —— 宁可只开笔记,也不去撞一个同名标题', () => {
    expect(parseBlockSubpath('^')).toBeNull()          // 光杆插入符
    expect(parseBlockSubpath('^a b')).toBeNull()       // 带空格(Obsidian 也不认)
    expect(parseBlockSubpath('^中文')).toBeNull()       // 字符集之外
    expect(parseBlockSubpath('^a_b')).toBeNull()       // 下划线不在 Obsidian 的块 id 字符集里
    expect(parseBlockSubpath('abc')).toBeNull()        // 没有插入符 = 标题锚
  })

  it('与其余四族锚点互斥(双向)', () => {
    expect(parseBlockSubpath('page=3')).toBeNull()
    expect(parseBlockSubpath('L42')).toBeNull()
    expect(parseBlockSubpath('t=95')).toBeNull()
    expect(parseBlockSubpath('某标题')).toBeNull()
    expect(parseLineSubpath('^abc')).toBeNull()
    expect(parsePdfSubpath('^abc')).toBeNull()
    expect(parseMediaSubpath('^abc')).toBeNull()
  })

  it('trailingBlockId:块最后一行尾部的那个才算', () => {
    expect(trailingBlockId('这是一段话 ^abc123')).toBe('abc123')
    expect(trailingBlockId('这是一段话 ^abc123   ')).toBe('abc123')
    expect(trailingBlockId('^abc123')).toBe('abc123')          // 光杆行也算(语义指上一块)
    expect(trailingBlockId('见 ^abc 之后还有字')).toBeNull()     // 不在行尾
    expect(trailingBlockId('价格 ^ 100')).toBeNull()
    expect(trailingBlockId('数学式 x^2')).toBeNull()            // 前面不是空白 → 不是块锚
    expect(trailingBlockId('普通一行')).toBeNull()
  })

  it('isLoneBlockId:整行只有锚 → 它标注的是上一个块', () => {
    expect(isLoneBlockId('^abc123')).toBe(true)
    expect(isLoneBlockId('   ^abc123  ')).toBe(true)
    expect(isLoneBlockId('这是一段话 ^abc123')).toBe(false)
    expect(isLoneBlockId('^')).toBe(false)
  })
})
