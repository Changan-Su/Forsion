import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { miniSessionState, type MiniSessionEntry } from './miniSessionState'

const dirs: string[] = []
const file = () => { const dir = mkdtempSync(join(tmpdir(), 'mini-session-test-')); dirs.push(dir); return join(dir, 'session.json') }
const entry: MiniSessionEntry = { target: { spaceId: 'calendar' }, bounds: { x: 100, y: 50, width: 320, height: 420 }, visible: true, pinned: false }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks() })

it('round-trips duplicate windows, independent bounds, visibility and pin state', () => {
  const path = file(), state = miniSessionState(path)
  expect(state.read()).toEqual([])
  const entries = [entry, { ...entry, bounds: { ...entry.bounds, x: 500 }, visible: false }]
  state.write(entries)
  expect(miniSessionState(path).read()).toEqual(entries)
})

it('never overwrites unread or malformed state', () => {
  const path = file()
  writeFileSync(path, '{broken')
  const state = miniSessionState(path)
  state.write([])
  vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(state.read()).toEqual([])
  state.write([])
  expect(readFileSync(path, 'utf8')).toBe('{broken')
})

it('excludes voice calls and caps ordinary restored windows', () => {
  const path = file()
  writeFileSync(path, JSON.stringify([{ ...entry, target: { view: { type: 'voice-call' } } }, ...Array(9).fill(entry)]))
  expect(miniSessionState(path).read()).toHaveLength(6)
})
