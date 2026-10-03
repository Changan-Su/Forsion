// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setTanguProbe, idleAgentStatus, type TanguProbe, type TanguAgentStatus } from '../../plugins/tanguSeam'
import { DocumentAgentBlock, type DocumentAgentBlockProps } from './DocumentAgentBlock'
import { serializeDocAgentSpec } from './format'

let root: Root | undefined
let host: HTMLDivElement
let statusListener: ((status: TanguAgentStatus) => void) | undefined
const unsubscribe = vi.fn()

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  statusListener = undefined
  unsubscribe.mockClear()
  setTanguProbe({
    activeModel: () => null, models: () => [], activeSpace: () => null,
    agents: () => [{ slug: 'writer', name: 'Writer' }],
    subscribe: () => () => {}, startChat: vi.fn(), submitDocumentTask: vi.fn(),
    agentStatus: (sessionId: string) => idleAgentStatus(sessionId),
    subscribeAgentStatus: (callback: (status: TanguAgentStatus) => void) => { statusListener = callback; return unsubscribe },
  } as unknown as TanguProbe)
})

afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = undefined
  host.remove()
  setTanguProbe(null)
})

const props = (overrides: Partial<DocumentAgentBlockProps> = {}): DocumentAgentBlockProps => ({
  kind: 'task', src: serializeDocAgentSpec({ v: 1, id: 'task-1', agent: 'writer', prompt: 'Summarize this page' }),
  pagePath: 'Research.md', onChange: vi.fn(), onStart: vi.fn(async () => ({ sessionId: 'session-1' })),
  ...overrides,
})

async function render(value: DocumentAgentBlockProps): Promise<void> {
  await act(async () => { root!.render(createElement(DocumentAgentBlock, value)) })
}

function action(): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>('.am-doc-agent-action')
  expect(button).not.toBeNull()
  return button!
}

async function typeIntoTextarea(value: string): Promise<void> {
  const field = host.querySelector('textarea')!
  // Use the native setter so React sees an actual input change, not its value tracker.
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('document agent block lifecycle', () => {
  it('persists instructions while typing, before blur or page navigation', async () => {
    const value = props({ kind: 'instructions', src: 'Keep sources.' })
    await render(value)
    await typeIntoTextarea('Keep sources.\nPreserve the original language.')
    expect(value.onChange).toHaveBeenLastCalledWith('Keep sources.\nPreserve the original language.')
    expect(value.onStart).not.toHaveBeenCalled()
    await render({ ...value, pagePath: 'Other.md', src: 'Other instructions', activeInstructions: false })
    expect(host.querySelector('textarea')?.value).toBe('Other instructions')
    expect(host.textContent).toContain('移到页面顶层后生效')
  })

  it('persists task drafts before blur while keeping the textarea mounted', async () => {
    const value = props()
    await render(value)
    const field = host.querySelector('textarea')
    await typeIntoTextarea('New draft')
    const body = vi.mocked(value.onChange).mock.lastCall![0]
    expect(JSON.parse(body)).toMatchObject({ id: 'task-1', prompt: 'New draft' })
    await render({ ...value, src: body })
    expect(host.querySelector('textarea')).toBe(field)
    expect(field?.value).toBe('New draft')
  })

  it('renders imported tasks without starting work and provides no execution action on read-only pages', async () => {
    const value = props({ readOnly: true })
    await render(value)
    expect(value.onStart).not.toHaveBeenCalled()
    expect(value.onChange).not.toHaveBeenCalled()
    expect(host.querySelector('button')).toBeNull()
    expect(host.querySelector('textarea')).toBeNull()
    expect(host.textContent).toContain('Summarize this page')
  })

  it('saves before dispatch and refuses same-tick double submission', async () => {
    const events: string[] = []
    let complete!: (result: { sessionId: string }) => void
    const pending = new Promise<{ sessionId: string }>((resolve) => { complete = resolve })
    const value = props({
      onChange: vi.fn(() => { events.push('save') }),
      onStart: vi.fn(() => { events.push('start'); return pending }),
    })
    await render(value)
    await act(async () => { action().click(); action().click() })
    expect(events).toEqual(['save', 'start'])
    expect(action().disabled).toBe(true)
    await act(async () => { complete({ sessionId: 'session-1' }); await pending })
    expect(value.onStart).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('已关联会话')
  })

  it('does not write a stale block after dispatch outlives its renderer', async () => {
    let complete!: (result: { sessionId: string }) => void
    const pending = new Promise<{ sessionId: string }>((resolve) => { complete = resolve })
    const value = props({ onStart: vi.fn(() => pending) })
    await render(value)
    await act(async () => { action().click() })
    await act(async () => { root!.unmount(); root = undefined })
    await act(async () => { complete({ sessionId: 'session-1' }); await pending })
    expect(value.onChange).toHaveBeenCalledTimes(1)
    // The parent onStart owns durable association, independent of this component.
    expect(value.onStart).toHaveBeenCalledTimes(1)
  })

  it('opens an existing task session, scopes live status to that session, and cleans up', async () => {
    const value = props({
      src: serializeDocAgentSpec({ v: 1, id: 'task-1', prompt: 'Existing task', sessionId: 'session-1' }),
      onOpen: vi.fn(),
    })
    await render(value)
    await act(async () => { action().click() })
    expect(value.onOpen).toHaveBeenCalledWith('session-1')
    expect(value.onStart).not.toHaveBeenCalled()
    await act(async () => { statusListener?.({ ...idleAgentStatus('other-session'), phase: 'error' }) })
    expect(host.textContent).not.toContain('执行遇到问题')
    await act(async () => { statusListener?.({ ...idleAgentStatus('session-1'), phase: 'waiting' }) })
    expect(host.textContent).toContain('等待你回应')
    await act(async () => { root!.unmount(); root = undefined })
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('keeps prompts reusable while tasks with a saved session never resubmit', async () => {
    const value = props({ kind: 'prompt', onStart: vi.fn(async () => ({})) })
    await render(value)
    await act(async () => { action().click() })
    await act(async () => { action().click() })
    expect(value.onStart).toHaveBeenCalledTimes(2)
    expect(value.onStart).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'task-1' }), 'prompt')
  })

  it('recovers from a failed dispatch without inventing a session', async () => {
    const value = props({ onStart: vi.fn().mockRejectedValueOnce(new Error('Storage conflict')).mockResolvedValue({ sessionId: 'session-2' }) })
    await render(value)
    await act(async () => { action().click() })
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Storage conflict')
    expect(action().disabled).toBe(false)
    await act(async () => { action().click() })
    expect(value.onStart).toHaveBeenCalledTimes(2)
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })

  it('shows malformed source intact without editable or runnable controls', async () => {
    const value = props({ src: '{"prompt": "unfinished"' })
    await render(value)
    expect(host.querySelector('code')?.textContent).toBe(value.src)
    expect(host.querySelector('button')).toBeNull()
    expect(value.onChange).not.toHaveBeenCalled()
  })

  it('disables session creation when the host has no dispatch capability', async () => {
    setTanguProbe(null)
    const value = props()
    await render(value)
    expect(action().disabled).toBe(true)
    await act(async () => { action().click() })
    expect(value.onStart).not.toHaveBeenCalled()
  })
})
