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
    expect(draft).not.toContain('智能体工作流')
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
