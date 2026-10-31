/** 知识网络索引(评审 2026-09-27 L-14 / L-16 / L-13 / C-19),全部跑**真 VaultIndex** + 临时库:
 *  - L-14:代码(围栏 / 行内)里的 `#include` 不算标签;fm `tags:` 并入标签;查 `#work` 命中 `#work/urgent`。
 *  - L-16:代码里的 `[[x]]` 不算反链;反链逐处列出、摘录去掉 md 语法;未链接提及(标题 + 别名,词边界,排除代码 / 已有链接)。
 *  - C-19:fm 属性值里的 `[[x]]` 计入反链(line 0)。L-13:fm `aliases:` 进 pageAliases。 */
import { promises as fs, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findMarkLine } from '../../../shared/amadeus/mdMarks'
import { linkMentionInText } from '../../../shared/amadeus/linkIndex'
import { VaultIndex } from './vaultIndex'
import type { VaultManager } from './vaultManager'

let dir = ''
afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true })
})

async function setup(files: Record<string, string>): Promise<VaultIndex> {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-index-links-'))
  for (const [p, text] of Object.entries(files)) await fs.writeFile(path.join(dir, p), text)
  const vault = {
    listPages: async () => readdirSync(dir).filter((f) => f.endsWith('.md')).sort(),
    absPath: (p: string) => path.join(dir, p),
    getRoot: () => dir,
  } as unknown as VaultManager
  const index = new VaultIndex(vault)
  await index.build()
  return index
}

const VAULT: Record<string, string> = {
  'Alpha.md': '---\ntags: [fmtag, other]\naliases: [AliasA, 甲]\nrelated: "[[Beta]]"\n---\n# Alpha\n\n段落 #项目 与 #work/urgent\n\n```c\n#include <stdio.h>\n```\n\n行内 `#nope` 代码\n',
  'StrTags.md': '---\ntags: "#one, two three"\n---\nbody\n',
  'Parent.md': 'x #work child tag note\n',
  'Shop.md': 'x #workshop\n',
  'Beta.md': '# Beta\n',
  'Target.md': '# Target\n',
  'Src.md': 'first [[Target]] line with **bold**\n\nsecond [[Target|别名]] line\n\nthird [[Target#H]]\n\nfourth [[Target]] and [[Target]] again\n',
  'CodeRef.md': 'only in code:\n\n```\nsee [[Target]]\n```\n\ninline `[[Target]]` too\n',
  'Plain.md': '# Plain\n\nI mention target here.\n\nTargets is another word.\n\n```\nTarget in code\n```\n\nAlready [[Target]] linked.\n\nsee https://x.com/Target\n\n再说一次 Target。\n',
}

describe('L-14 标签索引', () => {
  it('代码里的 #include / 行内代码 #nope 不算标签;fm tags(列表与字符串两种写法)并入', async () => {
    const ix = await setup(VAULT)
    const tags = ix.listTags().map((t) => t.tag)
    expect(tags).not.toContain('include')
    expect(tags).not.toContain('nope')
    expect(tags).toEqual(expect.arrayContaining(['项目', 'work/urgent', 'fmtag', 'other', 'one', 'two', 'three']))
    expect(ix.pagesByTag('fmtag')).toEqual(['Alpha.md'])
    expect(ix.pagesByTag('#two')).toEqual(['StrTags.md'])
  })
  it('嵌套标签前缀查询:work 命中 work/urgent,不命中 workshop', async () => {
    const ix = await setup(VAULT)
    expect(ix.pagesByTag('work')).toEqual(['Alpha.md', 'Parent.md'])
    expect(ix.pagesByTag('work/urgent')).toEqual(['Alpha.md'])
  })
})

