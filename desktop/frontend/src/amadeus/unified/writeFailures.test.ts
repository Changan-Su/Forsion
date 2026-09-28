/** Run the production component's write/flush closures without mounting Milkdown. */
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { transform } from 'sucrase'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { composeFm } from './fm'
import { textFingerprint } from '@amadeus-shared/writeConflict'
import { flushUnifiedScopes, registerUnifiedPipe } from './lifecycle'

const source = readFileSync(new URL('./UnifiedPage.tsx', import.meta.url), 'utf8')
const writer = source.slice(source.indexOf('  const writeNow ='), source.indexOf('  /** 从编辑器 doc 派生'))
const registration = source.slice(source.indexOf('    return registerUnifiedPipe({'))
const flushStart = registration.indexOf('      flush: ')
const flushEnd = registration.indexOf('      insertFiles:', flushStart)
const flushProperty = registration.slice(flushStart, flushEnd)
const disposers: Array<() => void> = []
afterEach(() => { while (disposers.length) disposers.pop()!() })

type WriteResult = void | { ok: true } | { ok: false; current: string }
function harness() {
  const pipe = { retired: false, fm: '', body: 'Unsaved note', lastSaved: 'Old note', pending: true, timer: null, chain: Promise.resolve(), unpreserved: null as string | null, writing: 0 }
  const writeTextFile = vi.fn<(path: string, content: string, opts?: { base?: string }) => Promise<WriteResult>>()
  // 写盘安全件(评审 G1-01 / D-03 / D-04)在组件里住在 writeNow 前面,这里注入桩:只验 writeNow 的控制流。
  const safety = {
    preserveExternal: vi.fn<(content: string) => Promise<void>>(async () => {}),
    noteWriteFailed: vi.fn<(error: unknown) => void>(),
    noteWriteOk: vi.fn<() => void>(),
    settleUnsaved: vi.fn<() => void>(),
    isPristine: vi.fn<() => boolean>(() => false),
    reconcileNow: vi.fn<() => void>(),
  }
  const flushPropDrafts = vi.fn<() => void>() // 属性面板草稿冲洗(C-02)
  const script = writer + '\n({ writeNow, handle: { path, ' + flushProperty + ' retire() {} } })'
  const result = runInNewContext(transform(script, { transforms: ['typescript'] }).code, {
    path: 'Note.md', pipe, composeFm, textFingerprint, amadeus: { writeTextFile }, ...safety,
    scoped: { getState: () => ({ bumpLinkGraph: vi.fn() }) },
    syncFromEditor() {}, clearTimeout, flushPropDrafts,
  }) as { writeNow: (strict?: boolean) => Promise<void>; handle: Parameters<typeof registerUnifiedPipe>[0] }
  disposers.push(registerUnifiedPipe(result.handle))
  return { pipe, writeTextFile, flushPropDrafts, ...safety, ...result }
}

describe('unified editor account-switch persistence barrier', () => {
  it('rejects a real file-write failure and preserves the draft for a successful retry', async () => {
    const h = harness()
    h.writeTextFile.mockRejectedValueOnce(new Error('ENOSPC: Disk is full'))
    await expect(flushUnifiedScopes(true)).rejects.toThrow('ENOSPC')
    expect(h.pipe).toMatchObject({ pending: true, body: 'Unsaved note', lastSaved: 'Old note', retired: false })
    h.writeTextFile.mockResolvedValueOnce()
    await flushUnifiedScopes(true)
    expect(h.pipe.pending).toBe(false)
    expect(h.pipe.lastSaved).toBe(composeFm('', 'Unsaved note'))
    expect(h.writeTextFile).toHaveBeenCalledTimes(2)
  })

  it('the barrier commits pending property-panel drafts before writing (C-02)', async () => {
    const h = harness()
    h.flushPropDrafts.mockImplementation(() => { h.pipe.fm = '---\nstatus: typed before quit\n---\n' })
    h.writeTextFile.mockResolvedValue(undefined)
    await flushUnifiedScopes(true)
    expect(h.flushPropDrafts).toHaveBeenCalled()
    expect(h.writeTextFile).toHaveBeenLastCalledWith('Note.md', composeFm('---\nstatus: typed before quit\n---\n', 'Unsaved note'), expect.anything())
  })

  it('retains the existing best-effort behavior of ordinary editor saves', async () => {
    const h = harness()
    h.writeTextFile.mockRejectedValueOnce(new Error('Offline'))
    await expect(h.writeNow()).resolves.toBeUndefined()
    expect(h.pipe.pending).toBe(true)
    expect(h.pipe.lastSaved).toBe('Old note')
  })

  it('strict flush also saves an edit arriving while the first file write is pending', async () => {
    const h = harness()
    h.pipe.pending = false // flush may discover a just-serialized draft before the debounce marks it dirty.
    let finish!: () => void
    h.writeTextFile.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
      .mockResolvedValueOnce()
    const flushing = flushUnifiedScopes(true)
    await Promise.resolve()
    h.pipe.body = 'Newer edit during write'
    finish()
    await flushing
    expect(h.pipe.pending).toBe(false)
    expect(h.pipe.lastSaved).toBe(composeFm('', 'Newer edit during write'))
    expect(h.writeTextFile).toHaveBeenCalledTimes(2)
  })
})

