/** 两台设备 / 两个实例改了同一篇的**不同段落**时,v4 编辑器先试三方合并,合不拢才落冲突副本(2026-11-14)。
 *  两个入口:writeNow 的 CAS 拒写(入口 1)与外部回灌的「本地有未落盘编辑」分支(入口 2)。
 *  与 writeFailures.test 同一手法:把生产组件里这几段源码切出来,注入桩单独求值(不挂 Milkdown);
 *  编辑器只剩一个 applyBody 桩,合并本身(mergeUnsavedEdits)用真的。真浏览器版:check:unifiedcas 的 C1m / Dm 组。 */
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { transform } from 'sucrase'
import { describe, expect, it, vi } from 'vitest'
import { canvasLineOf, composeFm, layoutLineOf, splitFm } from './fm'
import { fromDisk, toDisk } from './eol'
import { textFingerprint } from '@amadeus-shared/writeConflict'
import * as writeSafety from './writeSafety'

const source = readFileSync(new URL('./UnifiedPage.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const between = (from: string, to: string): string => {
  const a = source.indexOf(from)
  if (a < 0) return ''
  return source.slice(a, source.indexOf(to, a))
}
const writer = between('  const writeNow =', '  /** 从编辑器 doc 派生')
const merger = between('  const mergeIntoEditor =', '  /** 挪动 IPC 落定后放手')
const reconciler = between('    const reconcile = async (): Promise<void> => {', '    reconcileRef.current = () => { void reconcile() }')
const listener = between('  const onEditorChange =', '  // 源码模式草稿')

const BASE = '# T\n\npara1 AAA\n\npara2 BBB\n\npara3 CCC\n'
const OURS = BASE.replace('para3 CCC', 'para3 CCC local')
const THEIRS = BASE.replace('para1 AAA', 'para1 AAA remote')
const MERGED = OURS.replace('para1 AAA', 'para1 AAA remote')
const SAME_LINE = BASE.replace('para3 CCC', 'para3 CCC remote') // 与 OURS 改的是同一行:合不拢

type WriteResult = void | { ok: true } | { ok: false; current: string | null }
function harness(opts: { body?: string; disk?: string } = {}) {
  const pipe = {
    retired: false, dead: false, readOnly: false, fm: '', body: opts.body ?? OURS, lastSaved: BASE, eol: '\n' as '\n' | '\r\n',
    pending: true, timer: null, chain: Promise.resolve(), unpreserved: null as string | null, writing: 0, reconcileBusy: 0,
    peerPatch: null as Record<string, unknown> | null, ownedCards: new Set<string>(['stale']), held: 0,
    foreignBase: false as boolean | undefined, listenerStale: false as boolean | undefined,
  }
  let disk = opts.disk ?? THEIRS
  const writeTextFile = vi.fn<(path: string, content: string, o?: { base?: string }) => Promise<WriteResult>>(async (_p, content, o) => {
    if (o?.base != null && textFingerprint(disk) !== o.base) return { ok: false, current: disk }
    disk = content
    return { ok: true }
  })
  const readTextFile = vi.fn(async () => disk)
  const applyBody = vi.fn<(body: string, agent?: boolean) => boolean>(() => true)
  // 编辑器此刻的 doc 序列化(冲洗 / 合并后取「此刻」用):桩里就是 pipe.body —— 合并后它就是编辑器里的内容。
  const serializeNow = vi.fn(() => pipe.body)
  const hostApi = { current: { applyBody, serializeNow } as { applyBody: typeof applyBody; serializeNow: typeof serializeNow } | null }
  const stubs = {
    preserveExternal: vi.fn<(content: string) => Promise<void>>(async () => {}),
    noteWriteFailed: vi.fn<(error: unknown) => void>(),
    noteWriteOk: vi.fn<() => void>(),
    settleUnsaved: vi.fn<() => void>(),
    isPristine: vi.fn<() => boolean>(() => false),
    isComposing: vi.fn<() => boolean>(() => false),
    claimAgentWrite: vi.fn<(abs: string, text: string) => boolean>(() => false),
    toastMergedRemote: vi.fn<(path: string, agent?: boolean) => void>(),
    setFmVer: vi.fn(),
    setEditorKey: vi.fn(),
    syncSrcDraft: vi.fn(),
    rescueGone: vi.fn(async () => {}),
  }
  const holder: { reconcile?: () => Promise<void> } = {}
  const reconcileNow = vi.fn(() => { void holder.reconcile?.() })
  const script = `${merger}\n${writer}\n${reconciler}\n${listener}\n({ writeNow, reconcile, onEditorChange: typeof onEditorChange === 'undefined' ? (s) => { pipe.body = s; schedule() } : onEditorChange })`
  const api = runInNewContext(transform(script, { transforms: ['typescript'] }).code, {
    path: 'Note.md', agentAbsPath: '/vault/Note.md', pipe, amadeus: { writeTextFile, readTextFile },
    composeFm, splitFm, layoutLineOf, canvasLineOf, textFingerprint, fromDisk, toDisk,
    mergeUnsavedEdits: writeSafety.mergeUnsavedEdits,
    hostApi, srcRef: { current: false }, hostRaw: { current: null }, reconcileRef: { current: reconcileNow },
    reconcileNow, awaitTypingQuiet: async () => {}, syncFromEditor() {}, deriveFmFromDoc() {},
    schedule() { if (composeFm(pipe.fm, pipe.body) !== pipe.lastSaved) pipe.pending = true },
    scoped: { getState: () => ({ bumpLinkGraph: vi.fn() }) }, ...stubs,
  }) as { writeNow: (strict?: boolean) => Promise<void>; reconcile: () => Promise<void>; onEditorChange: (stored: string) => void }
  holder.reconcile = api.reconcile
  return { pipe, writeTextFile, readTextFile, applyBody, hostApi, reconcileNow, disk: () => disk, setDisk: (t: string) => { disk = t }, ...stubs, ...api }
}

describe('entry 1: CAS reject with unsaved edits in another paragraph', () => {
  it('merges instead of keeping a conflict copy, including a keystroke that landed during the rejected write', async () => {
    const h = harness()
    const late = MERGED.replace('para3 CCC local', 'para3 CCC local typed-late')
    h.writeTextFile.mockImplementationOnce(async () => {
      h.pipe.body = OURS.replace('para3 CCC local', 'para3 CCC local typed-late') // 写在路上时又打了几个字
      return { ok: false, current: THEIRS }
    })
    await h.writeNow()
    expect(h.preserveExternal).not.toHaveBeenCalled() // 没有冲突副本
    expect(h.applyBody).toHaveBeenCalledWith(late, false) // 编辑器里换成合并结果(含迟到的字与别处那段)
    expect(h.writeTextFile).toHaveBeenCalledTimes(2)
    expect(h.writeTextFile.mock.calls[1]).toEqual(['Note.md', late, { base: textFingerprint(THEIRS) }]) // CAS 对着盘上那版
    expect(h.disk()).toBe(late)
    expect(h.pipe).toMatchObject({ pending: false, unpreserved: null, lastSaved: late, body: late })
    expect(h.toastMergedRemote).toHaveBeenCalledWith('Note.md', false)
  })

  it('CRLF note: merged text goes out in CRLF and the CAS base is the fingerprint of the disk bytes', async () => {
    const crlf = (s: string) => s.replace(/\n/g, '\r\n')
    const h = harness({ disk: crlf(THEIRS) })
    h.pipe.eol = '\r\n'
    await h.writeNow()
    expect(h.preserveExternal).not.toHaveBeenCalled()
    expect(h.writeTextFile.mock.calls[1]).toEqual(['Note.md', crlf(MERGED), { base: textFingerprint(crlf(THEIRS)) }])
    expect(h.pipe.lastSaved).toBe(MERGED)
  })

  it('control: edits on the same line still keep local + conflict copy (today\'s behavior)', async () => {
    const h = harness({ disk: SAME_LINE })
    await h.writeNow()
    expect(h.applyBody).not.toHaveBeenCalled()
    expect(h.preserveExternal).toHaveBeenCalledWith(SAME_LINE)
    expect(h.writeTextFile.mock.calls[1]).toEqual(['Note.md', OURS, { base: textFingerprint(SAME_LINE) }])
    expect(h.toastMergedRemote).not.toHaveBeenCalled()
  })

  it('editor not mounted (source mode / unmount flush): falls back to the conflict copy', async () => {
    const h = harness()
    h.hostApi.current = null
    await h.writeNow()
    expect(h.preserveExternal).toHaveBeenCalledWith(THEIRS)
    expect(h.disk()).toBe(OURS)
  })

  it('the editor refuses the merged body: fm is restored and the conflict copy path runs', async () => {
    const h = harness()
    h.applyBody.mockReturnValueOnce(false)
    await h.writeNow()
    expect(h.preserveExternal).toHaveBeenCalledWith(THEIRS)
    expect(h.pipe.ownedCards.has('stale')).toBe(true) // 归属集合不被白白清掉
    expect(h.disk()).toBe(OURS)
  })

  it('IME composing: no transaction into the editor now; the merge is handed to reconcile, which waits for quiet', async () => {
    const h = harness()
    h.isComposing.mockReturnValueOnce(true)
    await h.writeNow()
    expect(h.preserveExternal).not.toHaveBeenCalled()
    expect(h.reconcileNow).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(h.writeTextFile).toHaveBeenCalledTimes(2))
    await h.pipe.chain
    expect(h.applyBody).toHaveBeenCalledTimes(1)
    expect(h.disk()).toBe(MERGED)
    expect(h.preserveExternal).not.toHaveBeenCalled()
  })

  it('IME composing during a strict flush: cannot defer, so it keeps the conflict copy', async () => {
    const h = harness()
    h.isComposing.mockReturnValue(true)
    await h.writeNow(true)
    expect(h.applyBody).not.toHaveBeenCalled()
    expect(h.preserveExternal).toHaveBeenCalledWith(THEIRS)
    expect(h.disk()).toBe(OURS)
  })

  it('after a local-wins round in the same save, a second reject does not merge against the force-moved base', async () => {
    const h = harness({ disk: SAME_LINE })
    const second = SAME_LINE.replace('para1 AAA', 'para1 AAA again')
    h.preserveExternal.mockImplementationOnce(async () => { h.setDisk(second) }) // 保全副本的那段 await 里又被别处写了
    await h.writeNow()
    expect(h.applyBody).not.toHaveBeenCalled()
    expect(h.preserveExternal.mock.calls.map(([c]) => c)).toEqual([SAME_LINE, second])
    expect(h.disk()).toBe(OURS)
  })

  // Codex 复核 P0:合并的事务不进撤销栈,Milkdown 监听器排着的回调手里是合并前最后一击的 doc(这里 = OURS)。
  it('a debounced editor callback queued before the merge cannot wipe the merged-in remote text', async () => {
    const h = harness()
    await h.writeNow()
    expect(h.disk()).toBe(MERGED)
    h.onEditorChange(OURS) // 排在 200ms 防抖里、合并前的那个回调现在才到
    await h.writeNow()
    expect(h.disk()).toBe(MERGED) // 别处那段还在
    expect(h.pipe.body).toBe(MERGED)
    expect(h.preserveExternal).not.toHaveBeenCalled()
    h.onEditorChange(MERGED.replace('local', 'local more')) // 合并之后的击键照常收
    await h.writeNow()
    expect(h.disk()).toBe(MERGED.replace('local', 'local more'))
  })

  // Codex 复核 P1:本地胜之后保全副本写成了、正文那发却写失败了 —— 下一次写时 lastSaved 仍是编辑器没含过的那版。
  it('a local-wins round whose write failed keeps the base marked foreign across retries: no merge until a write succeeds', async () => {
    const h = harness({ disk: SAME_LINE })
    h.writeTextFile.mockImplementationOnce(async () => ({ ok: false, current: SAME_LINE })) // 第一发被拒(同一行,合不拢)
      .mockImplementationOnce(async () => { throw new Error('Offline') }) // 本地胜那发写失败
    await h.writeNow()
    expect(h.noteWriteFailed).toHaveBeenCalledTimes(1)
    expect(h.pipe).toMatchObject({ unpreserved: null, lastSaved: SAME_LINE, foreignBase: true })
    const newer = SAME_LINE.replace('para1 AAA', 'para1 AAA newer') // 别处接着改了另一段
    h.setDisk(newer)
    await h.writeNow() // 退避重试:被拒,但基线不是祖先 → 照旧本地胜 + 副本,绝不合并
    expect(h.applyBody).not.toHaveBeenCalled()
    expect(h.preserveExternal.mock.calls.map(([c]) => c)).toEqual([SAME_LINE, newer])
    expect(h.disk()).toBe(OURS)
    expect(h.pipe.foreignBase).toBe(false) // 写成了:基线重新是祖先
    h.pipe.body = OURS.replace('local', 'local again')
    h.setDisk(OURS.replace('para1 AAA', 'para1 AAA later'))
    await h.writeNow() // 之后的冲突照常合并
    expect(h.applyBody).toHaveBeenCalledTimes(1)
    expect(h.disk()).toBe(OURS.replace('local', 'local again').replace('para1 AAA', 'para1 AAA later'))
  })

  it('a pristine instance still yields to the disk version (unchanged)', async () => {
    const h = harness()
    h.isPristine.mockReturnValue(true)
    h.readTextFile.mockImplementation(async () => new Promise(() => {})) // 只看让位本身,回灌不往下走
    await h.writeNow()
    expect(h.reconcileNow).toHaveBeenCalledTimes(1)
    expect(h.applyBody).not.toHaveBeenCalled()
    expect(h.writeTextFile).toHaveBeenCalledTimes(1)
  })
})

