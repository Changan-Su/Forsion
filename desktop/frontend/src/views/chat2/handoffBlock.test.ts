// @vitest-environment happy-dom
/** 会话互通升级(11-08):hand_off_task 挪出去的会话单独一块、模型不一样的子会话行带模型芯片、树外会话发来的消息多一行说明。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean; React: typeof React }
g.IS_REACT_ACT_ENVIRONMENT = true
g.React = React

vi.mock('../../services/backendService', async (original) => ({
  ...await original<typeof import('../../services/backendService')>(),
  listMessages: vi.fn(async () => []),
}))
const { HandoffBlock, SessionMessageLine } = await import('./ChildSessions')
const { TaskCards } = await import('./TaskCards')
const { useApp } = await import('../../stores/appStore')
await import('../../tangu/store/standalone')
const { translate } = await import('../../i18n')

const roots: Root[] = []
function mount(el: React.ReactElement): HTMLDivElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.push(root)
  act(() => root.render(el))
  return host
}
// 卸掉上一个用例挂的树:下一个用例改 store 时别再去更新它们(act 警告)
afterEach(() => { act(() => { for (const r of roots.splice(0)) r.unmount() }) })

describe('HandoffBlock', () => {
  it('lists the hand-off session with its own head; a chip shows only when the model differs from the opener', () => {
    useApp.setState({
      sessions: [
        { id: 'P', title: 'Release notes', model_id: 'gpt-6-luna' },
        { id: 'H1', title: 'Draft', parent_session_id: 'P', model_id: 'gpt-6-luna' },
        { id: 'H2', title: 'Port check', parent_session_id: 'P', model_id: 'kimi-k3' },
      ] as any,
      modelsResp: { models: [{ id: 'kimi-k3', name: 'Kimi K3' }] } as any,
    })
    const host = mount(createElement(HandoffBlock, { sessionId: 'P', ids: ['H1', 'H2', 'gone'] }))
    const block = host.querySelector('.t2-childs.t2-handoff')!
    expect(block.getAttribute('data-child-sessions')).toBe('2') // 子会话药丸按它找可滚回的块
    expect(block.querySelector('.t2-childs-head b')?.textContent).toBe(translate('handoff.head'))
    const rows = [...block.querySelectorAll('.t2-child-row')]
    expect(rows.map((r) => r.getAttribute('data-child-session'))).toEqual(['H1', 'H2'])
    expect(rows[0].querySelector('.t2-model-chip')).toBeNull()
    expect(rows[1].querySelector('.t2-model-chip')?.textContent).toBe('Kimi K3')
  })
  it('renders nothing when the sessions are gone', () => {
    useApp.setState({ sessions: [] as any })
    expect(mount(createElement(HandoffBlock, { sessionId: 'P', ids: ['H1'] })).innerHTML).toBe('')
  })
})

describe('task card model chip', () => {
  it('shows the model after the title', () => {
    useApp.setState({ sessions: [{ id: 'S1', title: 'p' }] as any, modelsResp: { models: [{ id: 'kimi-k3', name: 'Kimi K3' }] } as any })
    const host = mount(createElement(TaskCards as any, { tasks: [{ title: 'T', prompt: 'p', model: 'kimi-k3' }], ownerId: 'm-model', sessionId: 'S1' }))
    expect(host.querySelector('.t2-taskcard-head .t2-model-chip')?.textContent).toBe('Kimi K3')
  })
})

describe('SessionMessageLine', () => {
  const row = (relation: string) => `<session_message from="s-9" title="Offline sync" relation="${relation}">\nUse port 2222\n</session_message>`
  it('peer: other-session head + the not-from-you note', () => {
    const host = mount(createElement(SessionMessageLine, { content: row('peer') }))
    expect(host.querySelector('.t2-session-msg-head a')?.textContent).toBe(translate('sessmsg.fromPeer', { title: 'Offline sync' }))
    expect(host.querySelector('.t2-session-msg-note')?.textContent).toBe(translate('sessmsg.peerNote'))
  })
  it('other relations keep the old head and no note', () => {
    const host = mount(createElement(SessionMessageLine, { content: row('child') }))
    expect(host.querySelector('.t2-session-msg-head a')?.textContent).toBe(translate('sessmsg.from', { title: 'Offline sync' }))
    expect(host.querySelector('.t2-session-msg-note')).toBeNull()
  })
})