describe('unified editor write safety (review 2026-09-27 D-03 / D-04 / G1-01)', () => {
  it('every write carries the fingerprint of what the editor believes is on disk', async () => {
    const h = harness()
    h.writeTextFile.mockResolvedValueOnce(undefined)
    await h.writeNow()
    expect(h.writeTextFile).toHaveBeenCalledWith('Note.md', composeFm('', 'Unsaved note'), { base: textFingerprint('Old note') })
    expect(h.noteWriteOk).toHaveBeenCalledTimes(1)
  })

  it('a failed ordinary save is reported (toast / unsaved bar / backoff) instead of being swallowed', async () => {
    const h = harness()
    const error = new Error('EACCES: permission denied')
    h.writeTextFile.mockRejectedValueOnce(error)
    await h.writeNow()
    expect(h.noteWriteFailed).toHaveBeenCalledWith(error)
    expect(h.noteWriteOk).not.toHaveBeenCalled()
  })

  it('CAS reject with local edits: the disk version is preserved first, then the local version is written on the new base', async () => {
    const h = harness()
    h.writeTextFile.mockResolvedValueOnce({ ok: false, current: 'Written by another window' }).mockResolvedValueOnce({ ok: true })
    await h.writeNow()
    expect(h.preserveExternal).toHaveBeenCalledWith('Written by another window')
    expect(h.preserveExternal.mock.invocationCallOrder[0]).toBeLessThan(h.writeTextFile.mock.invocationCallOrder[1])
    expect(h.writeTextFile).toHaveBeenLastCalledWith('Note.md', composeFm('', 'Unsaved note'), { base: textFingerprint('Written by another window') })
    expect(h.pipe).toMatchObject({ pending: false, lastSaved: composeFm('', 'Unsaved note'), unpreserved: null })
  })

  it('never overwrites the disk version when its conflict copy cannot be written', async () => {
    const h = harness()
    h.writeTextFile.mockResolvedValueOnce({ ok: false, current: 'Theirs' })
    h.preserveExternal.mockRejectedValueOnce(new Error('ENOSPC'))
    await h.writeNow()
    expect(h.writeTextFile).toHaveBeenCalledTimes(1) // only the rejected CAS attempt — no overwrite
    expect(h.noteWriteFailed).toHaveBeenCalled()
    expect(h.pipe).toMatchObject({ pending: true, unpreserved: 'Theirs', lastSaved: 'Theirs' })
  })

  it('CAS reject without user edits (only editor normalization) yields to the disk version: no write, no copy', async () => {
    const h = harness()
    h.isPristine.mockReturnValue(true)
    h.writeTextFile.mockResolvedValueOnce({ ok: false, current: 'Newer on disk' })
    await h.writeNow()
    expect(h.writeTextFile).toHaveBeenCalledTimes(1)
    expect(h.preserveExternal).not.toHaveBeenCalled()
    expect(h.reconcileNow).toHaveBeenCalledTimes(1)
    expect(h.pipe.pending).toBe(false)
  })

  it('a failed save the user undid back to the disk version settles the unsaved state (bar / stale draft) without writing', async () => {
    const h = harness()
    h.writeTextFile.mockRejectedValueOnce(new Error('Offline'))
    await h.writeNow()
    expect(h.noteWriteFailed).toHaveBeenCalledTimes(1)
    h.pipe.body = h.pipe.lastSaved // backspaced the unsaved words away: local == disk again
    await h.writeNow() // retry timer / online / focus kick
    expect(h.writeTextFile).toHaveBeenCalledTimes(1)
    expect(h.settleUnsaved).toHaveBeenCalledTimes(1)
    expect(h.noteWriteOk).not.toHaveBeenCalled() // nothing was written: no peer announcement
    expect(h.pipe.pending).toBe(false)
  })

  it('a strict barrier rejects when the disk keeps changing under it, instead of spinning out conflict copies', async () => {
    const h = harness()
    let n = 0
    h.writeTextFile.mockImplementation(async () => ({ ok: false, current: `Someone else ${++n}` }))
    await expect(flushUnifiedScopes(true)).rejects.toThrow(/kept changing/)
    expect(h.writeTextFile).toHaveBeenCalledTimes(4)
    expect(h.pipe.pending).toBe(true)
    expect(h.pipe.writing).toBe(0)
  })

  // 返修 R1:卸载冲洗 / schedule 的「本地 = lastSaved」同步出口只在 pipe.writing === 0 时作数 —— 计数必须覆盖
  // 一轮写的全程(compose 之后、保全副本那段 await 也算),且每条出口(成功 / 失败 / CAS 让位 / 严格抛错)都归零。
  it('pipe.writing covers the whole write round and returns to zero on every exit', async () => {
    const h = harness()
    let finish!: (v: WriteResult) => void
    h.writeTextFile.mockImplementationOnce(() => new Promise<WriteResult>((resolve) => { finish = resolve }))
    const writing = h.writeNow()
    await Promise.resolve()
    await Promise.resolve()
    expect(h.pipe.writing).toBe(1) // ack 还没回:lastSaved 仍是旧基线,但马上会变
    expect(h.pipe.lastSaved).toBe('Old note')
    finish(undefined)
    await writing
    expect(h.pipe.writing).toBe(0)
    expect(h.noteWriteOk).toHaveBeenCalledWith(composeFm('', 'Unsaved note')) // 写下的内容交给草稿覆盖判定

    let release!: () => void
    h.pipe.body = 'Second edit'
    h.writeTextFile.mockResolvedValueOnce({ ok: false, current: 'Theirs' }).mockResolvedValueOnce({ ok: true })
    h.preserveExternal.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
    const preserving = h.writeNow()
    await vi.waitFor(() => expect(h.preserveExternal).toHaveBeenCalled())
    expect(h.pipe.writing).toBe(1) // 保全副本那段 await:lastSaved 已换成盘上现文,本轮写完又会换
    release()
    await preserving
    expect(h.pipe.writing).toBe(0)

    h.pipe.body = 'Third edit'
    h.writeTextFile.mockRejectedValueOnce(new Error('Offline'))
    await h.writeNow()
    expect(h.pipe.writing).toBe(0)
    h.writeTextFile.mockRejectedValueOnce(new Error('ENOSPC'))
    await expect(h.writeNow(true)).rejects.toThrow('ENOSPC')
    expect(h.pipe.writing).toBe(0)
    h.isPristine.mockReturnValueOnce(true)
    h.writeTextFile.mockResolvedValueOnce({ ok: false, current: 'Newer on disk' })
    await h.writeNow()
    expect(h.pipe.writing).toBe(0)
  })
})

