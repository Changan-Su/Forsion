// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolEvent } from '../types'
import { LocaleProvider, setLocaleGlobal } from '../i18n'
import { ToolGroup, describeTool } from './ToolGroup'

/** 引擎落库 / 推给渲染层的原句(tangu-agent services/computerHistory.ts 的 COMPUTER_HISTORY_PERSIST_PLACEHOLDER)。 */
const PLACEHOLDER = '[Computer history excerpt: shown to the model for that turn only and not saved. Call read_computer_history again if the details are needed.]'

describe('ToolGroup · read_computer_history', () => {
  let host: HTMLDivElement
  let root: Root
  const done: ToolEvent = { id: 'ch-1', name: 'read_computer_history', arguments: JSON.stringify({ from: '-2h', query: 'invoice' }), result: PLACEHOLDER, done: true }
  const failed: ToolEvent = { id: 'ch-2', name: 'read_computer_history', arguments: '{}', result: 'Computer history is off.', isError: true, done: true }

  beforeEach(() => {
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    setLocaleGlobal('zh')
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    setLocaleGlobal('zh')
  })

  async function renderExpanded(events: ToolEvent[]): Promise<void> {
    await act(async () => root.render(React.createElement(LocaleProvider, { children: React.createElement(ToolGroup, { events }) })))
    await act(async () => host.querySelector<HTMLButtonElement>('.tool-group-head')!.click())
    for (const row of host.querySelectorAll<HTMLButtonElement>('.tool-row-head')) await act(async () => row.click())
  }

  it('成功结果不露引擎的英文占位,换成本地化说明;行头是「读取电脑历史」', async () => {
    await renderExpanded([done])
    const body = host.querySelector('.tool-card-body')!.textContent ?? ''
    expect(body).toContain('电脑历史摘录已交给模型，不会保存在对话记录里。')
    expect(body).not.toContain('Computer history excerpt')
    expect(host.querySelector('.tool-row-verb')?.textContent).toBe('读取电脑历史')
    expect(host.querySelector('.tool-row-target')?.textContent).toBe('invoice')
    expect(describeTool(done).kind).toBe('read') // 摘要归「读取 n 项」,不再是裸工具名 + JSON
  })

  it('英文界面同样换成英文说明', async () => {
    setLocaleGlobal('en')
    await renderExpanded([done])
    const body = host.querySelector('.tool-card-body')!.textContent ?? ''
    expect(body).toContain('The computer history excerpt was passed to the model and isn’t saved in the conversation.')
    expect(body).not.toContain('Call read_computer_history again')
    expect(host.querySelector('.tool-row-verb')?.textContent).toBe('Read computer history')
  })

  it('出错结果照原样显示(那是真原因,不是数据)', async () => {
    await renderExpanded([failed])
    const body = host.querySelector('.tool-card-body')!.textContent ?? ''
    expect(body).toContain('Computer history is off.')
    expect(body).not.toContain('电脑历史摘录已交给模型')
  })
})
