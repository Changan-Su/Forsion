/** drawingStore 行为契约:自动保存(防抖落盘)+「关掉重开」种子必须是最新内容。
 *  背景 bug(2026-07-16 用户实报「白板没有自动保存」):persist 曾只推进 source 不推进 scene,
 *  而 load 对 ok 态幂等跳过 → 重开画布种回初次载入的旧场景,看起来就是没保存;
 *  旧种子上再画一笔,落盘还会把磁盘上的新内容盖回去(真数据丢失)。 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { blankDrawing, BLANK_SCENE_JSON, parseDrawing } from '@amadeus-shared/excalidraw/format'

const vault = vi.hoisted(() => ({ root: '/account-a', listeners: [] as Array<(s: { vaultRoot: string | null }, p: { vaultRoot: string | null }) => void> }))
vi.mock('./pageStore', () => ({ usePageStore: {
  getState: () => ({ vaultRoot: vault.root }),
  subscribe: (listener: (s: { vaultRoot: string | null }, p: { vaultRoot: string | null }) => void) => { vault.listeners.push(listener); return () => {} },
} }))
function switchRoot(root: string): void {
  const previous = vault.root
  vault.root = root
  for (const listener of vault.listeners) listener({ vaultRoot: root }, { vaultRoot: previous })
}

const REF = '未命名白板.excalidraw.md'
const SCENE2 = JSON.stringify({
  type: 'excalidraw', version: 2, source: 'test',
  elements: [{ id: 'e1', type: 'rectangle' }], appState: { viewBackgroundColor: '#ffffff' },
})

const readDrawing = vi.fn(async () => ({ status: 'ok', path: REF, source: blankDrawing(BLANK_SCENE_JSON) }))
const writeDrawing = vi.fn(async () => undefined)

/** api.ts 在模块体读 window.amadeus,drawingStore 模块体挂 beforeunload → 先立桩再动态 import。 */
let extCb: ((p: string) => void) | null = null
let mod: typeof import('./drawingStore')
async function freshStore() {
  vi.resetModules()
  vault.root = '/account-a'
  vault.listeners = []
  extCb = null
  vi.stubGlobal('window', {
    amadeus: {
      readDrawing,
      writeDrawing,
      onExternalChange: (cb: (p: string) => void) => { extCb = cb; return () => {} },
    },
    addEventListener: vi.fn(),
  })
  mod = await import('./drawingStore')
  return mod.useDrawStore
}

