/** P1 forsion:// 解析单测:中文路径编解码往返是验收项(本仓路径几乎全中文),不是可选项。 */
import { describe, expect, it } from 'vitest'
import { parseDeepLink, isSafeVaultPath } from './deepLinkPlan'

describe('parseDeepLink 实体短径', () => {
  it('note:中文路径 percent-encoded 往返', () => {
    const p = '项目/会议纪要 2026-08.md'
    const url = `forsion://note/${encodeURIComponent(p)}`
    expect(parseDeepLink(url)).toEqual({ kind: 'note', ref: p, params: {} })
  })

  it('note:未编码的裸中文 URL 也收(程序构造的链接常不编码)', () => {
    const got = parseDeepLink('forsion://note/笔记/灵感.md')
    expect(got?.kind).toBe('note')
    expect(got?.ref).toBe('笔记/灵感.md')
  })

  it('note:NFD(mac 文件系统形态)归一成 NFC', () => {
    const nfd = 'ノート/メモ.md'.normalize('NFD')
    const got = parseDeepLink(`forsion://note/${encodeURIComponent(nfd)}`)
    expect(got?.ref).toBe('ノート/メモ.md'.normalize('NFC'))
  })

  it('note:路径穿越与绝对路径一律拒', () => {
    // 防线分两层:①WHATWG URL 解析对斜杠形态的 dot-segment(字面 ../ 和 %2e%2e/)一律归一化消解,
    // 落地已是 vault 内相对路径,穿越在 URL 层就不成立;②反斜杠形态(..%5C)URL 不当分隔符、不归一,
    // decode 后才现形——这才是 isSafeVaultPath 段校验真正要抓的。
    expect(parseDeepLink('forsion://note/../../etc/passwd')?.ref).toBe('etc/passwd')
    expect(parseDeepLink('forsion://note/a/%2e%2e/b.md')?.ref).toBe('b.md')
    expect(parseDeepLink('forsion://note/..%5Csecret.md')).toBe(null)
    expect(parseDeepLink('forsion://note/a%5C..%5Cb.md')).toBe(null)
    expect(parseDeepLink(`forsion://note/${encodeURIComponent('C:\\win\\sys.md')}`)).toBe(null)
    expect(parseDeepLink('forsion://note/')).toBe(null)
    expect(isSafeVaultPath('a//b.md')).toBe(false)
    expect(isSafeVaultPath('a/../b.md')).toBe(false)
  })

  it('session/space/agent:id 白形态;非法字符拒', () => {
    expect(parseDeepLink('forsion://session/abc-123_X')).toEqual({ kind: 'session', ref: 'abc-123_X', params: {} })
    expect(parseDeepLink('forsion://space/amadeus')?.kind).toBe('space')
    expect(parseDeepLink('forsion://agent/tangu')?.kind).toBe('agent')
    expect(parseDeepLink('forsion://session/a b')).toBe(null)
    expect(parseDeepLink('forsion://agent/<script>')).toBe(null)
  })
})

describe('parseDeepLink 通用径 open', () => {
  it('用户原例:open?space=xxx&view=xxx(space 先切再开)', () => {
    const got = parseDeepLink('forsion://open?space=amadeus&view=calendar')
    expect(got).toEqual({ kind: 'view', view: 'calendar', space: 'amadeus', params: {} })
  })

  it('params 透传但 __ 前缀内部键丢弃(__type/__loc 不许注入)', () => {
    const got = parseDeepLink('forsion://open?view=amadeus-pdf&pdfPath=%E8%AE%BA%E6%96%87.pdf&__loc=left&page=3')
    expect(got?.params).toEqual({ pdfPath: '论文.pdf', page: '3' })
  })

  it('params 不做二次解码:文件名里字面的 % 序列原样保留(searchParams 已 decode 过一次)', () => {
    // 文件真叫「文档%E4%B8%AD.pdf」→ URL 里编码为 %25E4…;searchParams 解一次得回字面串,不许再解。
    const got = parseDeepLink('forsion://open?view=amadeus-pdf&pdfPath=%E6%96%87%E6%A1%A3%25E4%25B8%25AD.pdf')
    expect(got?.params.pdfPath).toBe('文档%E4%B8%AD.pdf')
  })

  it('插件 view 命名空间形态放行(白名单在 resolver 按注册表判)', () => {
    expect(parseDeepLink('forsion://open?view=plugin:bluebird:favorites')?.view).toBe('plugin:bluebird:favorites')
  })

  it('无 view / 非法 view / 未知实体段:拒', () => {
    expect(parseDeepLink('forsion://open?space=amadeus')).toBe(null)
    expect(parseDeepLink('forsion://open?view=a%20b')).toBe(null)
    expect(parseDeepLink('forsion://task/abc123')).toBe(null) // 已拍板删除的短径:不进语法
    expect(parseDeepLink('https://note/x.md')).toBe(null)
    expect(parseDeepLink('not a url')).toBe(null)
  })
})
