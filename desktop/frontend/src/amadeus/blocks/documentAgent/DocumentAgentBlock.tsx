import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { ArrowUpRight, Bot, Check, LoaderCircle, ScrollText, Sparkles } from 'lucide-react'
import { registerMessages, useI18n } from '../../../i18n'
import { readTangu, type TanguAgentPhase } from '../../plugins/tanguSeam'
import { parseDocAgentSpec, serializeDocAgentSpec, type DocAgentSpec, type DocumentAgentKind } from './format'
import './documentAgent.css'

registerMessages({
  'docagent.instructions': { zh: '本页指令', en: 'Page instructions' },
  'docagent.instructionsScope': { zh: '仅用于维护本页', en: 'Applies to this page only' },
  'docagent.instructionsNested': { zh: '移到页面顶层后生效', en: 'Move to the page top level to apply' },
  'docagent.instructionsPlaceholder': { zh: '写下维护本页时应遵循的要求…', en: 'Describe how this page should be maintained…' },
  'docagent.task': { zh: '交办 Agent', en: 'Agent task' },
  'docagent.prompt': { zh: '提示模板', en: 'Prompt template' },
  'docagent.promptPlaceholder': { zh: '描述要让 Agent 完成的工作…', en: 'Describe the work for the agent…' },
  'docagent.promptLabel': { zh: '任务内容', en: 'Task prompt' },
  'docagent.agent': { zh: '选择 Agent', en: 'Select agent' },
  'docagent.defaultAgent': { zh: '默认 Agent', en: 'Default agent' },
  'docagent.assign': { zh: '交办', en: 'Assign task' },
  'docagent.usePrompt': { zh: '使用提示', en: 'Use prompt' },
  'docagent.open': { zh: '查看会话', en: 'Open session' },
  'docagent.starting': { zh: '正在交办…', en: 'Starting…' },
  'docagent.ready': { zh: '待交办', en: 'Ready to assign' },
  'docagent.linked': { zh: '已关联会话', en: 'Session linked' },
  'docagent.running': { zh: '处理中', en: 'Working' },
  'docagent.waiting': { zh: '等待你回应', en: 'Waiting for you' },
  'docagent.done': { zh: '本轮已完成', en: 'Turn completed' },
  'docagent.failed': { zh: '执行遇到问题', en: 'Run needs attention' },
  'docagent.startFailed': { zh: '交办失败，请重试', en: 'Could not start. Please try again.' },
  'docagent.noSession': { zh: '会话尚未关联，请重试', en: 'No session was linked. Please try again.' },
  'docagent.unavailable': { zh: '当前环境无法创建会话', en: 'Sessions cannot be started in this environment' },
  'docagent.empty': { zh: '尚未填写内容', en: 'No content yet' },
})

export interface DocumentAgentBlockProps {
  kind: DocumentAgentKind
  /** Fence body, not the whole Markdown block. */
  src: string
  pagePath: string
  readOnly?: boolean
  activeInstructions?: boolean
  onChange: (body: string) => void
  /**
   * The host must flush the draft before dispatch, deduplicate by page + id, and
   * persist the task/session association even if this renderer unmounts.
   * This component deliberately does not write an old snapshot after awaiting.
   */
  onStart: (spec: DocAgentSpec, mode: 'task' | 'prompt') => Promise<{ sessionId?: string }>
  onOpen?: (sessionId: string) => void
}

export function DocumentAgentBlock(props: DocumentAgentBlockProps): ReactElement {
  return props.kind === 'instructions'
    ? <InstructionsBlock key={props.pagePath} {...props} />
    : <ActionBlock key={`${props.kind}:${props.pagePath}:${parseDocAgentSpec(props.src)?.id ?? 'source'}`} {...props} />
}

function InstructionsBlock({ src, readOnly = false, activeInstructions = true, onChange }: DocumentAgentBlockProps): ReactElement {
  const { t } = useI18n()
  const [draft, setDraft] = useState(src)
  useEffect(() => { setDraft(src) }, [src])
  return <section className="am-doc-agent am-doc-agent-instructions" data-document-agent="instructions" data-active={activeInstructions}>
    <div className="am-doc-agent-header">
      <ScrollText size={16} aria-hidden="true" />
      <span className="am-doc-agent-title">{t('docagent.instructions')}</span>
      <span className="am-doc-agent-hint">{t(activeInstructions ? 'docagent.instructionsScope' : 'docagent.instructionsNested')}</span>
    </div>
    {readOnly
      ? <div className="am-doc-agent-content">{src || t('docagent.empty')}</div>
      : <textarea className="am-doc-agent-input" aria-label={t('docagent.instructions')} rows={3}
        placeholder={t('docagent.instructionsPlaceholder')} value={draft}
        onKeyDown={(event) => event.stopPropagation()}
        onChange={(event) => { setDraft(event.target.value); onChange(event.target.value) }} />}
  </section>
}

