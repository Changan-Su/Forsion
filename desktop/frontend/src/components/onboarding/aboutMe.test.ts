/** 引导「关于你」写进 human/MEMORY.md 的那一节(aboutMe.ts):空模板当空、整节一种语言、读回原地改、认不得的一字不动。 */
import { describe, expect, it } from 'vitest'
import '../../i18n.generated'
import { USER_MD_TEMPLATE, LEGACY_USER_MD_TEMPLATES } from '../../../../../tangu-agent/src/contracts/userMdTemplate'
import { EMPTY_ABOUT_ME, parseAboutMe, sectionLangOf, serializeAboutMe, type AboutMe } from './aboutMe'

const form = (patch: Partial<AboutMe>): AboutMe => ({ ...EMPTY_ABOUT_ME, works: [], ...patch })

describe('空模板当空', () => {
  it('引擎播种的模板(现版 / 旧版 / CRLF / 首尾空白)读成全空,序列化为空串', () => {
    for (const tpl of [USER_MD_TEMPLATE, ...LEGACY_USER_MD_TEMPLATES, USER_MD_TEMPLATE.replace(/\n/g, '\r\n'), `\n${USER_MD_TEMPLATE}  \n`]) {
      const p = parseAboutMe(tpl)
      expect(p.form).toEqual(EMPTY_ABOUT_ME)
      expect(p.sectionLang).toBeNull()
      expect(serializeAboutMe(p.form, 'zh')).toBe('')
    }
  })
  it('模板上补了一行就不是模板:整份进自由框', () => {
    const p = parseAboutMe(`${USER_MD_TEMPLATE}Lu\n`)
    expect(p.form.more).toBe(`${USER_MD_TEMPLATE}Lu`)
  })
})

describe('整节一种语言', () => {
  it('名字 / 自己写里有汉字 → 中文标签,胶囊也写中文', () => {
    const f = form({ name: '小鹿', works: ['code'], workText: '独立开发一个记账 App', style: 'short' })
    expect(sectionLangOf(f, 'en')).toBe('zh')
    expect(serializeAboutMe(f, 'zh')).toBe('## 关于我\n- 称呼：小鹿\n- 在做：写代码；独立开发一个记账 App\n- 回答：简短直接\n')
  })
  it('有字但没汉字 → 英文标签', () => {
    const f = form({ name: 'Lu', works: ['code', 'lead'], workText: 'building a budgeting app on my own', style: 'short' })
    expect(sectionLangOf(f, 'zh')).toBe('en')
    expect(serializeAboutMe(f, 'en')).toBe('## About me\n- Call me: Lu\n- Working on: coding, leading a team; building a budgeting app on my own\n- Answers: short and direct\n')
  })
  it('只点了胶囊 → 按 fallback(原来那一节 / 界面语言)', () => {
    const f = form({ works: ['design'], style: 'why' })
    expect(sectionLangOf(f, 'zh')).toBe('zh')
    expect(sectionLangOf(f, 'en')).toBe('en')
  })
  it('回答语言那一行跟着这一节的语言写;「跟着我说的话」不写', () => {
    expect(serializeAboutMe(form({ name: '小鹿', lang: 'en' }), 'zh')).toBe('## 关于我\n- 称呼：小鹿\n- 回答用英文\n')
    expect(serializeAboutMe(form({ name: 'Lu', lang: 'zh' }), 'en')).toBe('## About me\n- Call me: Lu\n- Answer in Chinese\n')
    expect(serializeAboutMe(form({ name: 'Lu', lang: 'auto' }), 'en')).toBe('## About me\n- Call me: Lu\n')
  })
})

