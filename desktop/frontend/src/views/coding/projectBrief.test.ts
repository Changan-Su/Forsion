import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildStudioDraft, buildStudioPrompt, projectBasename, STUDIO_TEMPLATES, validateProjectName, type StudioBrief } from './projectBrief'

describe('project names', () => {
  it.each(['../outside', 'a/b', 'a\\b', '.hidden', 'project.', 'a:b', 'a\u0000b', 'a*'])('rejects unsafe folder name %j', (name) => {
    expect(validateProjectName(name)).toBe('invalid')
  })
  it.each(['CON', 'con.txt', 'LPT9', 'aux', 'COM1.project'])('rejects Windows reserved name %j', (name) => {
    expect(validateProjectName(name)).toBe('reserved')
  })
  it('checks empty, long, case-insensitive, and Unicode-normalized collisions', () => {
    expect(validateProjectName('  ')).toBe('empty')
    expect(validateProjectName('x'.repeat(101))).toBe('long')
    expect(validateProjectName(' My App ', ['my app'])).toBe('duplicate')
    expect(validateProjectName('café', ['cafe\u0301'])).toBe('duplicate')
    expect(validateProjectName('我的项目 2')).toBeNull()
    expect(validateProjectName('dashboard-v2.1')).toBeNull()
  })
  it('extracts imported folder names from Windows and Unix paths', () => {
    expect(projectBasename('C:\\Users\\Jane\\My project\\')).toBe('My project')
    expect(projectBasename('/home/jane/My project/')).toBe('My project')
  })
})

describe('readable project drafts', () => {
  const brief: StudioBrief = { idea: '保留原目标：我的 café\n支持离线', audience: '新同学', constraints: '数据只放本地', capabilities: ['images', 'chat', 'chat', 'account'], locale: 'zh' }
  it('uses concise Chinese with the original input and friendly selected capability names', () => {
    const draft = buildStudioDraft(brief)
    expect(draft).toContain('请先阅读已保存的 FORSION_BRIEF.md')
    expect(draft).toContain(`目标：${brief.idea}`)
    expect(draft).toContain(`受众：${brief.audience}`)
    expect(draft).toContain(`要求：${brief.constraints}`)
    expect(draft).toContain('AI 对话、图像生成、Forsion 账号')
    expect(draft.match(/AI 对话/g)).toHaveLength(1)
    expect(draft).not.toContain('Agent 工作流')
    expect(draft).toContain('先列出简短步骤')
    expect(draft).toContain('计划模式下先给出方案')
    expect(draft).not.toContain('window.forsion')
    expect(draft).not.toContain('Working agreement')
    expect(draft.length).toBeLessThan(buildStudioPrompt(brief).length / 2)
  })
  it('uses English throughout its own copy and respects the current plan/build mode', () => {
    const english: StudioBrief = { ...brief, idea: 'An offline reading app', audience: 'New students', constraints: 'Keep data local', capabilities: ['agent'], locale: 'en' }
    const draft = buildStudioDraft(english)
    expect(draft).toContain('Read the saved FORSION_BRIEF.md')
    expect(draft).toContain(`Goal: ${english.idea}`)
    expect(draft).toContain(`Audience: ${english.audience}`)
    expect(draft).toContain(`Requirements: ${english.constraints}`)
    expect(draft).toContain('Requested capabilities: Agent workflows')
    expect(draft).toContain('in plan mode, propose a plan')
    expect(draft).toContain('in build mode, implement in small steps')
    expect(draft).not.toMatch(/[一-龥]/)
    expect(draft).not.toContain('window.forsion')
  })
  it('omits empty optional sections and keeps full SDK instructions in the portable brief only', () => {
    const draft = buildStudioDraft({ ...brief, audience: '  ', constraints: '', capabilities: [] })
    expect(draft).not.toContain('受众：')
    expect(draft).not.toContain('要求：')
    expect(draft).not.toContain('需要的能力：')
    const portable = buildStudioPrompt(brief)
    expect(portable).toContain('Working agreement:')
    expect(portable).toContain('window.forsion.ai.chat')
    expect(portable).toContain('window.forsion.ai.generateImage')
  })
})

describe('project prompt', () => {
  const brief: StudioBrief = { idea: 'Keep my original idea: café / 读书', audience: 'New students', constraints: 'Keep data local', capabilities: [], locale: 'en' }
  it('preserves user input and separates verification from generation', () => {
    const prompt = buildStudioPrompt(brief)
    expect(prompt).toContain(brief.idea)
    expect(prompt).toContain(brief.audience)
    expect(prompt).toContain(brief.constraints)
    expect(prompt).toContain('what remains unverified')
    expect(prompt).toContain('Preserve existing work')
    expect(prompt).not.toContain('window.forsion')
    expect(prompt).toContain('Respond in English')
  })
  it('injects only selected SDK capabilities, with stable order and no duplicates', () => {
    const prompt = buildStudioPrompt({ ...brief, capabilities: ['images', 'chat', 'chat'], locale: 'zh' })
    expect(prompt).toContain('Respond in Chinese')
    expect(prompt).toContain('/forsion-connect.js')
    expect(prompt).toContain('window.forsion.ai.chat')
    expect(prompt).toContain('window.forsion.ai.generateImage')
    expect(prompt).not.toContain('window.forsion.ai.agent')
    expect(prompt.match(/AI chat:/g)).toHaveLength(1)
    expect(prompt.indexOf('AI chat:')).toBeLessThan(prompt.indexOf('Image generation:'))
  })
  it('supports every template with valid unique folder names', () => {
    expect(new Set(STUDIO_TEMPLATES.map((v) => v.folderName)).size).toBe(STUDIO_TEMPLATES.length)
    for (const template of STUDIO_TEMPLATES) expect(validateProjectName(template.folderName)).toBeNull()
  })
})