describe('L-16 反链', () => {
  it('代码(围栏 / 行内)里的 [[Target]] 不算反链', async () => {
    const ix = await setup(VAULT)
    expect(ix.backlinks('Target.md').map((r) => r.path)).toEqual(['Plain.md', 'Src.md'])
  })
  it('逐处列出(每行一条),摘录去掉 md 语法', async () => {
    const ix = await setup(VAULT)
    const src = ix.backlinks('Target.md').find((r) => r.path === 'Src.md')!
    expect(src.hits).toEqual([
      { line: 1, text: 'first Target line with bold' },
      { line: 3, text: 'second 别名 line' },
      { line: 5, text: 'third Target › H' },
      { line: 7, text: 'fourth Target and Target again' },
    ])
    expect(src.snippet).toBe('first Target line with bold')
  })
  it('fm 属性值里的 [[Beta]] 计入反链,命中行标 0(C-19)', async () => {
    const ix = await setup(VAULT)
    const refs = ix.backlinks('Beta.md')
    expect(refs.map((r) => r.path)).toEqual(['Alpha.md'])
    expect(refs[0].hits).toEqual([{ line: 0, text: 'related: Beta' }])
  })
  it('未链接提及:大小写不敏感 + 词边界,排除代码 / 已有链接 / URL;给出可回写的 raw+occ+col', async () => {
    const ix = await setup(VAULT)
    const um = ix.unlinkedMentions('Target.md')
    expect(um.map((m) => m.path)).toEqual(['Plain.md'])
    const hits = um[0].hits
    expect(hits.map((h) => h.text)).toEqual(['I mention target here.', '再说一次 Target。'])
    const h = hits[0]
    expect(h).toMatchObject({ raw: 'I mention target here.', occ: 0, col: 10, match: 'target' })
    // raw+occ 在磁盘原文里定位得回来(与 linkMention 同一把尺子)
    expect(findMarkLine(VAULT['Plain.md'], h.raw!, h.occ!)).toBe(2)
  })
  it('一键链接按内容定位改写(linkMention 的纯函数):只改那一处;文件已变 → null 不写', async () => {
    const ix = await setup(VAULT)
    const h = ix.unlinkedMentions('Target.md')[0].hits[0] as { raw: string; occ: number; col: number; match: string }
    const next = linkMentionInText(VAULT['Plain.md'], h, 'Target|target')
    expect(next!.split('\n')[2]).toBe('I mention [[Target|target]] here.')
    expect(next!.replace('[[Target|target]]', 'target')).toBe(VAULT['Plain.md'])
    expect(linkMentionInText(VAULT['Plain.md'].replace('I mention target', 'I mention nothing'), h, 'Target')).toBeNull()
    expect(linkMentionInText(VAULT['Plain.md'], h, 'Bad]]name')).toBeNull()
  })
  it('CRLF 笔记:提及的 raw 不带行尾 \\r,一键链接找得到行,落盘仍是 CRLF(Codex 复核 P1)', async () => {
    const CRLF = '# Plain\r\n\r\nI mention target here.\r\n\r\ntail\r\n'
    const ix = await setup({ 'Target.md': '# Target\n', 'Crlf.md': CRLF })
    const h = ix.unlinkedMentions('Target.md')[0].hits[0] as { raw: string; occ: number; col: number; match: string }
    expect(h.raw).toBe('I mention target here.')
    const next = linkMentionInText(CRLF, h, 'Target|target')
    expect(next).toBe(CRLF.replace('I mention target here.', 'I mention [[Target|target]] here.'))
  })
  it('混合换行笔记:只替换命中片段,其余字节(含每一处换行符)原样(Codex 复核 P1)', async () => {
    const MIXED = 'a\r\nb\n\nI mention target here.\n\nc\r\nd\n'
    const ix = await setup({ 'Target.md': '# Target\n', 'Mixed.md': MIXED })
    const h = ix.unlinkedMentions('Target.md')[0].hits[0] as { raw: string; occ: number; col: number; match: string }
    const next = linkMentionInText(MIXED, h, 'Target|target')
    expect(next).toBe(MIXED.replace('I mention target here.', 'I mention [[Target|target]] here.'))
    // 命中在 CRLF 行上、文件里也有 LF 行:同样只动那一段
    const MIXED2 = 'x\n\nI mention target here.\r\ny\n'
    const h2 = { raw: 'I mention target here.', occ: 0, col: 10, match: 'target' }
    expect(linkMentionInText(MIXED2, h2, 'Target|target')).toBe(MIXED2.replace('target here', '[[Target|target]] here'))
  })
  it('未链接提及也认 fm 别名', async () => {
    const ix = await setup({ ...VAULT, 'Mention.md': '提到甲和 aliasa 了\n' })
    const um = ix.unlinkedMentions('Alpha.md')
    expect(um.find((m) => m.path === 'Mention.md')?.hits[0]).toMatchObject({ match: '甲' })
  })
})

