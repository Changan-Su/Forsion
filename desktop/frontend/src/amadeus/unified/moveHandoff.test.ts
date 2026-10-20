import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { transform } from 'sucrase'
import { fromDisk } from './eol'
vi.mock('../api', () => ({ amadeus: {} }))
import { claimMoveHandoff, hasMoveHandoff, registerMoveHandoff } from './moveHandoff'

const base = '# Note\n\nWords\n\n![](.amadeus/a.png)\n'
const moved = base.replace('](.amadeus/', '](../from/.amadeus/')
let n = 0
function fixture() {
  const root = `vault-${n++}`
  let live = base
  const persisted = vi.fn()
  const handoff = registerMoveHandoff(root, 'pane', 'to/Note.md', base, () => ({ text: live }), persisted)
  return { root, handoff, persisted, set: (text: string) => { live = text }, claim: (disk: string) => claimMoveHandoff(root, 'pane', 'to/Note.md', disk) }
}
afterEach(() => { vi.useRealTimers() })

it('reads edits made during destination I/O at claim time, preserving rewritten references', () => {
  const h = fixture()
  const first = base.replace('Words', 'Words first')
  h.set(first)
  const written = moved.replace('Words', 'Words first')
  h.handoff.acknowledge(first, written)
  h.set(first.replace('first', 'first late'))
  expect(h.claim(written)?.text).toBe(written.replace('first', 'first late'))
})

it('reads the final edit even after the write ack, before the destination mounts', () => {
  const h = fixture()
  h.handoff.acknowledge(base, moved)
  h.set(base.replace('Words', 'Words between editors'))
  expect(h.claim(moved)?.text).toBe(moved.replace('Words', 'Words between editors'))
})

it('persists late edits against the actual destination version, including an undo to the old baseline', () => {
  const h = fixture()
  const first = base.replace('Words', 'Words first')
  h.set(first)
  const written = moved.replace('Words', 'Words first')
  h.handoff.acknowledge(first, written)
  h.set(base) // Undo while the handover write is pending must not look pristine.
  h.handoff.capture()
  expect(h.persisted).toHaveBeenLastCalledWith(moved, written)
  expect(h.claim(written)?.text).toBe(moved)
})

it('keeps external changes on different lines and refuses conflicting changes on the same line', () => {
  const h = fixture()
  h.handoff.acknowledge(base, moved)
  h.set(base.replace('Words', 'Words late'))
  expect(h.claim(moved.replace('# Note', '# External title'))?.text).toBe(moved.replace('# Note', '# External title').replace('Words', 'Words late'))
  const other = fixture()
  other.handoff.acknowledge(base, moved)
  other.set(base.replace('Words', 'Words late'))
  expect(other.claim(moved.replace('Words', 'External words'))?.text).toBeNull()
  expect(other.persisted.mock.calls.at(-1)?.[0]).toContain('Words late')
})

it('does not let stale source cleanup recreate a draft after the destination claimed it', () => {
  const h = fixture()
  h.handoff.acknowledge(base, moved)
  h.claim(moved)
  h.persisted.mockClear()
  h.handoff.capture()
  h.handoff.acknowledge(base, moved)
  expect(h.persisted).not.toHaveBeenCalled()
  expect(h.claim(moved)).toBeNull()
})

it('isolates vault, destination and pane identity, and expires readers while drafts remain', () => {
  vi.useFakeTimers()
  const h = fixture()
  expect(hasMoveHandoff(h.root, 'pane', 'to/Note.md')).toBe(true)
  expect(claimMoveHandoff('other', 'pane', 'to/Note.md', moved)).toBeNull()
  expect(claimMoveHandoff(h.root, 'other-pane', 'to/Note.md', moved)).toBeNull()
  h.set(base.replace('Words', 'Saved draft'))
  h.handoff.capture()
  vi.advanceTimersByTime(5 * 60_000)
  expect(hasMoveHandoff(h.root, 'pane', 'to/Note.md')).toBe(false)
  expect(h.persisted.mock.calls.at(-1)?.[0]).toContain('Saved draft')
})

const page = readFileSync(new URL('./UnifiedPage.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

it('the real handover persistence callback retains an older draft if replacement exceeds quota', () => {
  const stored = new Map<string, string>()
  let quota = false
  const start = page.indexOf('    }, (latest, base) => {', page.indexOf('  const handOver ='))
  const end = page.indexOf('\n    })', start)
  const callback = page.slice(start + '    }, '.length, end) + '\n}'
  const persist = runInNewContext(transform(`let draft = null; const persist = ${callback}; persist`, { transforms: ['typescript'] }).code, {
    vaultRoot: 'vault', movedTo: 'to/Note.md', pipe: { slot: 'pane' },
    stashDraft: (_root: string, path: string, text: string) => { if (!quota) stored.set(path, text) },
    clearDraft: (_root: string, path: string, text: string) => { if (stored.get(path) === text) stored.delete(path) },
  }) as (text: string, base: string) => void
  persist('First late input', 'Disk')
  quota = true
  persist('First late input plus more', 'Disk')
  expect(stored.get('to/Note.md')).toBe('First late input')
})

it('the real draft initializer hides only the draft already inherited by this instance', () => {
  const start = page.indexOf('  const [draft, setDraft] = useState<UnsavedDraft | null>(() => {')
  const end = page.indexOf('\n  const discardDraft', start)
  const initializer = page.slice(start, end) + '\n draft'
  const clearDraft = vi.fn()
  const evaluate = (inheritedMove: boolean, text: string) => runInNewContext(transform(initializer, { transforms: ['typescript'] }).code, {
    inheritedMove, readOnly: false, vaultRoot: 'vault', path: 'to/Note.md', pipe: { slot: 'pane', lastSaved: 'Disk' },
    initial: 'Inherited input', diskRaw: 'Disk', fromDisk,
    readDraft: () => ({ text, base: 'fingerprint', at: 1, slot: 'pane' }), clearDraft,
    useState: (init: () => unknown) => [init(), vi.fn()],
  })
  expect(evaluate(true, 'Inherited input')).toBeNull()
  expect(clearDraft).not.toHaveBeenCalled() // recovery remains durable until CAS acknowledges it
  expect(evaluate(false, 'Inherited input')).toMatchObject({ text: 'Inherited input' })
  expect(evaluate(true, 'Different older draft')).toMatchObject({ text: 'Different older draft' })
})