beforeEach(() => {
  vi.useFakeTimers()
  readDrawing.mockClear()
  writeDrawing.mockClear()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('drawingStore 自动保存', () => {
  it('最后一笔 800ms 后落盘一次,payload=最新场景,且只换 Drawing 段', async () => {
    const store = await freshStore()
    await store.getState().load(REF, REF)
    expect(store.getState().entries[REF]?.status).toBe('ok')

    store.getState().save(REF, SCENE2)
    await vi.advanceTimersByTimeAsync(799)
    expect(writeDrawing).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(writeDrawing).toHaveBeenCalledTimes(1)

    const [path, written] = writeDrawing.mock.calls[0] as unknown as [string, string]
    expect(path).toBe(REF)
    expect(parseDrawing(written)?.sceneJson).toBe(SCENE2)
    expect(written).toContain('excalidraw-plugin') // frontmatter 原样保留
    expect(store.getState().entries[REF]?.source).toBe(written)
  })

  it('落盘后 scene/seedFor 跟进到最新 —— 重开画布不得回到旧内容(回归)', async () => {
    const store = await freshStore()
    await store.getState().load(REF, REF)
    store.getState().save(REF, SCENE2)
    await vi.advanceTimersByTimeAsync(800)

    const scene = store.getState().entries[REF]?.scene as { elements?: Array<{ id: string }> }
    expect(scene?.elements?.[0]?.id).toBe('e1') // 修前:停在 BLANK(elements 空)
    const seed = store.getState().seedFor(REF) as { elements?: Array<{ id: string }> }
    expect(seed?.elements?.[0]?.id).toBe('e1')
  })

  it('防抖窗内(尚未落盘)seedFor 也拿 pending 最新场景', async () => {
    const store = await freshStore()
    await store.getState().load(REF, REF)
    store.getState().save(REF, SCENE2)
    const seed = store.getState().seedFor(REF) as { elements?: Array<{ id: string }> }
    expect(seed?.elements?.[0]?.id).toBe('e1')
    expect(writeDrawing).not.toHaveBeenCalled()
  })

  it('flush(画布卸载):立即落盘并清计时器,不再二次写', async () => {
    const store = await freshStore()
    await store.getState().load(REF, REF)
    store.getState().save(REF, SCENE2)
    await store.getState().flush(REF)
    expect(writeDrawing).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1600)
    expect(writeDrawing).toHaveBeenCalledTimes(1) // 计时器已清,pending 已消费
  })
})

/** 跨端同步:白板曾是「整文件后写胜」,两端同时开着就互相覆盖(2026-07-16 用户实报)。 */
const elL = { id: 'L', version: 1, versionNonce: 1, index: 'a0', type: 'line' }
const elR = { id: 'R', version: 1, versionNonce: 1, index: 'a1', type: 'line' }
const sceneOf = (els: unknown[]): string =>
  JSON.stringify({ type: 'excalidraw', version: 2, source: 'test', elements: els, appState: {}, files: {} })

describe('drawingStore 跨端同步(元素级合并)', () => {
  it('save 与盘面一致 → 不写(视口/选择级 onChange 与合并回声的空转)', async () => {
    const store = await freshStore()
    readDrawing.mockResolvedValue({ status: 'ok', path: REF, source: blankDrawing(sceneOf([elL])) })
    await store.getState().load(REF, REF)
    store.getState().save(REF, sceneOf([elL])) // 与载入态逐字节相同
    await vi.advanceTimersByTimeAsync(1600)
    expect(writeDrawing).not.toHaveBeenCalled()
  })

  it('外部变更:远端元素并入种子、活画布 applier 收到远端场景,无本地增量不回写', async () => {
    const store = await freshStore()
    readDrawing.mockResolvedValue({ status: 'ok', path: REF, source: blankDrawing(sceneOf([elL])) })
    await store.getState().load(REF, REF)
    const seen: unknown[] = []
    const off = mod.registerDrawingApplier(REF, (r) => seen.push(r))

    readDrawing.mockResolvedValue({ status: 'ok', path: REF, source: blankDrawing(sceneOf([elL, elR])) })
    extCb!(REF)
    await vi.advanceTimersByTimeAsync(0)

    expect(seen).toHaveLength(1)
    const scene = store.getState().entries[REF]?.scene as { elements?: Array<{ id: string }> }
    expect(scene?.elements?.map((e) => e.id)).toEqual(['L', 'R'])
    // 画布应用合并后的回声 onChange(内容与盘面一致)→ 去重,不写盘
    store.getState().save(REF, sceneOf([elL, elR]))
    await vi.advanceTimersByTimeAsync(1600)
    expect(writeDrawing).not.toHaveBeenCalled()
    off()
  })

  it('persist 写前预读:防抖窗内文件被别的端改过 → 落盘的是元素并集,不盲盖', async () => {
    const store = await freshStore()
    readDrawing.mockResolvedValue({ status: 'ok', path: REF, source: blankDrawing(BLANK_SCENE_JSON) })
    await store.getState().load(REF, REF)
    store.getState().save(REF, sceneOf([elL]))
    // 落盘前,对面写入了 R
    readDrawing.mockResolvedValue({ status: 'ok', path: REF, source: blankDrawing(sceneOf([elR])) })
    await vi.advanceTimersByTimeAsync(800)

    expect(writeDrawing).toHaveBeenCalledTimes(1)
    const [, written] = writeDrawing.mock.calls[0] as unknown as [string, string]
    const payload = JSON.parse(parseDrawing(written)!.sceneJson) as { elements: Array<{ id: string }> }
    expect(payload.elements.map((e) => e.id)).toEqual(['L', 'R'])
  })
})

describe('drawingStore account transition barrier', () => {
  it('strict flush rejects failed persistence and keeps the latest scene available to retry', async () => {
    const store = await freshStore()
    readDrawing.mockResolvedValue({ status: 'ok', path: REF, source: blankDrawing(BLANK_SCENE_JSON) })
    await store.getState().load(REF, REF)
    writeDrawing.mockRejectedValueOnce(new Error('Disk full'))
    store.getState().save(REF, SCENE2)
    await expect(store.getState().flushAll(true)).rejects.toThrow()
    expect((store.getState().seedFor(REF) as any).elements[0].id).toBe('e1')
    await store.getState().flushAll(true)
    expect(parseDrawing(store.getState().entries[REF].source!)?.sceneJson).toBe(SCENE2)
  })

  it('strict flush includes a write that has already consumed its debounce timer', async () => {
    const store = await freshStore()
    readDrawing.mockResolvedValue({ status: 'ok', path: REF, source: blankDrawing(BLANK_SCENE_JSON) })
    await store.getState().load(REF, REF)
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    writeDrawing.mockImplementationOnce(async () => { await gate })
    store.getState().save(REF, SCENE2)
    await vi.advanceTimersByTimeAsync(800)
    let done = false
    const barrier = store.getState().flushAll(true).then(() => { done = true })
    await vi.advanceTimersByTimeAsync(1)
    const early = done
    release()
    await barrier
    expect(early).toBe(false)
    expect(parseDrawing(store.getState().entries[REF].source!)?.sceneJson).toBe(SCENE2)
  })
})


describe('drawingStore account-owned caches', () => {
  it('same-named drawings in A and B load their own scenes and never merge A into B', async () => {
    const store = await freshStore()
    readDrawing.mockResolvedValue({ status: 'ok', path: REF, source: blankDrawing(sceneOf([elL])) })
    await store.getState().load(REF, REF)
    await store.getState().flushAll(true)
    switchRoot('/account-b')
    readDrawing.mockResolvedValue({ status: 'ok', path: REF, source: blankDrawing(sceneOf([elR])) })
    await store.getState().load(REF, REF)
    const seed = store.getState().seedFor(REF) as { elements: Array<{ id: string }> }
    expect(seed.elements.map((e) => e.id)).toEqual(['R'])
    const edited = { ...elR, version: 2 }
    store.getState().save(REF, sceneOf([edited]))
    await store.getState().flushAll(true)
    const last = writeDrawing.mock.calls.at(-1) as unknown as [string, string]
    expect(JSON.parse(parseDrawing(last[1])!.sceneJson).elements.map((e: { id: string }) => e.id)).toEqual(['R'])
    switchRoot('/account-a')
    readDrawing.mockResolvedValue({ status: 'ok', path: REF, source: blankDrawing(sceneOf([elL])) })
    await store.getState().load(REF, REF)
    expect((store.getState().seedFor(REF) as any).elements.map((e: any) => e.id)).toEqual(['L'])
  })

  it('an A read completing after B has loaded cannot replace B’s same-named cache entry', async () => {
    const store = await freshStore()
    let release!: (value: { status: string; path: string; source: string }) => void
    readDrawing.mockImplementationOnce(() => new Promise((r) => { release = r }))
    const oldRead = store.getState().reload(REF, REF)
    switchRoot('/account-b')
    readDrawing.mockResolvedValue({ status: 'ok', path: REF, source: blankDrawing(sceneOf([elR])) })
    await store.getState().load(REF, REF)
    release({ status: 'ok', path: REF, source: blankDrawing(sceneOf([elL])) })
    await oldRead
    expect((store.getState().seedFor(REF) as any).elements.map((e: any) => e.id)).toEqual(['R'])
  })
})
