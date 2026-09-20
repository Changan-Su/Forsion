// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import { FeedbackModal } from './FeedbackModal'
import { buildFeedbackReport, FEEDBACK_LOG_LIMIT } from '../services/feedbackReport'

vi.mock('../stores/appStore', () => {
  const useApp = create(() => ({ feedbackDraft: 'A problem to report', setPendingDraft: vi.fn(), toast: vi.fn() }))
  return { useApp }
})
vi.mock('@lcl/engine', () => ({ useWorkspace: { getState: () => ({ openView: vi.fn() }) } }))
vi.mock('../services/feedbackReport', () => ({ buildFeedbackReport: vi.fn(), FEEDBACK_LOG_LIMIT: 5 * 1024 * 1024, FEEDBACK_TEXT_LIMIT: 9000 }))
vi.mock('../i18n', () => ({ registerMessages: () => {}, useI18n: () => ({ t: (key: string) => key }) }))
import { useApp } from '../stores/appStore'

let container: HTMLDivElement, root: Root
const report = { json: '{"evidence":"reviewed"}', bytes: 23, filename: 'feedback.json', missing: [], truncated: false }
const onClose = vi.fn()
const submitFeedback = vi.fn()
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r }); return { promise, resolve } }
const button = (key: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === key)!
async function click(key: string) { await act(async () => { button(key).click() }) }
async function render(session: any = null) {
  await act(async () => root.render(React.createElement(FeedbackModal, { cfg: { backendUrl: 'stub', token: '' } as any, activeSession: session, onClose })))
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.mocked(buildFeedbackReport).mockReset().mockResolvedValue(report)
  submitFeedback.mockReset().mockResolvedValue({ ok: true, id: 'ticket-42' }); onClose.mockReset()
  useApp.setState({ feedbackDraft: 'A problem to report' })
  window.tangu = { submitFeedback, exportActivity: vi.fn() } as any
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); delete window.tangu; vi.unstubAllGlobals() })

it('sends the exact previewed snapshot and leaves success visible until dismissed', async () => {
  await render()
  await click('feedback.preview')
  expect(container.querySelector('pre')?.textContent).toBe(report.json)
  await click('feedback.submit')
  expect(submitFeedback).toHaveBeenCalledWith(expect.objectContaining({ sessionLogJson: report.json }))
  expect(buildFeedbackReport).toHaveBeenCalledTimes(1)
  expect(container.textContent).toContain('feedback.successTitle')
  expect(onClose).not.toHaveBeenCalled()
  expect(useApp.getState().feedbackDraft).toBe('')
})

it('retains the draft on thrown IPC errors and supports retry', async () => {
  submitFeedback.mockRejectedValueOnce(new Error('network'))
  await render(); await click('feedback.submit')
  expect(container.querySelector('[role="alert"]')).toBeTruthy()
  expect(useApp.getState().feedbackDraft).toBe('A problem to report')
  await click('feedback.retry')
  expect(submitFeedback).toHaveBeenCalledTimes(2)
})

it('blocks dismissal and duplicate submissions while a request is in flight', async () => {
  const pending = deferred<any>(); submitFeedback.mockReturnValue(pending.promise)
  await render(); await click('feedback.submit')
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    container.querySelector<HTMLElement>('.feedback-overlay')!.click()
    container.querySelector<HTMLElement>('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
  })
  expect(onClose).not.toHaveBeenCalled()
  expect(submitFeedback).toHaveBeenCalledTimes(1)
  await act(async () => pending.resolve({ ok: true }))
})

it('invalidates a stale attachment as soon as its selection changes', async () => {
  const old = deferred<typeof report>(); const latest = deferred<typeof report>()
  vi.mocked(buildFeedbackReport).mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise)
  await render({ id: 'A', title: 'A' })
  await act(async () => container.querySelectorAll<HTMLInputElement>('input[type=checkbox]')[1].click())
  await act(async () => old.resolve(report))
  expect(button('feedback.submit').disabled).toBe(true)
  await act(async () => latest.resolve({ ...report, json: '{"new":true}' }))
  await render({ id: 'B', title: 'B' })
  await click('feedback.submit')
  expect(submitFeedback.mock.calls[0][0].sessionLogJson).toBe('{"new":true}')
  expect(vi.mocked(buildFeedbackReport).mock.calls[1][1]?.id).toBe('A')
})

it('blocks oversize reports and permits an explicit text-only submission', async () => {
  vi.mocked(buildFeedbackReport).mockResolvedValue({ ...report, bytes: FEEDBACK_LOG_LIMIT + 1 })
  await render()
  expect(button('feedback.submit').disabled).toBe(true)
  expect(container.textContent).toContain('feedback.tooLarge')
  await act(async () => container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click())
  await click('feedback.submit')
  expect(submitFeedback.mock.calls[0][0].sessionLogJson).toBeUndefined()
})

it('exports the report to a file, oversize ones included', async () => {
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:report'), revokeObjectURL = vi.fn()
  vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL, revokeObjectURL }))
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  vi.mocked(buildFeedbackReport).mockResolvedValue({ ...report, bytes: FEEDBACK_LOG_LIMIT + 1 })
  await render()
  await act(async () => button('feedback.export').click())
  expect(createObjectURL.mock.calls[0][0]).toBeInstanceOf(Blob)
  expect(click).toHaveBeenCalledTimes(1)
  click.mockRestore()
})