describe('entry 2: external change while the editor has unsaved edits', () => {
  it('merges the disk version into the editor and writes the merged text against it (no conflict copy)', async () => {
    const h = harness()
    await h.reconcile()
    await h.pipe.chain
    expect(h.applyBody).toHaveBeenCalledWith(MERGED, false)
    expect(h.preserveExternal).not.toHaveBeenCalled()
    expect(h.writeTextFile).toHaveBeenCalledTimes(1)
    expect(h.writeTextFile.mock.calls[0]).toEqual(['Note.md', MERGED, { base: textFingerprint(THEIRS) }])
    expect(h.pipe).toMatchObject({ pending: false, unpreserved: null, lastSaved: MERGED })
    expect(h.toastMergedRemote).toHaveBeenCalledTimes(1)
  })

  it('Tangu wrote the other version: its changes are marked in the editor and the notice names Tangu', async () => {
    const h = harness()
    h.claimAgentWrite.mockReturnValue(true)
    await h.reconcile()
    expect(h.applyBody).toHaveBeenCalledWith(MERGED, true)
    expect(h.toastMergedRemote).toHaveBeenCalledWith('Note.md', true)
  })

  it('frontmatter changed on one side only: merged text takes that side\'s frontmatter', async () => {
    const fm = '---\nstatus: done\n---\n'
    const h = harness({ disk: fm + THEIRS })
    await h.reconcile()
    await h.pipe.chain
    expect(h.disk()).toBe(fm + MERGED)
    expect(h.pipe.fm).toBe(fm)
    expect(h.setFmVer).toHaveBeenCalled()
  })

  it('control: same-line edits keep today\'s behavior (editor untouched, disk version preserved, local written)', async () => {
    const h = harness({ disk: SAME_LINE })
    await h.reconcile()
    await h.pipe.chain
    expect(h.applyBody).not.toHaveBeenCalled()
    expect(h.preserveExternal).toHaveBeenCalledWith(SAME_LINE)
    expect(h.disk()).toBe(OURS)
  })

  it('an earlier external version still waits to be preserved: lastSaved is not our ancestor, so no merge', async () => {
    const h = harness()
    const older = BASE.replace('para2 BBB', 'para2 BBB older')
    h.pipe.unpreserved = older
    h.pipe.lastSaved = older // 上一轮回灌走了本地胜:基线被挪到了一版编辑器从没含过的内容
    await h.reconcile()
    await h.pipe.chain
    expect(h.applyBody).not.toHaveBeenCalled()
    expect(h.preserveExternal).toHaveBeenCalledWith(THEIRS)
  })

  it('a debounced editor callback queued before the merge cannot wipe the merged-in remote text (reconcile path)', async () => {
    const h = harness()
    await h.reconcile()
    await h.pipe.chain
    h.onEditorChange(OURS)
    await h.writeNow()
    expect(h.disk()).toBe(MERGED)
  })

  it('reconcile fallback marks the base foreign: a later CAS reject in the same unsaved session does not merge against it', async () => {
    const h = harness({ disk: SAME_LINE })
    h.writeTextFile.mockImplementationOnce(async () => { throw new Error('Offline') }) // 回灌收尾补发的那一写失败
    await h.reconcile()
    await h.pipe.chain
    expect(h.preserveExternal).toHaveBeenCalledWith(SAME_LINE)
    expect(h.pipe.foreignBase).toBe(true)
    const newer = SAME_LINE.replace('para1 AAA', 'para1 AAA newer')
    h.setDisk(newer)
    await h.writeNow()
    expect(h.applyBody).not.toHaveBeenCalled()
    expect(h.preserveExternal).toHaveBeenLastCalledWith(newer)
    expect(h.disk()).toBe(OURS)
  })

  it('disk back at our own baseline (self echo) is not a conflict: nothing merged, nothing preserved', async () => {
    const h = harness({ disk: BASE })
    await h.reconcile()
    await h.pipe.chain
    expect(h.applyBody).not.toHaveBeenCalled()
    expect(h.preserveExternal).not.toHaveBeenCalled()
    expect(h.toastMergedRemote).not.toHaveBeenCalled()
    expect(h.disk()).toBe(OURS)
  })
})
