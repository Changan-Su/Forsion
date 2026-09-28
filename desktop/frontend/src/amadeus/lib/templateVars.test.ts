// 模板变量 / 日记命名(评审 G4-10)。IO 接线(读 .obsidian/*.json、建日记、插模板)在 amadeusTemplates.ts。
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { dailyNotePath, dailyTemplatePath, formatMoment, parseObsidianCfg, substituteTemplateVars } from './templateVars'

const NOW = new Date(2026, 8, 28, 14, 5, 9) // 2026-09-28 周一 14:05:09

describe('substituteTemplateVars', () => {
  it('三种老写法照旧', () => {
    expect(substituteTemplateVars('{{date}} {{time}} {{title}}', { title: '笔记', now: NOW })).toBe('2026-09-28 14:05 笔记')
  })
  it('带格式 / 大小写 / 空白 —— 修前全部原样残留', () => {
    const out = substituteTemplateVars('{{date:YYYY-MM-DD dddd}} | {{time:HH:mm:ss}} | {{Title}} | {{ date }} | {{DATE: YYYY年M月D日 }}', { title: 'T', now: NOW, locale: 'zh' })
    expect(out).toBe('2026-09-28 星期一 | 14:05:09 | T | 2026-09-28 | 2026年9月28日')
    expect(out).not.toMatch(/\{\{/)
  })
  it('缺省格式可由 Obsidian templates.json 给', () => {
    expect(substituteTemplateVars('{{date}} {{time}}', { title: '', now: NOW, dateFormat: 'DD/MM/YYYY', timeFormat: 'h:mm A' })).toBe('28/09/2026 2:05 PM')
  })
  it('不认识的变量原样保留', () => {
    expect(substituteTemplateVars('{{foo}} {{date+1d}}', { title: '', now: NOW })).toBe('{{foo}} {{date+1d}}')
  })
})

describe('formatMoment', () => {
  it('常用子集 + [字面量]', () => {
    expect(formatMoment(NOW, 'YYYY-[W]WW-d Q DDD Do MMM', 'en')).toBe('2026-W40-1 3 271 28th Sep')
    expect(formatMoment(NOW, 'MMMM ddd dd', 'zh')).toBe('九月 周一 一')
  })
})

describe('日记命名', () => {
  it('缺省 = 根目录 YYYY-MM-DD.md', () => {
    expect(dailyNotePath(NOW, '', {})).toBe('2026-09-28.md')
  })
  it('daily-notes.json 的 format / folder 生效,format 可分层;设置里的文件夹优先', () => {
    const cfg = parseObsidianCfg<{ format: string; folder: string }>('{"format":"YYYY/MM/YYYY-MM-DD ddd","folder":"Journal/"}')
    expect(dailyNotePath(NOW, '', cfg)).toBe('Journal/2026/09/2026-09-28 Mon.md')
    expect(dailyNotePath(NOW, 'Daily', cfg)).toBe('Daily/2026/09/2026-09-28 Mon.md')
  })
  it('模板:daily-notes.json 的 template 优先,否则 templates/daily.md', () => {
    const pages = ['Templates/Daily.md', 'tpl/日记模板.md']
    expect(dailyTemplatePath(pages, { template: 'tpl/日记模板' })).toBe('tpl/日记模板.md')
    expect(dailyTemplatePath(pages, {})).toBe('Templates/Daily.md')
    expect(dailyTemplatePath(['a.md'], { template: 'missing' })).toBeNull()
  })
  it('坏 json → 空配置', () => {
    expect(parseObsidianCfg('{oops')).toEqual({})
    expect(parseObsidianCfg(null)).toEqual({})
  })
})

describe('接线', () => {
  it('amadeusTemplates 的插模板 / 建日记走这里(别退回精确 replaceAll 与写死的 YYYY-MM-DD / templates/daily.md)', () => {
    const src = readFileSync(join(__dirname, '../../amadeusTemplates.ts'), 'utf8')
    expect(src).toMatch(/substituteTemplateVars\(/)
    expect(src).toMatch(/dailyNotePath\(/)
    expect(src).toMatch(/dailyTemplatePath\(/)
    expect(src).not.toMatch(/replaceAll\('\{\{date\}\}'/)
  })
})
