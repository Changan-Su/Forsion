// @vitest-environment happy-dom
/** Component wiring: the controller tests alone cannot catch a stale React file
 * callback, a missing conflict action, or a writable editor on a read-only host. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { StudioEditor } from './StudioEditor'
import { getStudioEditorSession } from './editorSession'

vi.mock('../../components/CodeView', () => ({
  default: ({ value, editable, onChange }: { value: string; editable: boolean; onChange: (value: string) => void }) =>
    createElement('textarea', { 'data-editor-input': true, value, readOnly: !editable, onInput: (e: React.FormEvent<HTMLTextAreaElement>) => onChange(e.currentTarget.value) }),
}))

const globals = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean; React: typeof React }
globals.IS_REACT_ACT_ENVIRONMENT = true
globals.React = React
let host: HTMLDivElement
let root: Root
let sequence = 0
const file = (content: string, mtimeMs = 10) => ({ mimeType: 'text/plain', content: btoa(content), size: content.length, mtimeMs })
const render = async (path: string, onSaved?: (path: string) => void) => {
  await act(async () => { root.render(createElement(StudioEditor, { path, onSaved })) })
}
const edit = async (value: string) => {
  const input = host.querySelector<HTMLTextAreaElement>('[data-editor-input]')!
  await act(async () => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })) })
}
const click = async (label: string) => {
  const button = [...host.querySelectorAll('button')].find((item) => item.textContent === label)!
  expect(button).toBeTruthy()
  await act(async () => { button.click() })
}

beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); sequence++
})
afterEach(async () => {
  await act(async () => { root.unmount() }); host.remove(); vi.unstubAllGlobals()
})

describe('StudioEditor wiring', () => {
  it('retains an in-flight A save when switching to B and notifies with the saved file path', async () => {
    let complete!: (result: { ok: boolean; mtimeMs: number }) => void
    const a = `/component-${sequence}/a.ts`; const b = `/component-${sequence}/b.ts`
    window.tangu = {
      readHostFile: vi.fn(async (path: string) => file(path === a ? 'A' : 'B')),
      writeHostFile: vi.fn(() => new Promise((resolve) => { complete = resolve })),
    } as unknown as NonNullable<Window['tangu']>
    const onSaved = vi.fn()
    await render(a, onSaved); await edit('local A')
    await render(b, onSaved)
    expect(host.querySelector<HTMLTextAreaElement>('[data-editor-input]')?.value).toBe('B')
    await act(async () => { complete({ ok: true, mtimeMs: 20 }) })
    expect(window.tangu.writeHostFile).toHaveBeenCalledWith(a, 'local A', 10)
    expect(onSaved).toHaveBeenCalledWith(a)
    expect(host.querySelector<HTMLTextAreaElement>('[data-editor-input]')?.value).toBe('B')
  })

  it('shows a conflict, loads disk only on request, and exposes the preserved recovery text', async () => {
    const path = `/component-${sequence}/conflict.ts`
    let content = 'base'
    window.tangu = {
      readHostFile: vi.fn(async () => file(content, content === 'base' ? 10 : 20)),
      writeHostFile: vi.fn(async () => ({ conflict: true, mtimeMs: 20 })),
    } as unknown as NonNullable<Window['tangu']>
    await render(path); await edit('my draft'); content = 'external'
    await act(async () => { await getStudioEditorSession(path).flush() })
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('你的编辑已保留')
    expect(host.querySelector<HTMLTextAreaElement>('[data-editor-input]')?.value).toBe('my draft')
    await click('加载磁盘版本')
    expect(host.querySelector<HTMLTextAreaElement>('[data-editor-input]')?.value).toBe('external')
    expect([...host.querySelectorAll('.cs-editor-recovery textarea')].map((v) => (v as HTMLTextAreaElement).value)).toContain('my draft')
    await click('恢复此草稿')
    expect(host.querySelector<HTMLTextAreaElement>('[data-editor-input]')?.value).toBe('my draft')
    expect(host.textContent).toContain('草稿已恢复')
  })

  it('renders without a writable input when the host only supports reads', async () => {
    window.tangu = { readHostFile: async () => file('read only') } as unknown as NonNullable<Window['tangu']>
    await render(`/component-${sequence}/readonly.ts`)
    expect(host.querySelector<HTMLTextAreaElement>('[data-editor-input]')?.readOnly).toBe(true)
    expect(host.textContent).toContain('只读')
  })
})
