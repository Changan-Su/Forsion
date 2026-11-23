// @vitest-environment happy-dom
/** Muse 待办卡的「依据 · N 条」(借鉴 dsh-superagent 第 2 条,11-20):依据和状态同一次按 id 读(GET /agent/special/muse/todos/:id),
 *  缺省收起、点开一行一条;来源 / 短摘按纯文本画;老待办没有依据就不画这一行;不走真状态读取的卡(别的 agent 写的 todo 头)不画。 */
import { describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean; React: typeof React }
g.IS_REACT_ACT_ENVIRONMENT = true
g.React = React

const EVIDENCE: Record<string, unknown[]> = {
  t1: [
    { kind: 'chat', source: 'You, in chat · 2026-11-20 10:12', quote: 'Keep an eye on my homework this week' },
    { kind: 'file', source: '/Notes/LinAlg/ch3.md', quote: '<b>Done up to Q12</b>' },
    { kind: 'mystery', source: 'Somewhere', quote: 'odd kind' },
  ],
  old: [],
}
vi.mock('../../services/backendService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getMuseTodo: vi.fn(async (_t: unknown, id: string) => ({ id, title: id, status: 'pending', evidence: EVIDENCE[id] })),
}))

const { TaskCards, fetchMuseTodoStatus, useMuseTodoEvidence } = await import('./TaskCards')
await import('../../tangu/store/standalone')
const { translate } = await import('../../i18n')

function mount(props: Record<string, unknown>): HTMLDivElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  act(() => createRoot(host).render(createElement(TaskCards as any, { ownerId: `m${Math.random()}`, ...props })))
  return host
}
const toggle = (host: HTMLElement): HTMLButtonElement | null => host.querySelector('[data-evidence-toggle]')

describe('Muse 待办卡的依据', () => {
  ;(window as any).tangu = { backendStatus: () => {} }

  it('按 id 读到依据:一行「依据 · 3 条」,缺省收起;点开逐条列出,纯文本,认不出的 kind 也照画', async () => {
    await fetchMuseTodoStatus('t1')
    const host = mount({ tasks: [{ title: 'T', prompt: 'p', todo: 't1' }], todoStatus: { t1: 'pending' } })
    const btn = toggle(host)!
    expect(btn.textContent!.trim()).toBe(translate('chat.task.evidence', { n: 3 }))
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    expect(host.querySelector('.t2-taskcard-evidence')).toBeNull()
    // 在「查看任务书」那一行之前
    const toggles = [...host.querySelectorAll('.t2-taskcard-toggle')]
    expect(toggles.indexOf(btn)).toBeLessThan(toggles.findIndex((b) => b.textContent!.includes(translate('chat.task.showPrompt'))))
    await act(async () => { btn.click() })
    const rows = [...host.querySelectorAll('.t2-taskcard-evidence > li')]
    expect(rows.map((r) => r.getAttribute('data-evidence-kind'))).toEqual(['chat', 'file', 'mystery'])
    expect(rows[0].querySelector('.t2-taskcard-evsrc')!.textContent).toBe('You, in chat · 2026-11-20 10:12')
    expect(rows[1].textContent).toContain('<b>Done up to Q12</b>') // 原样文本,不当 HTML
    expect(rows[1].querySelector('b')).toBeNull()
    for (const r of rows) expect(r.querySelector('svg')).not.toBeNull()
  })

  it('没有依据的老待办:不画这一行(不出现「依据 · 0 条」)', async () => {
    await fetchMuseTodoStatus('old')
    expect(useMuseTodoEvidence.getState().old).toBeUndefined()
    const host = mount({ tasks: [{ title: 'T', prompt: 'p', todo: 'old' }], todoStatus: { old: 'pending' } })
    expect(toggle(host)).toBeNull()
  })

  it('不走真状态读取的卡(没传 todoStatus)即使库里有同 id 的依据也不画', async () => {
    await fetchMuseTodoStatus('t1')
    expect(toggle(mount({ tasks: [{ title: 'T', prompt: 'p', todo: 't1' }] }))).toBeNull()
    expect(toggle(mount({ tasks: [{ title: 'T', prompt: 'p' }], todoStatus: {} }))).toBeNull()
  })
})
