export type AutomationMessageDelivery = 'inbox' | 'solo'
export type AutomationMessageSource = 'fixed' | 'agent'

export type SendMessageAction = {
  type: 'send_message'
  agentSlug: string
  delivery: AutomationMessageDelivery
} & ({ source: 'fixed'; body: string } | { source: 'agent'; prompt: string })

export const AUTOMATION_MESSAGE_LIMIT = { solo: 1500, inbox: 4000 } as const
export const AUTOMATION_MESSAGE_PROMPT_LIMIT = 500
/** A compose step waits for its final draft. The client allows this plus time for delivery. */
export const AUTOMATION_COMPOSE_TIMEOUT_MS = 120_000

export const AUTOMATION_DM_ORIGIN = 'proactive:automation'
const SOURCE_PREFIX = 'Automation: '

export function automationDmContent(rule: string, body: string): string {
  return SOURCE_PREFIX + rule.replace(/\s+/g, ' ').trim() + '\n\n' + body
}

export function readAutomationDm(content: string): { rule?: string; body: string } {
  const split = content.indexOf('\n\n')
  if (!content.startsWith(SOURCE_PREFIX) || split < SOURCE_PREFIX.length) return { body: content }
  return { rule: content.slice(SOURCE_PREFIX.length, split).trim(), body: content.slice(split + 2) }
}