function ActionBlock({ kind, src, pagePath, readOnly = false, onChange, onStart, onOpen }: DocumentAgentBlockProps): ReactElement {
  const { t } = useI18n()
  const parsed = useMemo(() => parseDocAgentSpec(src), [src])
  const [draft, setDraft] = useState(parsed)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [createdSession, setCreatedSession] = useState<{ id: string; sessionId: string } | null>(null)
  const [phase, setPhase] = useState<TanguAgentPhase>('idle')
  const alive = useRef(false)
  const busyRef = useRef(false)
  const probe = readTangu()
  const canStart = kind === 'task'
    ? typeof probe?.submitDocumentTask === 'function' && probe.hostExecution?.() !== false
    : typeof probe?.startChat === 'function'
  const [agents, setAgents] = useState(() => probe?.agents?.() ?? [])
  const sessionId = kind === 'task' ? parsed?.sessionId || (createdSession?.id === parsed?.id ? createdSession?.sessionId : undefined) : undefined
  const frozen = readOnly || busy || !!sessionId

  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => { setDraft(parsed); setError(null) }, [parsed])
  useEffect(() => {
    const refresh = (): void => { setAgents(probe?.agents?.() ?? []) }
    refresh()
    return probe?.subscribeAgents ? probe.subscribeAgents(refresh) : probe?.subscribe(refresh)
  }, [probe])
  useEffect(() => {
    setPhase(sessionId ? probe?.agentStatus?.(sessionId).phase ?? 'idle' : 'idle')
    if (!sessionId) return
    return probe?.subscribeAgentStatus?.((status) => {
      if (status.sessionId === sessionId) setPhase(status.phase)
    }, sessionId)
  }, [probe, sessionId])

  const start = async (): Promise<void> => {
    if (readOnly || !canStart || busyRef.current || !draft || !draft.prompt.trim() || sessionId) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      // Commit synchronously, then the host flushes and dispatches. Keeping the
      // follow-up write in the host avoids stale NodeView callbacks after edits.
      onChange(serializeDocAgentSpec(draft))
      const result = await onStart(draft, kind === 'prompt' ? 'prompt' : 'task')
      if (kind === 'task' && !result.sessionId) throw new Error(t('docagent.noSession'))
      if (alive.current && kind === 'task' && result.sessionId) setCreatedSession({ id: draft.id, sessionId: result.sessionId })
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : t('docagent.startFailed'))
    } finally {
      busyRef.current = false
      if (alive.current) setBusy(false)
    }
  }

  // Defensive fallback. The embed host should leave invalid JSON as ordinary code.
  if (!parsed || !draft) return <pre className="am-doc-agent-source"><code>{src}</code></pre>
  const statusKey = !sessionId ? 'docagent.ready' : phase === 'waiting' ? 'docagent.waiting'
    : phase === 'done' ? 'docagent.done' : phase === 'error' ? 'docagent.failed'
      : phase === 'idle' ? 'docagent.linked' : 'docagent.running'
  const running = busy || (!!sessionId && ['thinking', 'speaking', 'tool'].includes(phase))
  const Icon = kind === 'prompt' ? Sparkles : Bot
  const selectedMissing = draft.agent && !agents.some((agent) => agent.slug === draft.agent)

  return <section className="am-doc-agent" data-document-agent={kind} data-document-agent-id={draft.id} data-page-path={pagePath} aria-busy={busy}>
    <div className="am-doc-agent-header">
      <Icon size={16} aria-hidden="true" />
      <span className="am-doc-agent-title">{t(kind === 'prompt' ? 'docagent.prompt' : 'docagent.task')}</span>
      {kind === 'task' && <span className="am-doc-agent-status" role="status" aria-live="polite" data-phase={phase}>
        {running ? <LoaderCircle size={12} className="am-doc-agent-spin" aria-hidden="true" /> : phase === 'done' ? <Check size={12} aria-hidden="true" /> : null}
        {t(busy ? 'docagent.starting' : statusKey)}
      </span>}
    </div>
    {readOnly || sessionId
      ? <div className="am-doc-agent-content">{draft.prompt || t('docagent.empty')}</div>
      : <textarea className="am-doc-agent-input" aria-label={t('docagent.promptLabel')} rows={3}
        placeholder={t('docagent.promptPlaceholder')} value={draft.prompt} disabled={busy}
        onKeyDown={(event) => event.stopPropagation()}
        onChange={(event) => {
          const next = { ...draft, prompt: event.target.value }
          setDraft(next)
          onChange(serializeDocAgentSpec(next))
        }} />}
    <div className="am-doc-agent-footer">
      {frozen
        ? <span className="am-doc-agent-assignee">{agents.find((agent) => agent.slug === draft.agent)?.name || draft.agent || t('docagent.defaultAgent')}</span>
        : <select className="am-doc-agent-select" aria-label={t('docagent.agent')} value={draft.agent ?? ''}
          onKeyDown={(event) => event.stopPropagation()}
          onChange={(event) => {
            const next = { ...draft, agent: event.target.value || undefined }
            setDraft(next)
            onChange(serializeDocAgentSpec(next))
          }}>
          <option value="">{t('docagent.defaultAgent')}</option>
          {selectedMissing && <option value={draft.agent}>{draft.agent}</option>}
          {agents.map((agent) => <option key={agent.slug} value={agent.slug}>{agent.name}</option>)}
        </select>}
      {sessionId
        ? onOpen && <button type="button" className="am-doc-agent-action" onClick={() => onOpen(sessionId)}><ArrowUpRight size={14} aria-hidden="true" />{t('docagent.open')}</button>
        : !readOnly && <button type="button" className="am-doc-agent-action" disabled={busy || !canStart || !draft.prompt.trim()}
          title={!canStart ? t('docagent.unavailable') : undefined}
          onMouseDown={(event) => event.preventDefault()} onClick={() => { void start() }}>
          {busy ? <LoaderCircle size={14} className="am-doc-agent-spin" aria-hidden="true" /> : <ArrowUpRight size={14} aria-hidden="true" />}
          {t(busy ? 'docagent.starting' : kind === 'prompt' ? 'docagent.usePrompt' : 'docagent.assign')}
        </button>}
    </div>
    {!readOnly && !sessionId && !canStart && <div className="am-doc-agent-hint">{t('docagent.unavailable')}</div>}
    {error && <div className="am-doc-agent-error" role="alert">{error}</div>}
  </section>
}