// 收口 N-5:退休实例(改名 / 删除 / 移动之后)的路径已不归它 —— writeNow 对它一个字都不写,这时存草稿就是旧路径上
// 一份永不删除的孤儿,之后同名位置出现新笔记会误弹「恢复草稿」。卸载冲洗与写失败两个存草稿的口子都要看 retired。
// 真浏览器版:check:unifiedcas F11(改名 IPC 窗口里打字)。
describe('retired instances never leave drafts behind (N-5)', () => {
  const unmountFlush = source.slice(source.indexOf('    const flush = (): void => {\n      syncFromEditor()'), source.indexOf('    const onUnload ='))
  const noteFailed = source.slice(source.indexOf('  const noteWriteFailed = '), source.indexOf('  /** 本地与盘上重新一致'))
  function load() {
    const pipe = { retired: true, readOnly: false, fm: '', body: 'Typed during the rename IPC window', lastSaved: 'Old note', pending: true, timer: null as unknown, writing: 0, stashed: null as string | null, failed: false, retryTimer: null as unknown, retryN: 0, dead: false }
    const stubs = {
      stashDraft: vi.fn(), clearDraft: vi.fn(), writeNow: vi.fn(async () => {}), settleUnsaved: vi.fn(), isPristine: vi.fn(() => false),
      setSaveFailed: vi.fn(), toastSaveFailed: vi.fn(),
    }
    const fns = runInNewContext(transform(`${unmountFlush}\n${noteFailed}\n({ flush, noteWriteFailed })`, { transforms: ['typescript'] }).code, {
      pipe, path: 'Untitled.md', vaultRoot: '/vault', composeFm, syncFromEditor() {}, flushPropDrafts() {}, clearTimeout, setTimeout, SAVE_RETRY_MS: [2000], ...stubs,
    }) as { flush: () => void; noteWriteFailed: (e: unknown) => void }
    return { pipe, ...stubs, ...fns }
  }

  it('unmount flush of a retired instance stores no draft, writes nothing, and clears the draft it stashed earlier', () => {
    const h = load()
    h.pipe.stashed = 'Stashed after an earlier failed save'
    h.flush()
    expect(h.stashDraft).not.toHaveBeenCalled()
    expect(h.writeNow).not.toHaveBeenCalled()
    expect(h.clearDraft).toHaveBeenCalledWith('/vault', 'Untitled.md', 'Stashed after an earlier failed save')
    expect(h.pipe.stashed).toBeNull()
  })

  it('a save that fails after retirement still reports the failure but stores no draft at the old path', () => {
    const h = load()
    h.noteWriteFailed(new Error('ENOENT'))
    expect(h.stashDraft).not.toHaveBeenCalled()
    expect(h.toastSaveFailed).toHaveBeenCalledTimes(1)
  })

  it('control: a live instance still stashes its unsaved text on unmount and on a failed save', () => {
    const h = load()
    h.pipe.retired = false
    h.flush()
    expect(h.stashDraft).toHaveBeenCalledWith('/vault', 'Untitled.md', composeFm('', 'Typed during the rename IPC window'), 'Old note')
    expect(h.writeNow).toHaveBeenCalledTimes(1)
    h.noteWriteFailed(new Error('Offline'))
    expect(h.stashDraft).toHaveBeenCalledTimes(2)
  })
})
