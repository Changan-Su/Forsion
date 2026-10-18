// @vitest-environment happy-dom
/** 任务卡按钮落点(Codex 10-17 #8/#9/#11):能开子会话才给「开个子会话」,子会话里 / 没本机引擎回落「新会话执行」;
 *  收件箱先问卡有按钮;挂着跨过 7 天,点的那一下不执行、定格成已过期。 */
import { describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean; React: typeof React }
g.IS_REACT_ACT_ENVIRONMENT = true
g.React = React

const { TaskCards, TASK_CARD_TTL_MS } = await import('./TaskCards')
const { useApp } = await import('../../stores/appStore')
const { translate } = await import('../../i18n')

function mount(props: Record<string, unknown>): HTMLDivElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  act(() => createRoot(host).render(createElement(TaskCards as any, { tasks: [{ title: 'T', prompt: 'p' }], ownerId: `m${Math.random()}`, ...props })))
  return host
}
const labels = (host: HTMLElement): string[] => [...host.querySelectorAll('.t2-taskcard-actions button')].map((b) => b.textContent!.trim())

describe('TaskCards 落点', () => {
  ;(window as any).tangu = { backendStatus: () => {} }
  it('主会话给「开个子会话」,子会话里回落「新会话执行」', () => {
    useApp.setState({ sessions: [{ id: 'S1', title: 'p' }, { id: 'S2', title: 'c', parent_session_id: 'S1' }] as any })
    expect(labels(mount({ sessionId: 'S1' }))).toContain(translate('chat.task.child'))
    const kid = labels(mount({ sessionId: 'S2' }))
    expect(kid).not.toContain(translate('chat.task.child'))
    expect(kid).toContain(translate('chat.task.new'))
  })
  it('收件箱先问卡有「新会话」按钮', () => {
    expect(labels(mount({ noHere: true, tasks: [{ title: 'T', prompt: 'p', ask: true }] }))).toEqual([translate('chat.task.askNew')])
  })
  it('挂着跨过 7 天:点了不执行,定格成已过期', async () => {
    const onTask = vi.fn()
    const now = Date.now()
    const host = mount({ sessionId: 'S1', createdAt: now - TASK_CARD_TTL_MS + 1000, onTask })
    vi.spyOn(Date, 'now').mockReturnValue(now + 2000)
    await act(async () => { (host.querySelector('.t2-taskcard-actions button') as HTMLButtonElement).click() })
    expect(onTask).not.toHaveBeenCalled()
    expect(host.querySelector('.t2-taskcard')!.getAttribute('data-task-state')).toBe('expired')
    vi.restoreAllMocks()
  })
})