describe('读回', () => {
  it('两种语言写出来的都能原样读回(round trip)', () => {
    const zh = form({ name: '小鹿', works: ['code', 'writing'], workText: '记账 App', style: 'conclusion', lang: 'zh', more: '晚上 10 点以后别提醒我工作的事。' })
    const en = form({ name: 'Lu', works: ['study'], workText: '', style: 'why', lang: 'en', more: '# Notes\n\n- uses Swift' })
    expect(parseAboutMe(serializeAboutMe(zh, 'zh'))).toEqual({ form: zh, sectionLang: 'zh' })
    expect(parseAboutMe(serializeAboutMe(en, 'en'))).toEqual({ form: en, sectionLang: 'en' })
  })
  it('旧快捷句插的标签也认;值对不上选项的那行留在自由框', () => {
    const p = parseAboutMe('Call me: 小鹿\nWorking on: 独立开发一个记账 App\nHow I like answers: 简短一点，先给结论\n')
    expect(p.form).toMatchObject({ name: '小鹿', works: [], workText: '独立开发一个记账 App', style: '' })
    expect(p.form.more).toBe('How I like answers: 简短一点，先给结论')
    // 存回时按答案的字定语言:整节换成中文,不再是「Call me: 小鹿」
    expect(serializeAboutMe(p.form, sectionLangOf(p.form, p.sectionLang ?? 'en'))).toBe('## 关于我\n- 称呼：小鹿\n- 在做：独立开发一个记账 App\n\nHow I like answers: 简短一点，先给结论\n')
    expect(parseAboutMe('怎么称呼我：小鹿\n回答方式：讲清来龙去脉').form).toMatchObject({ name: '小鹿', style: 'why' })
  })
  it('认不得的行按原顺序进自由框;每种标签只认第一次', () => {
    const p = parseAboutMe('住在杭州\n- 称呼：小鹿\n养了一只猫\n- 称呼：鹿鹿\n# 笔记\n- 回答：简短直接\n')
    expect(p.form).toMatchObject({ name: '小鹿', style: '' })
    expect(p.form.more).toBe('住在杭州\n养了一只猫\n- 称呼：鹿鹿\n# 笔记\n- 回答：简短直接')
  })
  it('只认开头那一块:别的标题底下、代码块里的同名标签不碰', () => {
    const doc = '# 笔记\n- Call me: Lu\n\n## About me\n- Answers: short and direct\n'
    expect(parseAboutMe(doc).form).toMatchObject({ name: '', style: '', more: doc.trimEnd() })
    const fenced = '例子：\n```\n- Answers: short and direct\n```\n- 称呼：小鹿'
    const p = parseAboutMe(fenced)
    expect(p.form).toMatchObject({ name: '小鹿', style: '' })
    expect(p.form.more).toBe('例子：\n```\n- Answers: short and direct\n```')
  })
  it('那一节的标题底下只有自己写的话:标题原样留着,不当这一屏的', () => {
    const p = parseAboutMe('## About me\nI design apps in Berlin.\n')
    expect(p.form).toMatchObject({ name: '', more: '## About me\nI design apps in Berlin.' })
    expect(p.sectionLang).toBeNull()
    expect(serializeAboutMe({ ...p.form, more: `${p.form.more}\nI like tea.` }, 'en')).toBe('## About me\nI design apps in Berlin.\nI like tea.\n')
  })
  it('「在做」:开头连着的胶囊认成胶囊(两种语言、不分大小写),其余是自己写的', () => {
    expect(parseAboutMe('- 在做：写代码、设计；独立开发').form).toMatchObject({ works: ['code', 'design'], workText: '独立开发' })
    expect(parseAboutMe('- Working on: Coding, research').form).toMatchObject({ works: ['code', 'research'], workText: '' })
    expect(parseAboutMe('- Working on: writing a book').form).toMatchObject({ works: [], workText: 'writing a book' })
    expect(parseAboutMe('- 在做：学习日语').form).toMatchObject({ works: [], workText: '学习日语' })
  })
  it('放不进表单的值不认(名字超 40、自己写超 60),整行留在自由框', () => {
    const long = 'x'.repeat(41)
    expect(parseAboutMe(`- Call me: ${long}`).form).toMatchObject({ name: '', more: `- Call me: ${long}` })
    const own = 'y'.repeat(61)
    expect(parseAboutMe(`- Working on: ${own}`).form).toMatchObject({ workText: '', more: `- Working on: ${own}` })
  })
  it('全清空:那一节删掉,其余一字不动', () => {
    const p = parseAboutMe('## 关于我\n- 称呼：小鹿\n- 回答用中文\n\n# 笔记\n  缩进的一行\n')
    expect(p.form).toMatchObject({ name: '小鹿', lang: 'zh', more: '# 笔记\n  缩进的一行' })
    expect(serializeAboutMe({ ...p.form, name: '', lang: 'auto' }, 'zh')).toBe('# 笔记\n  缩进的一行\n')
  })
})
