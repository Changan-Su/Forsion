/** A project brief is user-owned input. Creating it never starts a model run. */
export type StudioCapability = 'chat' | 'agent' | 'images' | 'account'

export interface StudioBrief {
  idea: string
  audience: string
  constraints: string
  capabilities: StudioCapability[]
  templateId?: string
  locale: 'zh' | 'en'
}

export const STUDIO_CAPABILITIES: readonly StudioCapability[] = ['chat', 'agent', 'images', 'account']

/** Only APIs implemented by electron/forsionConnectLocal.ts belong here. */
const CAPABILITY_INSTRUCTIONS: Record<StudioCapability, string> = {
  chat: 'AI chat: use window.forsion.ai.chat({ prompt, onDelta }) or { messages, onDelta }; consume the returned text. Do not invent a model ID; omit it to use the configured model.',
  agent: 'Agent workflow: use window.forsion.ai.agent({ input, session, onDelta }); preserve the returned session for follow-ups. The server manages tools and model routing; do not claim arbitrary client-side tool APIs exist.',
  images: 'Image generation: use window.forsion.ai.generateImage({ prompt }) and consume images[].url or images[].b64. Show progress, empty results, and actionable failures; model availability is configured by the platform.',
  account: 'Forsion account: use window.forsion.user() to read the current user and window.forsion.login() when sign-in is needed. Handle a null user and login failure. Preview uses the desktop sign-in session.',
}

export type ProjectNameIssue = 'empty' | 'invalid' | 'long' | 'reserved' | 'duplicate'

/** Validate a single portable folder name; never silently turn a path into a name. */
export function validateProjectName(raw: string, existing: readonly string[] = []): ProjectNameIssue | null {
  const name = raw.trim().normalize('NFC')
  if (!name) return 'empty'
  if (name.length > 100) return 'long'
  if (/[<>:"/\\|?*\u0000-\u001f\u007f]/.test(name) || name.startsWith('.') || name.endsWith('.')) return 'invalid'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) return 'reserved'
  if (existing.some((v) => v.normalize('NFC').toLowerCase() === name.toLowerCase())) return 'duplicate'
  return null
}

export function projectBasename(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || path
}

/** Plain English agent instructions wrap, but never rewrite, the user's original brief. */
export function buildStudioPrompt(brief: StudioBrief): string {
  const selected = STUDIO_CAPABILITIES.filter((id) => brief.capabilities.includes(id))
  const lines = [
    'Build this project with me in Forsion Coding Studio.',
    `Respond in ${brief.locale === 'zh' ? 'Chinese' : 'English'} unless the project brief requests another language.`,
    '',
    'Working agreement:',
    '- Inspect the current project and available runtime before choosing an implementation. Preserve existing work and project instructions.',
    '- Start with a short plan and concrete acceptance steps for the main user journey. Make reasonable assumptions explicit and keep the first version focused.',
    '- Build in small, working increments. Use realistic content, accessible controls, responsive layouts, and clear loading, empty, and error states.',
    '- Reuse the project design system and components when available. Keep application code and dependencies maintainable.',
    '- Run appropriate checks and verify the preview before calling the work complete. Report what was actually verified and what remains unverified.',
    '- If something fails, inspect the actual error and prior attempts before another fix. Preserve a recoverable version before risky changes.',
    '- Do not publish, expose credentials, or create paid external resources without explicit authorization.',
  ]
  if (selected.length) {
    lines.push('', 'Requested Forsion Connect capabilities:',
      'For the managed preview, load /forsion-connect.js and use its window.forsion SDK. Check availability and handle authorization or configuration failures. Never embed API keys or access tokens in the app. Use the documented Connect publishing flow for deployment.',
      ...selected.map((id) => `- ${CAPABILITY_INSTRUCTIONS[id]}`))
  }
  lines.push('', 'Project idea (user input):', brief.idea.trim())
  if (brief.audience.trim()) lines.push('', 'Audience (user input):', brief.audience.trim())
  if (brief.constraints.trim()) lines.push('', 'Requirements and constraints to preserve (user input):', brief.constraints.trim())
  return lines.join('\n')
}

/** Human-readable composer draft. Detailed engine/SDK instructions live in the
 * saved FORSION_BRIEF.md; the visible draft keeps the user's intent easy to edit. */
export function buildStudioDraft(brief: StudioBrief): string {
  const zh = brief.locale === 'zh'
  const capabilities: Record<StudioCapability, string> = zh
    ? { chat: 'AI 对话', agent: '智能体工作流', images: '图像生成', account: 'Forsion 账号' }
    : { chat: 'AI chat', agent: 'Agent workflows', images: 'Image generation', account: 'Forsion account' }
  const selected = STUDIO_CAPABILITIES.filter(id => brief.capabilities.includes(id))
  const lines = [
    zh ? '请先阅读已保存的 FORSION_BRIEF.md，按这份项目简报开始。' : 'Read the saved FORSION_BRIEF.md and start from the project brief.',
    '',
    `${zh ? '目标：' : 'Goal: '}${brief.idea.trim()}`,
  ]
  if (brief.audience.trim()) lines.push(`${zh ? '受众：' : 'Audience: '}${brief.audience.trim()}`)
  if (brief.constraints.trim()) lines.push(`${zh ? '要求：' : 'Requirements: '}${brief.constraints.trim()}`)
  if (selected.length) lines.push(`${zh ? '需要的能力：' : 'Requested capabilities: '}${selected.map(id => capabilities[id]).join(zh ? '、' : ', ')}`)
  lines.push('', zh
    ? '先列出简短步骤，再按当前模式推进：计划模式下先给出方案；执行模式下分步实现并验证主要流程。'
    : 'Outline a few steps first and respect the current mode: in plan mode, propose a plan; in build mode, implement in small steps and verify the main user journey.')
  return lines.join('\n')
}

export interface StudioTemplate {
  id: string
  nameKey: string
  summaryKey: string
  ideaKey: string
  folderName: string
  capabilities: StudioCapability[]
}

/** Templates are editable starting prompts, not prebuilt or already verified apps. */
export const STUDIO_TEMPLATES: readonly StudioTemplate[] = [
  { id: 'assistant', nameKey: 'csl.template.assistant.name', summaryKey: 'csl.template.assistant.summary', ideaKey: 'csl.template.assistant.idea', folderName: 'writing-assistant', capabilities: ['chat'] },
  { id: 'dashboard', nameKey: 'csl.template.dashboard.name', summaryKey: 'csl.template.dashboard.summary', ideaKey: 'csl.template.dashboard.idea', folderName: 'personal-dashboard', capabilities: [] },
  { id: 'portfolio', nameKey: 'csl.template.portfolio.name', summaryKey: 'csl.template.portfolio.summary', ideaKey: 'csl.template.portfolio.idea', folderName: 'my-portfolio', capabilities: [] },
  { id: 'explainer', nameKey: 'csl.template.explainer.name', summaryKey: 'csl.template.explainer.summary', ideaKey: 'csl.template.explainer.idea', folderName: 'interactive-explainer', capabilities: [] },
  { id: 'image', nameKey: 'csl.template.image.name', summaryKey: 'csl.template.image.summary', ideaKey: 'csl.template.image.idea', folderName: 'creative-studio', capabilities: ['images'] },
  { id: 'research', nameKey: 'csl.template.research.name', summaryKey: 'csl.template.research.summary', ideaKey: 'csl.template.research.idea', folderName: 'research-assistant', capabilities: ['agent'] },
]
