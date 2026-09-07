// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { StudioBrief } from './projectBrief'

const { state, saveFile } = vi.hoisted(() => ({
  state: { activeProject: '/projects/a', projects: {} as Record<string, { brief: StudioBrief }>, updateProject: vi.fn() },
  saveFile: vi.fn(),
}))
vi.mock('./briefFile', () => ({ saveStudioBriefFile: saveFile }))
vi.mock('../../stores/appStore', () => ({ useApp: { getState: () => ({}) } }))
vi.mock('../../stores/codeStudioStore', () => ({ useCodeStudio: Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state }) }))
import { BriefPanel } from './StudioPanels'

const globals = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean; React: typeof React }
globals.IS_REACT_ACT_ENVIRONMENT = true; globals.React = React
let host: HTMLDivElement
let root: Root
const brief: StudioBrief = { idea: 'An offline notes app', audience: 'Students', constraints: 'No account', capabilities: [], locale: 'zh' }
const deferred = () => {
  let resolve!: () => void; let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
beforeEach(() => {
  saveFile.mockReset(); state.updateProject.mockReset(); state.activeProject = '/projects/a'; state.projects = { '/projects/a': { brief: { ...brief } } }
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => { root.unmount() }); host.remove() })

describe('BriefPanel save-before-prompt sequencing', () => {
  it('waits for a confirmed disk save, prevents same-frame duplicate submissions, then queues the saved snapshot once', async () => {
    const pending = deferred(); saveFile.mockReturnValue(pending.promise)
    const onPrompt = vi.fn()
    await act(async () => { root.render(createElement(BriefPanel, { root: '/projects/a', onPrompt })) })
    const build = host.querySelector<HTMLButtonElement>('.csu-primary')!
    await act(async () => { build.click(); build.click() })
    expect(saveFile).toHaveBeenCalledTimes(1)
    expect(onPrompt).not.toHaveBeenCalled(); expect(state.updateProject).not.toHaveBeenCalled()
    expect([...host.querySelectorAll('button,textarea')].every(item => (item as HTMLButtonElement).disabled)).toBe(true)
    await act(async () => { pending.resolve() })
    expect(state.updateProject).toHaveBeenCalledWith({ brief })
    expect(onPrompt).toHaveBeenCalledTimes(1)
    expect(onPrompt).toHaveBeenCalledWith(expect.stringContaining(brief.idea), false)
    expect(onPrompt.mock.calls[0][0]).toContain('请先阅读已保存的 FORSION_BRIEF.md')
    expect(onPrompt.mock.calls[0][0]).not.toContain('Working agreement')
    expect(saveFile.mock.invocationCallOrder[0]).toBeLessThan(state.updateProject.mock.invocationCallOrder[0])
    expect(state.updateProject.mock.invocationCallOrder[0]).toBeLessThan(onPrompt.mock.invocationCallOrder[0])
  })

  it('keeps the form and shows failure without changing project preferences or queuing a prompt, then allows retry', async () => {
    saveFile.mockRejectedValueOnce(new Error('Disk conflict')).mockResolvedValue(undefined)
    const onPrompt = vi.fn()
    await act(async () => { root.render(createElement(BriefPanel, { root: '/projects/a', onPrompt })) })
    const build = host.querySelector<HTMLButtonElement>('.csu-primary')!
    await act(async () => { build.click() })
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Disk conflict')
    expect(host.querySelector('textarea')?.value).toBe(brief.idea)
    expect(state.updateProject).not.toHaveBeenCalled(); expect(onPrompt).not.toHaveBeenCalled()
    expect(build.disabled).toBe(false)
    await act(async () => { build.click() })
    expect(saveFile).toHaveBeenCalledTimes(2)
    expect(state.updateProject).toHaveBeenCalledTimes(1); expect(onPrompt).toHaveBeenCalledTimes(1)
  })

  it('does not submit an old project prompt or update a new project after the panel was closed', async () => {
    const pending = deferred(); saveFile.mockReturnValue(pending.promise)
    const onPrompt = vi.fn()
    await act(async () => { root.render(createElement(BriefPanel, { root: '/projects/a', onPrompt })) })
    await act(async () => { host.querySelector<HTMLButtonElement>('.csu-primary')!.click() })
    await act(async () => { root.render(null) }); state.activeProject = '/projects/b'
    await act(async () => { pending.resolve() })
    expect(state.updateProject).not.toHaveBeenCalled(); expect(onPrompt).not.toHaveBeenCalled()
  })

  it('saving alone updates preferences after success without preparing an AI task', async () => {
    saveFile.mockResolvedValue(undefined)
    const onPrompt = vi.fn()
    await act(async () => { root.render(createElement(BriefPanel, { root: '/projects/a', onPrompt })) })
    // The first action is the explicit save button; no dependence on localized copy.
    await act(async () => { host.querySelector<HTMLButtonElement>('.csu-actions button')!.click() })
    expect(saveFile).toHaveBeenCalledTimes(1); expect(state.updateProject).toHaveBeenCalledTimes(1)
    expect(onPrompt).not.toHaveBeenCalled()
  })
})
