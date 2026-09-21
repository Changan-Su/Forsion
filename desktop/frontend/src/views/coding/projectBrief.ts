/** A project brief is user-owned input. Creating it never starts a model run. */
export type StudioCapability = 'chat' | 'agent' | 'images' | 'account'

/** 项目形态。缺省(老简报里没有这个字段)= 'web',历史项目的输出必须一字不变。 */
export type StudioProjectKind = 'web' | 'plugin'

export interface StudioBrief {
  idea: string
  audience: string
  constraints: string
  capabilities: StudioCapability[]
  templateId?: string
  kind?: StudioProjectKind
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

/** A Forsion desktop plugin is not a web page: it has no preview URL, no build step and no
 *  Connect SDK. It runs inside the real app, so the disposer discipline is part of the brief. */
function buildPluginPrompt(brief: StudioBrief): string {
  const lines = [
    'Build this Forsion desktop plugin with me in Forsion Coding Studio.',
    `Respond in ${brief.locale === 'zh' ? 'Chinese' : 'English'} unless the project brief requests another language.`,
    'Load the Forsion plugin skill first and follow it; do not invent plugin APIs that the skill does not document.',
    '',
    'Project shape:',
    '- Keep manifest.json at the project root, with id, name, version, apiVersion 1 and main.',
    '- Keep the file named by main at the project root as well. Its contents are a bare setup(ctx) body: no top-level import or export statements, because the host evaluates the source with ctx already in scope.',
    '- Return a disposer from that body and release every timer, listener, command and view in it. Each save re-runs setup, so anything left behind stacks up.',
    '- There is no build step, no bundler, no index.html and no Forsion Connect web SDK here. This project is not a web app.',
    '',
    'Working agreement:',
    '- Inspect the current project and the documented plugin API before choosing an implementation. Preserve existing work and project instructions.',
    '- Start with a short plan and concrete acceptance steps for the main user journey. Make reasonable assumptions explicit and keep the first version focused.',
    '- Build in small, working increments. Use accessible controls, clear loading, empty and error states, and the host theme variables instead of hard-coded colors.',
    '- Ask me to open the Sandbox panel in Coding Studio and choose "Load into Forsion" to try the plugin. You cannot press that button; never claim the plugin was loaded, reloaded or verified in the app yourself.',
    '- Treat the setup error, view mount errors and console output I send from that panel as the evidence for the next fix. Do not propose a cause the evidence does not support.',
    '- Leave a check.mjs next to the plugin for any non-trivial logic and run it with node before calling the work complete. Report what was actually verified and what remains unverified.',
    '- The dev copy runs on my real notes with the privileges of an installed plugin. Do not write, move or delete my data while experimenting, expose credentials, or create paid external resources without explicit authorization.',
  ]
  lines.push('', 'Plugin idea (user input):', brief.idea.trim())
  if (brief.audience.trim()) lines.push('', 'Audience (user input):', brief.audience.trim())
  if (brief.constraints.trim()) lines.push('', 'Requirements and constraints to preserve (user input):', brief.constraints.trim())
  return lines.join('\n')
}

/** Plain English agent instructions wrap, but never rewrite, the user's original brief. */
export function buildStudioPrompt(brief: StudioBrief): string {
  if (brief.kind === 'plugin') return buildPluginPrompt(brief)
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
  if (brief.kind === 'plugin') {
    const lines = [
      zh ? '请先阅读已保存的 FORSION_BRIEF.md，这是一个 Forsion 桌面插件项目。' : 'Read the saved FORSION_BRIEF.md. This is a Forsion desktop plugin project.',
      '',
      `${zh ? '目标：' : 'Goal: '}${brief.idea.trim()}`,
    ]
    if (brief.audience.trim()) lines.push(`${zh ? '受众：' : 'Audience: '}${brief.audience.trim()}`)
    if (brief.constraints.trim()) lines.push(`${zh ? '要求：' : 'Requirements: '}${brief.constraints.trim()}`)
    lines.push('', zh
      ? '先读 Forsion 插件技能，再按当前模式推进：计划模式下先给出方案；执行模式下把 manifest.json 与 main 文件写在项目根，写完请我去 Sandbox 面板点「在 Forsion 中加载」试用。'
      : 'Read the Forsion plugin skill first, then respect the current mode: in plan mode, propose a plan; in build mode, write manifest.json and the main file at the project root, then ask me to open the Sandbox panel and choose “Load into Forsion” to try it.')
    return lines.join('\n')
  }
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
  /** 缺省 'web'。'plugin' 的模板不提供 Forsion Connect 能力(插件跑在宿主里,不走网页 SDK)。 */
  kind?: StudioProjectKind
}

/** Templates are editable starting prompts, not prebuilt or already verified apps. */
export const STUDIO_TEMPLATES: readonly StudioTemplate[] = [
  { id: 'assistant', nameKey: 'csl.template.assistant.name', summaryKey: 'csl.template.assistant.summary', ideaKey: 'csl.template.assistant.idea', folderName: 'writing-assistant', capabilities: ['chat'] },
  { id: 'dashboard', nameKey: 'csl.template.dashboard.name', summaryKey: 'csl.template.dashboard.summary', ideaKey: 'csl.template.dashboard.idea', folderName: 'personal-dashboard', capabilities: [] },
  { id: 'portfolio', nameKey: 'csl.template.portfolio.name', summaryKey: 'csl.template.portfolio.summary', ideaKey: 'csl.template.portfolio.idea', folderName: 'my-portfolio', capabilities: [] },
  { id: 'explainer', nameKey: 'csl.template.explainer.name', summaryKey: 'csl.template.explainer.summary', ideaKey: 'csl.template.explainer.idea', folderName: 'interactive-explainer', capabilities: [] },
  { id: 'image', nameKey: 'csl.template.image.name', summaryKey: 'csl.template.image.summary', ideaKey: 'csl.template.image.idea', folderName: 'creative-studio', capabilities: ['images'] },
  { id: 'research', nameKey: 'csl.template.research.name', summaryKey: 'csl.template.research.summary', ideaKey: 'csl.template.research.idea', folderName: 'research-assistant', capabilities: ['agent'] },
  // 插件模板排在最后:ProjectLaunchpad.test.ts 的 useFirstTemplate() 点第一张卡,挪位置会把网页那条链测红。
  { id: 'plugin', nameKey: 'csl.template.plugin.name', summaryKey: 'csl.template.plugin.summary', ideaKey: 'csl.template.plugin.idea', folderName: 'my-forsion-plugin', capabilities: [], kind: 'plugin' },
]