describe('L-13 别名', () => {
  it('pageAliases 只列设置了别名的笔记', async () => {
    const ix = await setup(VAULT)
    expect(ix.pageAliases()).toEqual({ 'Alpha.md': ['AliasA', '甲'] })
  })
})

describe('T2 tag: 行级搜索与标签计数(真 VaultIndex)', () => {
  const TAG_VAULT: Record<string, string> = {
    'Plan.md': '---\ntags: [产品/路线图]\n---\n这一季先做 #产品/路线图 里的三件事\n\n```\n#产品/路线图 代码里的不算\n```\n',
    '2026-10.md': '# 2026-10\n\n### 2026-10-29T22:05:00\n\nMini 窗只放输入框 #产品/路线图\n\n### 2026-10-24T07:45:00\n\n回顾卡可以像抽牌 #产品/路线图 #设计\n\n### 2026-10-20T08:00:00\n\n别的事 #产品/用户\n',
    'Design.md': 'only #设计\n',
    'Plain.md': '普通笔记 提到 tag:#产品 这几个字\n',
  }
  it('带 tag 条件按前缀过滤、含 fm,逐行列出;代码块里的不算', async () => {
    const ix = await setup(TAG_VAULT)
    const hits = ix.search('tag:#产品/路线图')
    expect(hits.map((h) => h.path)).toEqual(['2026-10.md', 'Plan.md'])
    expect(hits[0].hits).toEqual([
      { line: 5, text: 'Mini 窗只放输入框 #产品/路线图' },
      { line: 9, text: '回顾卡可以像抽牌 #产品/路线图 #设计' },
    ])
    expect(hits[1].hits).toEqual([{ line: 0, text: 'tags: #产品/路线图' }, { line: 1, text: '这一季先做 #产品/路线图 里的三件事' }])
    expect(ix.search('tag:产品').find((h) => h.path === '2026-10.md')?.hits).toHaveLength(3)
  })
  it('多标签取交集,-tag: 排除,再套普通关键词;大小写不敏感', async () => {
    const ix = await setup({ ...TAG_VAULT, 'Up.md': 'x #Work/A\n' })
    expect(ix.search('tag:产品 tag:设计').map((h) => h.path)).toEqual(['2026-10.md'])
    expect(ix.search('tag:产品 tag:设计')[0].hits).toEqual([{ line: 9, text: '回顾卡可以像抽牌 #产品/路线图 #设计' }])
    expect(ix.search('tag:设计 -tag:产品').map((h) => h.path)).toEqual(['Design.md'])
    expect(ix.search('tag:产品 三件事').map((h) => h.path)).toEqual(['Plan.md'])
    expect(ix.search('TAG:#work').map((h) => h.path)).toEqual(['Up.md'])
    const without = ix.search('-tag:产品').map((h) => h.path).sort()
    expect(without).toEqual(['Design.md', 'Plain.md', 'Up.md'])
  })
  it('不带 tag 的查询不多带 hits,也不把 `tag:` 当操作符以外的东西吞掉', async () => {
    const ix = await setup(TAG_VAULT)
    const plain = ix.search('普通笔记')
    expect(plain.map((h) => h.path)).toEqual(['Plain.md'])
    expect(plain[0]).not.toHaveProperty('hits')
    expect(plain[0]).toEqual({ path: 'Plain.md', title: 'Plain', snippet: '普通笔记 提到 tag:#产品 这几个字', line: 1, score: expect.any(Number) })
  })
  it('listTags:count 不变,total 按文件去重,只作父级的前缀 count 0', async () => {
    const ix = await setup(TAG_VAULT)
    const rows = ix.listTags()
    expect(rows.find((r) => r.tag === '产品/路线图')).toEqual({ tag: '产品/路线图', count: 2, total: 2 })
    expect(rows.find((r) => r.tag === '产品')).toEqual({ tag: '产品', count: 0, total: 2 })
    expect(rows[rows.length - 1].count).toBe(0)
  })
})
