// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolEvent } from '../types'
import { LocaleProvider, setLocaleGlobal } from '../i18n'
import { ToolGroup } from './ToolGroup'
import { computerUseUnavailableText } from '../../../../tangu-agent/src/contracts/agentEngine'

/** 交给外部引擎的电脑控制没跑:工具桥回给模型的英文原话(同一份契约),这一行按界面语言写原因。 */
describe('ToolGroup · 交给引擎的电脑控制没跑', () => {
  let host: HTMLDivElement
  let root: Root
  const noImage: ToolEvent = { id: 'cu-1', name: 'cu_click', arguments: '{}', result: computerUseUnavailableText('no-image-input'), isError: true, done: true }
  const unknown: ToolEvent = { id: 'cu-2', name: 'cu_click', arguments: '{}', result: computerUseUnavailableText('unknown'), isError: true, done: true }
  const other: ToolEvent = { id: 'cu-3', name: 'cu_click', arguments: '{}', result: 'Error: the window went away', isError: true, done: true }

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

  async function bodyOf(events: ToolEvent[]): Promise<string> {
    await act(async () => root.render(React.createElement(LocaleProvider, { children: React.createElement(ToolGroup, { events }) })))
    await act(async () => host.querySelector<HTMLButtonElement>('.tool-group-head')!.click())
    for (const row of host.querySelectorAll<HTMLButtonElement>('.tool-row-head')) await act(async () => row.click())
    return [...host.querySelectorAll('.tool-card-body')].map((b) => b.textContent ?? '').join('\n')
  }

  it('中文界面:两种原因各写一句中文,不露英文原话;别的错误照原样', async () => {
    const body = await bodyOf([noImage, unknown, other])
    expect(body).toContain('这个 Agent 现在用的模型看不见图')
    expect(body).toContain('没能确认这个 Agent 现在用的模型能看图')
    expect(body).not.toContain('Computer control (looking at the screen')
    expect(body).toContain('Error: the window went away')
  })

  it('英文界面写英文说明', async () => {
    setLocaleGlobal('en')
    const body = await bodyOf([noImage])
    expect(body).toContain('Not run: the model this agent is using can’t see images')
  })
})
