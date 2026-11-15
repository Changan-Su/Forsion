import { registerMessages, translationValues } from '../i18n'

registerMessages({
  'agent.builtin.arioso': {
    zh: '克制温柔，清醒理智，记得对你重要的事',
    en: 'Quiet warmth and clear judgment, with memory of what matters to you',
  },
  'agent.builtin.aria': {
    zh: '细腻洞察情绪，以想象力陪你表达与创作',
    en: 'Emotional insight, expressive writing, and imaginative collaboration',
  },
  'agent.builtin.recita': {
    zh: '理智审视假设，依据事实判断，让建议落到实处',
    en: 'Critical thinking, grounded decisions, and practical next steps',
  },
  'agent.builtin.coding': {
    zh: '从需求到可运行的网页应用，支持实时预览与验证修复',
    en: 'Build and refine working web apps with a project brief, live preview, Forsion AI, and verified repairs',
  },
  'agent.builtin.muse': {
    zh: '安静的后台观察者，发现值得推进的下一步',
    en: 'A quiet background observer that finds worthwhile next steps',
  },
  // 自带的 DSH(11-14,DSH 融合第 2 步):en 与引擎 DSH_AGENT_PRESET.description 逐字一致
  'agent.builtin.dsh': {
    zh: '跑在这台电脑装的 DeepSeek Harness 上',
    en: 'Runs on DeepSeek Harness installed on this computer',
  },
})

const keys: Record<string, string> = {
  xyra: 'agent.builtin.arioso', aria: 'agent.builtin.aria', recita: 'agent.builtin.recita',
  coding: 'agent.builtin.coding', muse: 'agent.builtin.muse',
}

/** 内置 agent(引擎按 slug 认,不能改文件夹名)。 */
export const isStockAgent = (slug: string): boolean => Object.hasOwn(keys, slug)

/** Translate only stock copy at render time; user-authored descriptions stay verbatim. */
/** 只翻描述、不算「内置」的:自带的 DSH 和普通 Agent 一样能改 ID、能删。 */
const descriptionKeys: Record<string, string> = { ...keys, dsh: 'agent.builtin.dsh' }

export function agentDescription(agent: { slug: string; description: string }, t: (key: string) => string): string {
  const key = descriptionKeys[agent.slug]
  return key && translationValues(key).includes(agent.description) ? t(key) : agent.description
}
