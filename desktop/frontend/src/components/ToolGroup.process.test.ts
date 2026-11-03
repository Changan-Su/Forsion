// @vitest-environment happy-dom
// 回答里的过程行(10-17):思考并进第一条工具分组;报用时不报字数;不画完成勾;思考中流光只在 thinking 时出。
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolEvent } from '../types'
import { ToolGroup, describeTool, toolVerb } from './ToolGroup'

describe('ToolGroup as the process line', () => {
  let host: HTMLDivElement
  let root: Root
  const read: ToolEvent = { id: 't1', name: 'read_file', arguments: JSON.stringify({ path: 'a/b.cron' }), done: true, result: 'ok' }
  const run: ToolEvent = { id: 't2', name: 'run_bash', arguments: JSON.stringify({ command: 'npm test' }), done: false }

  beforeEach(() => {
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
  })
  const render = async (props: Parameters<typeof ToolGroup>[0]) => {
    await act(async () => root.render(React.createElement(ToolGroup, props)))
    // 过程行换态时旧行留着放 100ms 退场(RollLine);happy-dom 不放动画,这里替它把退场放完
    await act(async () => { host.querySelectorAll('.tool-roll-item.is-out').forEach((el) => el.dispatchEvent(new Event('animationend', { bubbles: true }))) })
  }
  const head = () => host.querySelector('.tool-group-head') as HTMLButtonElement
  const longSum = () => host.querySelector('.tool-group-sum-long')?.textContent

  it('thinking only: one line with the duration, no char count; history without a duration says 思考过程', async () => {
    await render({ events: [], reasoning: '先看日志', reasoningMs: 8_400 })
    expect(longSum()).toBe('思考 8 秒')
    await render({ events: [], reasoning: '先看日志', reasoningMs: 75_000 })
    expect(longSum()).toBe('思考 1 分 15 秒')
    await render({ events: [], reasoning: '先看日志' })
    expect(longSum()).toBe('思考过程')
    expect(host.textContent).not.toMatch(/字/)
  })

  it('thinking + tools fold into one summary; done shows no check mark, the step list starts with the thought', async () => {
    await render({ events: [read, { ...run, done: true, result: 'ok' }], reasoning: '先看日志', reasoningMs: 3_000 })
    expect(longSum()).toBe('思考 3 秒 · 运行 1 命令 · 读取 1 项')
    expect(host.querySelector('.tool-group-sum-short')?.textContent).toBe('思考 3 秒 · 2 个工具')
    expect(host.querySelector('.tool-group-status svg')).toBeNull()
    await act(async () => head().click())
    const rows = [...host.querySelectorAll('.tool-group-list > .tool-row')]
    expect(rows).toHaveLength(3)
    expect(rows[0].classList.contains('tool-row--think')).toBe(true)
    expect(rows[0].querySelector('.t2-think-body')?.textContent).toBe('先看日志')
  })

  it('a failed call keeps the red cross at the end of the line', async () => {
    await render({ events: [{ ...read, isError: true }], reasoning: 'x' })
    expect(host.querySelector('.tool-group-status svg')).not.toBeNull()
  })

  it('while thinking the line says 思考中 with the shimmer; once a tool runs the line follows the tool', async () => {
    await render({ events: [], reasoning: '想', running: true, thinking: true })
    expect(head().getAttribute('aria-busy')).toBe('true')
    expect(host.querySelector('.tool-group-cur .chat-run-shimmer-text')?.textContent).toBe('思考中')
    await render({ events: [read, run], reasoning: '想', running: true, thinking: false })
    expect(host.querySelector('.tool-group-cur .chat-run-shimmer-text')?.textContent).toMatch(/^运行 npm test/)
    expect(host.querySelector('.tool-group-step')?.textContent).toContain('第 2 步')
    // 停了:不再假装在想
    await render({ events: [], reasoning: '想', running: false, thinking: true })
    expect(head().getAttribute('aria-busy')).toBe('false')
    expect(host.querySelectorAll('.chat-run-shimmer-text')).toHaveLength(0)
  })
  it('unknown tools say something human: MCP name, plugin name, grep as search, first string as target (round 6, 6.4)', async () => {
    const ev = (name: string, args: unknown): ToolEvent => ({ id: name, name, arguments: JSON.stringify(args), done: true, result: 'ok' })
    const tt = (k: string) => k
    const mcp = describeTool(ev('mcp__github__search_issues', { q: 'sheet input radius', limit: 5 }))
    expect([toolVerb(mcp, ev('mcp__github__search_issues', {}), tt), mcp.target]).toEqual(['Github · search issues', 'sheet input radius'])
    const cal = ev('forsion_calendar__find_free_slots', { date: '2026-10-28' })
    const owned = describeTool(cal, (n) => (n === cal.name ? '日历' : undefined))
    expect([toolVerb(owned, cal, tt), owned.target, owned.unowned]).toEqual(['日历 · find free slots', '2026-10-28', false])
    const raw = describeTool(cal, () => undefined)
    expect([toolVerb(raw, cal, tt), raw.unowned]).toEqual(['forsion_calendar__find_free_slots', true]) // 名单里没有:原名,不猜
    expect(describeTool(ev('grep', { pattern: 'amx-sheet-input' }))).toMatchObject({ kind: 'search', target: 'amx-sheet-input' })
    expect(describeTool(ev('x_tool', { n: 3, flag: true })).target).toBe('{"n":3,"flag":true}')
    // 开子会话:收起写「开了 N 个子会话」,展开每步「子会话 + 标题」
    await render({ events: [ev('start_session', { title: '查 Obsidian Sync', message: 'brief' }), { ...ev('start_session', { title: '查 Notion 离线', message: 'b' }), id: 's2' }] })
    expect(longSum()).toBe('开了 2 个子会话')
    expect(host.querySelector('.tool-group-sum-short')?.textContent).toBe('开了 2 个子会话')
    await act(async () => head().click())
    expect([...host.querySelectorAll('.tool-row-copy-text')].map((e) => e.textContent)).toEqual(['子会话查 Obsidian Sync', '子会话查 Notion 离线'])
  })
})
