// @vitest-environment happy-dom
/** 「从其他 AI 导入」审阅单的焦点:打开就进单里、Tab 在单里转、关掉还给打开它的按钮(引导里背后就是「继续」)。 */
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import '../i18n.generated'
import { LocaleProvider, setLocaleGlobal } from '../i18n'

vi.mock('../services/backendService', () => ({
  scanImport: vi.fn(async () => ({ tools: [{ id: 'codex', about: 1, rules: 0, project: 0, notes: 0, skills: 0 }], fresh: 1, freshTools: ['codex'], last: null })),
  getImportPlan: vi.fn(async () => ({ state: 'idle', done: 0, total: 0, plan: null, error: null })),
  startImportPlan: vi.fn(), applyImport: vi.fn(), ignoreImport: vi.fn(), undoImport: vi.fn(),
}))
const { ExternalImportSheet } = await import('./ExternalImport')

let host: HTMLDivElement
let root: Root
const flush = () => act(async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)) })
beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  setLocaleGlobal('zh')
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

function Opener() {
  const [open, setOpen] = useState(false)
  return React.createElement(React.Fragment, null,
    React.createElement('button', { id: 'opener', onClick: () => setOpen(true) }, 'open'),
    React.createElement('button', { id: 'behind' }, 'continue'),
    open && React.createElement(ExternalImportSheet, { engine: { key: 'local', base: 'http://x' } as any, onClose: () => setOpen(false) }))
}

it('focus moves into the sheet, Tab wraps inside it, and closing gives focus back to the opener', async () => {
  await act(async () => root.render(React.createElement(LocaleProvider, { children: React.createElement(Opener) })))
  const opener = document.getElementById('opener') as HTMLButtonElement
  opener.focus()
  await act(async () => opener.click())
  await flush()
  const sheet = document.querySelector<HTMLElement>('.imp-sheet')!
  expect(document.activeElement).toBe(sheet)
  const focusable = [...sheet.querySelectorAll<HTMLElement>('button, input, textarea')].filter((el) => !(el as HTMLButtonElement).disabled)
  expect(focusable.length).toBeGreaterThan(1)
  const last = focusable[focusable.length - 1]
  last.focus()
  await act(async () => { last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })) })
  expect(document.activeElement).toBe(focusable[0])
  await act(async () => { focusable[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })) })
  expect(document.activeElement).toBe(last)
  expect(sheet.contains(document.activeElement)).toBe(true)
  await act(async () => { sheet.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  await flush()
  expect(document.querySelector('.imp-sheet')).toBeNull()
  expect(document.activeElement).toBe(opener)
})
