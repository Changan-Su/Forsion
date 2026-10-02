/** Portable document actions. Parsing never repairs or truncates user Markdown. */
export type DocumentAgentKind = 'instructions' | 'task' | 'prompt'

export interface DocAgentSpec {
  v: 1
  /** Stable document action identity; rendering or copying it never submits work. */
  id: string
  agent?: string
  prompt: string
  /** A submitted task opens this session instead of submitting again. */
  sessionId?: string
}

export const DOCUMENT_AGENT_LANGUAGES = {
  instructions: 'forsion-instructions',
  task: 'forsion-task',
  prompt: 'forsion-prompt',
} as const

const KEYS = new Set(['v', 'id', 'agent', 'prompt', 'sessionId'])
const validId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 &&
  value === value.trim() && !/[\u0000-\u0020\u007f]/.test(value)

/** Accept a fence body only. Unsupported data stays an ordinary source block. */
export function parseDocAgentSpec(body: string): DocAgentSpec | null {
  try {
    const spec: unknown = JSON.parse(body)
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null
    const value = spec as Record<string, unknown>
    if (Object.keys(value).some((key) => !KEYS.has(key)) || value.v !== 1 ||
      !validId(value.id) || typeof value.prompt !== 'string' ||
      (value.agent !== undefined && !validId(value.agent)) ||
      (value.sessionId !== undefined && !validId(value.sessionId))) return null
    return {
      v: 1, id: value.id, prompt: value.prompt,
      ...(value.agent !== undefined ? { agent: value.agent } : {}),
      ...(value.sessionId !== undefined ? { sessionId: value.sessionId } : {}),
    }
  } catch {
    return null
  }
}

/** A pure JSON body; the host owns the enclosing Markdown fence. */
export function serializeDocAgentSpec(spec: DocAgentSpec): string {
  const body = JSON.stringify(spec)
  if (!parseDocAgentSpec(body)) throw new Error('Invalid document agent block')
  return body
}

export function newDocAgentSpec(agent?: string, prompt = ''): DocAgentSpec {
  const spec: DocAgentSpec = { v: 1, id: crypto.randomUUID(), prompt, ...(agent ? { agent } : {}) }
  // Callers cannot accidentally insert a block this client cannot read back.
  serializeDocAgentSpec(spec)
  return spec
}

/** Use a delimiter longer than anything in the body, including pasted examples. */
export function documentAgentFence(kind: DocumentAgentKind, body: string): string {
  const longest = Math.max(2, ...Array.from(body.matchAll(/`+/g), (match) => match[0].length))
  const fence = '`'.repeat(longest + 1)
  return `${fence}${DOCUMENT_AGENT_LANGUAGES[kind]}\n${body}\n${fence}`
}
