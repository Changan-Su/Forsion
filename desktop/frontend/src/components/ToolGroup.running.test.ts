// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolEvent } from '../types'
import { ToolGroup } from './ToolGroup'

describe('ToolGroup running visuals', () => {
  let host: HTMLDivElement
  let root: Root
  const pendingCommand: ToolEvent = {
    id: 'tool-1',
    name: 'run_bash',
    arguments: JSON.stringify({ command: 'npm test' }),
    done: false,
  }

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

  async function render(running: boolean): Promise<void> {
    await act(async () => root.render(React.createElement(ToolGroup, { events: [pendingCommand], running })))
  }

  it('removes every running shimmer and busy state when the parent run is stopped', async () => {
    await render(true)
    expect(host.querySelector('.tool-group-head')?.getAttribute('aria-busy')).toBe('true')
    expect(host.querySelectorAll('.chat-run-shimmer-text')).toHaveLength(1)

    await render(false)
    expect(host.querySelector('.tool-group-head')?.getAttribute('aria-busy')).toBe('false')
    expect(host.querySelectorAll('.chat-run-shimmer-text')).toHaveLength(0)

    await act(async () => { (host.querySelector('.tool-group-head') as HTMLButtonElement).click() })
    expect(host.querySelector('.tool-row-head')?.getAttribute('aria-busy')).toBe('false')
    expect(host.querySelector('.tool-row-copy-text')?.classList.contains('chat-run-shimmer-text')).toBe(false)
  })
})
