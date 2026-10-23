// @vitest-environment happy-dom
// 待办清单的「进行中」只在 run 还活着时转圈:停了 / 出错后停在进行中的那项是静态的点(用户 10-23 报「任务停了还在转」)。
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import '../i18n.generated'
import { TodoList } from './InquiryCard'

const todos = [
  { content: 'a', status: 'completed' as const },
  { content: 'b', status: 'in_progress' as const },
  { content: 'c', status: 'pending' as const },
]

it('spins only while live', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div')
  const root = createRoot(host)
  await act(async () => root.render(React.createElement(TodoList, { todos, live: true })))
  expect(host.querySelectorAll('.spin').length).toBe(1)
  await act(async () => root.render(React.createElement(TodoList, { todos })))
  expect(host.querySelectorAll('.spin').length).toBe(0)
  expect(host.querySelector('.todo-mark.in_progress svg')).not.toBeNull()
  await act(async () => root.unmount())
  vi.unstubAllGlobals()
})
