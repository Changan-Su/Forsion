/**
 * 连续打字期间崩溃不丢字:草稿节拍(typingDraft.ts)+ 组件里那份 typingStash、写成功的 settleUnsaved、挂载时的恢复判断。
 * 后三者从 UnifiedPage.tsx 源码切出来求值(同 writeFailures.test 的做法),草稿走真的 stashDraft / readDraft / clearDraft。
 */
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { transform } from 'sucrase'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { composeFm } from './fm'
import { fromDisk } from './eol'
import { clearDraft, readDraft, stashDraft, type UnsavedDraft } from './writeSafety'
import {
  TYPING_DRAFT_COMPOSE_POLL_MS,
  TYPING_DRAFT_MAX_MS,
  TYPING_DRAFT_MS,
  createTypingDraftPacer,
} from './typingDraft'

beforeEach(() => {
  vi.useFakeTimers()
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size },
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** 每 80ms 一击,打 ms 毫秒(字与字间隔都短于编辑器监听的 200ms 防抖)。 */
function typeFor(ms: number, onKey: () => void): void {
  for (let t = 0; t < ms; t += 80) {
    onKey()
    vi.advanceTimersByTime(80)
  }
}

describe('typing draft pacer (max-wait, not reset by later keystrokes)', () => {
  it('stores a draft at least every 2 seconds while typing never pauses', () => {
    const at: number[] = []
    const start = Date.now()
    const pacer = createTypingDraftPacer({ stash: () => at.push(Date.now() - start), composing: () => false, now: () => Date.now() })
    typeFor(10_000, pacer.edit)
    expect(at.length).toBeGreaterThanOrEqual(4)
    expect(at[0]).toBeLessThanOrEqual(TYPING_DRAFT_MS)
    // 两次草稿之间最多一个间隔 + 一击(到点后的下一击才再起计时)
    for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeLessThanOrEqual(TYPING_DRAFT_MS + 80)
    pacer.dispose()
  })

  it('no edits, no drafts; dispose stops a pending tick', () => {
    const stash = vi.fn()
    const pacer = createTypingDraftPacer({ stash, composing: () => false })
    vi.advanceTimersByTime(10_000)
    expect(stash).not.toHaveBeenCalled()
    pacer.edit()
    pacer.dispose()
    vi.advanceTimersByTime(10_000)
    expect(stash).not.toHaveBeenCalled()
  })

  it('never stores mid-composition; stores right after the composition ends', () => {
    let composing = false
    const at: number[] = []
    const start = Date.now()
    const pacer = createTypingDraftPacer({ stash: () => { expect(composing).toBe(false); at.push(Date.now() - start) }, composing: () => composing, now: () => Date.now() })
    pacer.edit()
    vi.advanceTimersByTime(1500)
    composing = true // 组字横跨到点时刻
    typeFor(2000, pacer.edit)
    expect(at).toEqual([])
    composing = false
    const ended = Date.now() - start
    vi.advanceTimersByTime(TYPING_DRAFT_COMPOSE_POLL_MS)
    expect(at.length).toBe(1)
    expect(at[0] - ended).toBeLessThanOrEqual(TYPING_DRAFT_COMPOSE_POLL_MS)
    pacer.dispose()
  })

  it('widens the interval for slow (large-note) stashes, up to a ceiling', () => {
    let clock = 0
    let cost = 200
    const pacer = createTypingDraftPacer({ stash: () => { clock += cost }, composing: () => false, now: () => clock })
    pacer.edit()
    vi.advanceTimersByTime(TYPING_DRAFT_MS)
    expect(pacer.interval()).toBe(5000)
    cost = 5000
    pacer.edit()
    vi.advanceTimersByTime(5000)
    expect(pacer.interval()).toBe(TYPING_DRAFT_MAX_MS)
    cost = 1
    pacer.edit()
    vi.advanceTimersByTime(TYPING_DRAFT_MAX_MS)
    expect(pacer.interval()).toBe(TYPING_DRAFT_MS)
    pacer.dispose()
  })

  it('a blocked tick (note being moved) stores nothing', () => {
    const stash = vi.fn()
    let blocked = true
    const pacer = createTypingDraftPacer({ stash, composing: () => false, blocked: () => blocked })
    typeFor(3000, pacer.edit)
    expect(stash).not.toHaveBeenCalled()
    blocked = false
    typeFor(3000, pacer.edit)
    expect(stash).toHaveBeenCalled()
    pacer.dispose()
  })
})

// ── 接到组件的那几段(从源码切出来) ──
const source = readFileSync(new URL('./UnifiedPage.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const between = (a: string, b: string): string => {
  const i = source.indexOf(a)
  const j = source.indexOf(b, i)
  if (i < 0 || j < 0) throw new Error(`marker not found: ${i < 0 ? a : b}`)
  return source.slice(i, j)
}
const typingStashSrc = between('    const typingStash = (): void => {', '    const pacer = createTypingDraftPacer(')
const settleSrc = between('  const settleUnsaved = (written?: string): void => {', '  /** 写成功:收掉')
const restoreSrc = between('  const [draft, setDraft] = useState<UnsavedDraft | null>(() => {', '  const discardDraft = ')

const VAULT = '/vault'
const PATH = 'Typing.md'
const DISK = '# Typing\n\nOld paragraph.\n'

function mountPage(disk: string, slot: string | null = null) {
  // 编辑器此刻的 doc(syncFromEditor 把它拉进 pipe.body)。测试里不带 fm:正文就是全文。
  const editor = { body: disk }
  const pipe = {
    readOnly: false, retired: false, dead: false, writing: 0, fm: '', body: disk, lastSaved: disk,
    stashed: null as string | null, slot, failed: false, retryTimer: null as unknown, retryN: 0, pending: false,
  }
  const setSaveFailed = vi.fn()
  const ctx = {
    pipe, vaultRoot: VAULT, path: PATH, composeFm, stashDraft, clearDraft, setSaveFailed, clearTimeout,
    syncFromEditor: () => { pipe.body = editor.body },
    isPristine: () => pipe.body === pipe.lastSaved,
  }
  const fns = runInNewContext(transform(`${settleSrc}\n${typingStashSrc}\n({ settleUnsaved, typingStash })`, { transforms: ['typescript'] }).code, ctx) as {
    settleUnsaved: (written?: string) => void
    typingStash: () => void
  }
  return { pipe, editor, ...fns }
}

/** 重开同一篇:挂载时的恢复判断(只提示不覆盖;草稿 = 盘上就静默删)。 */
function reopen(disk: string, slot: string | null = null): UnsavedDraft | null {
  const code = transform(`${restoreSrc}\ndraft`, { transforms: ['typescript'] }).code
  return runInNewContext(code, {
    useState: (init: () => unknown) => [init(), () => {}],
    readOnly: false, vaultRoot: VAULT, path: PATH, pipe: { slot, lastSaved: disk }, inheritedMove: null,
    initial: disk, diskRaw: disk, fromDisk, readDraft, clearDraft,
    unifiedScopeLive: () => false, hasPageScope: () => false,
  }) as UnsavedDraft | null
}

describe('typing drafts wired into the unified page', () => {
  it('a crash during a long uninterrupted burst loses at most ~2 seconds: reopening offers the draft', () => {
    const h = mountPage(DISK)
    const pacer = createTypingDraftPacer({ stash: h.typingStash, composing: () => false })
    let typed = ''
    const snapshots: Array<{ t: number; text: string }> = []
    const start = Date.now()
    typeFor(7000, () => {
      typed += 'x'
      h.editor.body = DISK + typed
      snapshots.push({ t: Date.now() - start, text: h.editor.body })
      pacer.edit()
    })
    // 崩溃:没有卸载冲洗、没有写盘,盘上还是旧文
    const crashAt = Date.now() - start
    pacer.dispose()
    const offered = reopen(DISK)
    expect(offered).not.toBeNull()
    const savedAt = snapshots.find((s) => s.text === offered!.text)?.t
    expect(savedAt).toBeDefined()
    expect(crashAt - savedAt!).toBeLessThanOrEqual(TYPING_DRAFT_MS + 160)
    expect(offered!.text.length).toBeGreaterThan(DISK.length + 50)
  })

  it('a successful save clears the draft, so reopening is clean', () => {
    const h = mountPage(DISK)
    h.editor.body = DISK + 'typed'
    h.typingStash()
    expect(readDraft(VAULT, PATH)?.text).toBe(DISK + 'typed')
    // 写盘成功(writeNow 里 lastSaved = text 之后 noteWriteOk → settleUnsaved(text))
    h.pipe.lastSaved = DISK + 'typed'
    h.settleUnsaved(DISK + 'typed')
    expect(readDraft(VAULT, PATH)).toBeNull()
    expect(reopen(DISK + 'typed')).toBeNull()
  })

  it('typing back to the saved text clears the draft it stored (no false restore prompt)', () => {
    const h = mountPage(DISK)
    h.editor.body = DISK + 'oops'
    h.typingStash()
    expect(readDraft(VAULT, PATH)).not.toBeNull()
    h.editor.body = DISK // 撤回
    h.typingStash()
    expect(readDraft(VAULT, PATH)).toBeNull()
    expect(reopen(DISK)).toBeNull()
  })

  it('a stash does not touch the save protocol state (pending stays as it was)', () => {
    const h = mountPage(DISK)
    h.editor.body = DISK + 'more'
    h.typingStash()
    expect(h.pipe.pending).toBe(false)
    expect(h.pipe.stashed).toBe(DISK + 'more')
  })

  it('read-only / retired instances never store a draft', () => {
    const h = mountPage(DISK)
    h.editor.body = DISK + 'x'
    h.pipe.retired = true
    h.typingStash()
    h.pipe.retired = false
    h.pipe.readOnly = true
    h.typingStash()
    expect(readDraft(VAULT, PATH)).toBeNull()
  })
})

describe('unmount flush after typing back to nothing (no user edits left)', () => {
  const unmountFlush = between('    const flush = (): void => {\n      syncFromEditor()', '    const onUnload =')
  it('clears the draft the typing pacer stored, so reopening does not offer undone text', () => {
    const h = mountPage(DISK)
    h.editor.body = DISK + 'undone later'
    h.typingStash()
    expect(readDraft(VAULT, PATH)).not.toBeNull()
    // 撤回成只差编辑器规范化(isPristine 为真、但文本 ≠ lastSaved),下一跳之前就关掉
    const pipe = { ...h.pipe, body: DISK + ' ', retired: false, readOnly: false, timer: null }
    const flush = runInNewContext(transform(`${unmountFlush}\nflush`, { transforms: ['typescript'] }).code, {
      pipe, vaultRoot: VAULT, path: PATH, composeFm, stashDraft, clearDraft, clearTimeout,
      syncFromEditor() {}, flushPropDrafts() {}, settleUnsaved() {}, writeNow: vi.fn(), isPristine: () => true,
    }) as () => void
    flush()
    expect(readDraft(VAULT, PATH)).toBeNull()
    expect(reopen(DISK)).toBeNull()
  })
})
