/// <reference path="./pinyinlite.d.ts" />
import { describe, expect, it } from 'vitest'
import readings from 'pinyinlite/index_full.js'
import { rankNames } from './nameSearch'
import { pickWikiResults } from '../blocks/markdown/wikiRank'

const items = ['工作/项目周报', '工作/本周周报', 'XMZB', '項目週報', '重庆调研', '銀行記錄', '论文Q1进度']
const titles = (q: string) => rankNames(items, q, (p) => p.split('/').at(-1)!, (p) => p, readings)

describe('Chinese name search in Quick Find and wiki suggestions', () => {
  it('ranks a literal English title above phonetic matches and keeps original names', () => {
    expect(titles('xmzb')).toEqual(['XMZB', '工作/项目周报', '項目週報'])
    expect(titles('xiangmuzhoubao')).toEqual(['工作/项目周报', '項目週報'])
    expect(titles('项mu周b')).toEqual(['工作/项目周报'])
  })
  it('accepts initials, unfinished syllables, common polyphonic readings and mixed Latin names', () => {
    expect(titles('cqdy')).toEqual(['重庆调研'])
    expect(titles('chongqingdiao')).toEqual(['重庆调研'])
    expect(titles('yinhangjilu')).toEqual(['銀行記錄'])
    expect(titles('lwq1jd')).toEqual(['论文Q1进度'])
    expect(titles('qzxc')).toEqual([])
  })
  it('matches ordered tokens across folders, retains literal matching without a dictionary', () => {
    expect(titles('gz zb')).toContain('工作/本周周报')
    expect(rankNames(items, '周报', (s) => s, () => undefined)).toContain('工作/项目周报')
    expect(titles('')).toEqual(items)
  })
  it('returns the original wiki alias or file object for canonical link insertion', () => {
    const alias = { base: '实验记录', alias: '实验记录', path: '实验/Alpha.md', file: false }
    const file = { base: '项目附件.pdf', path: '附件/项目附件.pdf', file: true }
    expect(pickWikiResults([alias, file], 'syjl', 8, readings)).toEqual([alias])
    expect(pickWikiResults([alias, file], 'xmfj', 8, readings)).toEqual([file])
  })
  it('matches a note by its frontmatter aliases once, while preserving its title and path', () => {
    const note = { title: 'Alpha', path: '研究/Alpha.md', aliases: ['周报汇总', '周报汇总表'] }
    const exact = { title: 'ZBHZ', path: 'ZBHZ.md', aliases: [] }
    expect(rankNames([note, exact], 'zbhz', (n) => n.title, (n) => n.path, readings, (n) => n.aliases)).toEqual([exact, note])
  })
})
