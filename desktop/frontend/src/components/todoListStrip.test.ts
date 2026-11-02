// 任务清单折叠条的状态词:同一 run 被 steer 切成几段时,旧段已 done 而 run 还在跑 ——
// 那几份旧快照不许说「已停止」;只有清单所在那段真被打断 / 出错,才说「已停止」。
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TodoList } from './InquiryCard'
import type { TodoItem } from '../../../../tangu-agent/src/contracts/clientTypes'
import type { UiMessage } from '../types'

const todos = (...s: TodoItem['status'][]): TodoItem[] => s.map((status, i) => ({ content: `step ${i + 1}`, status }))
// 与 EditorialMessage / ChatView 传给 TodoList 的口径一致
const strip = (m: Pick<UiMessage, 'status' | 'todos'>, running: boolean): string => renderToStaticMarkup(React.createElement(TodoList, {
  todos: m.todos!, folded: true,
  live: m.status === 'streaming' && running,
  stopped: m.status === 'stopped' || m.status === 'error',
}))

describe('TodoList 折叠条 × 同一 run 的多份快照', () => {
  it('run 还在跑:前两份(段已 done)不报「已停止」,最新那份「正在」', () => {
    const segs: Array<Pick<UiMessage, 'status' | 'todos'>> = [
      { status: 'done', todos: todos('in_progress', 'pending', 'pending') },
      { status: 'done', todos: todos('completed', 'in_progress', 'pending') },
      { status: 'streaming', todos: todos('completed', 'completed', 'in_progress') },
    ]
    const [a, b, c] = segs.map((m) => strip(m, true))
    for (const h of [a, b]) expect(h).not.toContain('已停止')
    expect(a).toContain('step 1')
    expect(b).toContain('step 2')
    expect(c).toContain('正在')
  })

  it('run 正常收尾:旧快照照样不报「已停止」,最新那份全部完成', () => {
    expect(strip({ status: 'done', todos: todos('completed', 'in_progress', 'pending') }, false)).not.toContain('已停止')
    expect(strip({ status: 'done', todos: todos('completed', 'completed', 'completed') }, false)).toContain('全部完成')
  })

  it('负对照:run 真被打断 / 出错,最后那份仍报「已停止」', () => {
    expect(strip({ status: 'stopped', todos: todos('completed', 'in_progress', 'pending') }, false)).toContain('已停止 · step 2')
    expect(strip({ status: 'error', todos: todos('in_progress', 'pending') }, false)).toContain('已停止 · step 1')
  })
})
