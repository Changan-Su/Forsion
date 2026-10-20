// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { DraftCard } from './DraftCard'
import { useCalendarNav, type CalDraft } from '../../amadeus/store/calendarNavStore'
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const h = vi.hoisted(() => ({ resolve: undefined as undefined | ((v: unknown) => void) }))
vi.mock('./eventClipboard', () => ({ useCalendarClipboard: () => ({ event: { db: { path: 'Events.db' } } }), pasteCalendarEvent: () => new Promise((resolve) => { h.resolve = resolve }) }))
vi.mock('./eventActions', () => ({ calendarScope: () => 'scope-A' }))
vi.mock('./EventCard', () => ({ cardPos: () => ({ left: 0, top: 0 }) }))
vi.mock('../../amadeus/store/calendarMembers', () => ({ useCalendarMembers: () => [{ db: { path: 'Events.db', name: 'Events', isNoteView: false }, dateCol: 'date' }] }))
vi.mock('../../amadeus/blocks/database/propertyTypes.builtins', () => ({ CalDateFields: () => null }))
vi.mock('@lcl/engine', async (original) => ({ ...await original<object>(), UI_MODE: 'mobile', useNativeChromeClaim: () => {} }))
let root: ReturnType<typeof createRoot> | undefined
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; useCalendarNav.getState().setDraft(null) })
it('slow paste completion keeps the replacement draft and its new title', async () => {
  document.body.innerHTML = '<div id="test"></div>'
  const host = document.getElementById('test')!
  root = createRoot(host)
  const draft: CalDraft = { day: '2026-10-20', endDay: '2026-10-20', startMin: 600, endMin: 630, title: '', dbPath: 'Events.db' }
  const cancel = vi.fn(() => useCalendarNav.getState().setDraft(null)), selected = vi.fn()
  useCalendarNav.getState().setDraftApi({ commit: () => {}, cancel })
  useCalendarNav.getState().setDraft(draft)
  await act(async () => root!.render(createElement(DraftCard, { rootRef: { current: host }, onPasted: selected })))
  const paste = [...host.querySelectorAll('button')].find((b) => b.textContent === '在此粘贴事件')!
  expect(paste).toBeTruthy()
  await act(async () => paste.click())
  const replacement = { ...draft, startMin: 720, title: 'Keep this new title' }
  await act(async () => useCalendarNav.getState().setDraft(replacement))
  await act(async () => h.resolve?.({ db: { path: 'Events.db' }, id: 'copied' }))
  expect(useCalendarNav.getState().draft).toBe(replacement)
  expect(host.querySelector<HTMLInputElement>('.amx-cal-card-title')?.value).toBe('Keep this new title')
  expect(cancel).not.toHaveBeenCalled()
  expect(selected).not.toHaveBeenCalled()
})