/** 插件分支是新加的**岔路**,不是对老项目的改写:已有的网页简报必须一字不变。
 *  下面钉的是字节摘要(2026-09-21 在插件分支落地之前从真实输出取的),任何措辞改动都会红;
 *  真要改网页文案时,重新取摘要并在提交里写清为什么。 */
describe('web project output is byte-identical to before the plugin branch', () => {
  const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32)
  const cases: Array<[string, StudioBrief, string, string]> = [
    ['Chinese brief with capabilities', { idea: '做一个离线笔记应用', audience: '学生', constraints: '数据只放本地', capabilities: ['chat', 'images'], locale: 'zh', templateId: 'assistant' }, '019ccee89d82ef9468b060a697405a29', '91afefe75a1e10babf08d7ad4b08ad26'],
    ['English brief without optional sections', { idea: 'An offline reading app', audience: '', constraints: '', capabilities: [], locale: 'en' }, '33ff0ceb015a6e9a4f37a3db3c39fc29', '4f3ce3fd79c6ab0739bf8cc6fc614ca3'],
    ['English brief with every capability', { idea: 'Idea', audience: 'Aud', constraints: 'Con', capabilities: ['chat', 'agent', 'images', 'account'], locale: 'en' }, 'cf68d1e9b5443b102069331c487fbaaa', 'b9a47e58e1c450f5c62614591b1aa83f'],
  ]
  it.each(cases)('%s keeps its exact prompt and draft', (_name, brief, prompt, draft) => {
    expect(digest(buildStudioPrompt(brief))).toBe(prompt)
    expect(digest(buildStudioDraft(brief))).toBe(draft)
  })
  it('treats a missing kind and an explicit web kind as the same project', () => {
    const brief: StudioBrief = { idea: 'An offline reading app', audience: 'Students', constraints: 'Keep data local', capabilities: ['chat'], locale: 'en' }
    expect(buildStudioPrompt({ ...brief, kind: 'web' })).toBe(buildStudioPrompt(brief))
    expect(buildStudioDraft({ ...brief, kind: 'web' })).toBe(buildStudioDraft(brief))
  })
})

describe('Forsion plugin project', () => {
  const brief: StudioBrief = { idea: 'A ribbon clock that shows the time in a side panel', audience: 'Me', constraints: 'Keep it offline', capabilities: [], kind: 'plugin', locale: 'en' }
  it('describes the plugin project shape instead of a web app', () => {
    const prompt = buildStudioPrompt(brief)
    expect(prompt).toContain('Forsion desktop plugin')
    expect(prompt).toContain('Load the Forsion plugin skill first')
    expect(prompt).toContain('manifest.json at the project root, with id, name, version, apiVersion 1 and main')
    expect(prompt).toContain('bare setup(ctx) body')
    expect(prompt).toContain('Return a disposer')
    expect(prompt).toContain('Each save re-runs setup')
    expect(prompt).toContain('no build step, no bundler, no index.html and no Forsion Connect web SDK')
    expect(prompt).toContain('check.mjs')
    expect(prompt).toContain(brief.idea)
    expect(prompt).toContain(brief.audience)
    expect(prompt).toContain(brief.constraints)
    expect(prompt).not.toContain('window.forsion')
    expect(prompt).not.toContain('/forsion-connect.js')
    expect(prompt).not.toMatch(/[一-龥]/)
  })
  it('hands the Sandbox button to the user and treats its output as the evidence', () => {
    const prompt = buildStudioPrompt(brief)
    expect(prompt).toContain('Sandbox panel')
    expect(prompt).toContain('"Load into Forsion"')
    expect(prompt).toContain('You cannot press that button')
    expect(prompt).toContain('never claim the plugin was loaded, reloaded or verified in the app yourself')
    expect(prompt).toContain('view mount errors and console output I send from that panel as the evidence')
    expect(prompt).toContain('real notes with the privileges of an installed plugin')
  })
  it('ignores Connect capabilities even if an old brief carries them', () => {
    const prompt = buildStudioPrompt({ ...brief, capabilities: ['chat', 'images'] })
    expect(prompt).not.toContain('Requested Forsion Connect capabilities')
    expect(prompt).not.toContain('AI chat:')
  })
  it('keeps the visible draft short and bilingual, with optional sections omitted', () => {
    const english = buildStudioDraft(brief)
    expect(english).toContain('This is a Forsion desktop plugin project.')
    expect(english).toContain(`Goal: ${brief.idea}`)
    expect(english).toContain('Read the Forsion plugin skill first')
    expect(english).toContain('“Load into Forsion”')
    expect(english).not.toMatch(/[一-龥]/)
    expect(english.length).toBeLessThan(buildStudioPrompt(brief).length / 2)
    const chinese = buildStudioDraft({ ...brief, audience: '  ', constraints: '', locale: 'zh' })
    expect(chinese).toContain('Forsion 桌面插件项目')
    expect(chinese).toContain('在 Forsion 中加载')
    expect(chinese).not.toContain('受众：')
    expect(chinese).not.toContain('要求：')
  })
  it('offers exactly one plugin starting point, last and without Connect capabilities', () => {
    const plugins = STUDIO_TEMPLATES.filter((template) => template.kind === 'plugin')
    expect(plugins.map((template) => template.id)).toEqual(['plugin'])
    expect(STUDIO_TEMPLATES.at(-1)).toBe(plugins[0])
    expect(plugins[0].capabilities).toEqual([])
    expect(plugins[0].folderName).toBe('my-forsion-plugin')
    expect(STUDIO_TEMPLATES.filter((template) => template.kind && template.kind !== 'plugin')).toEqual([])
  })
})
