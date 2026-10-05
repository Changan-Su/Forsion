// @vitest-environment happy-dom
// 回退(Rewind)的原生半屏请求必须跟发起它的那条消息同生共死(评审 2026-10-02):统计检查点慢的时候用户切走了会话,
// 半屏还照弹、选「回退对话」就把已经离开的那个会话回退了(破坏性)。EditorialMessage 在卸载 / 换会话 / 换消息时
// abort 这次请求;这里钉 openNativeRewind 对 signal 的三处响应:不弹、收掉已弹的、选了也不执行。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installNativeSheetPresenter, type NativeSheetPayload } from '@lcl/engine'
import { openNativeRewind } from './EditorialMessage'

type Args = Parameters<typeof openNativeRewind>
const t = ((key: string) => key) as Args[2]
const AT = 1_700_000_000_000
/** 手动放行的检查点统计(模拟慢请求)。 */
function slowStat(): { load: NonNullable<Args[6]>; finish: () => void } {
  let finish = (): void => {}
  const gate = new Promise<void>((r) => { finish = r })
  return { load: () => gate.then(() => ({ files: 2, skipped: 0 })), finish }
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

let uninstall: (() => void) | undefined
afterEach(() => { uninstall?.(); uninstall = undefined })

describe('native rewind sheet is bound to the message that asked for it', () => {
  it('no native host: returns false at once, the caller opens the web menu', () => {
    const load = vi.fn(async () => ({ files: 0, skipped: 0 }))
    expect(openNativeRewind(AT, undefined, t, vi.fn(), vi.fn(), new AbortController().signal, load)).toBe(false)
    expect(load).not.toHaveBeenCalled()
  })

  it('message still on screen: presents after the stat, and the pick runs', async () => {
    let payload: NativeSheetPayload | undefined
    uninstall = installNativeSheetPresenter(async (p) => { payload = p; return { id: 'conversation' } })
    const onPick = vi.fn()
    const onFallback = vi.fn()
    const stat = slowStat()
    expect(openNativeRewind(AT, undefined, t, onPick, onFallback, new AbortController().signal, stat.load)).toBe(true)
    await flush()
    expect(payload).toBeUndefined() // still counting: nothing shown yet
    stat.finish()
    await vi.waitFor(() => expect(onPick).toHaveBeenCalledWith('conversation'))
    expect(payload?.kind === 'menu' && payload.sections[0].items.map((i) => i.id)).toEqual(['code', 'conversation', 'both'])
    expect(onFallback).not.toHaveBeenCalled()
  })

  it('context changed while the stat was loading (conversation switched): no sheet, no pick, no web fallback', async () => {
    const present = vi.fn(async () => ({ id: 'conversation' }))
    uninstall = installNativeSheetPresenter(present)
    const onPick = vi.fn()
    const onFallback = vi.fn()
    const stat = slowStat()
    const req = new AbortController()
    expect(openNativeRewind(AT, undefined, t, onPick, onFallback, req.signal, stat.load)).toBe(true)
    req.abort() // EditorialMessage unmounted / its session or message changed
    stat.finish()
    await flush(); await flush()
    expect(present).not.toHaveBeenCalled()
    expect(onPick).not.toHaveBeenCalled()
    expect(onFallback).not.toHaveBeenCalled()
  })

  it('context changed while the sheet is up: the sheet is dismissed and a late answer rewinds nothing', async () => {
    let signal: AbortSignal | undefined
    let answer: (v: unknown) => void = () => {}
    // A host that only answers when told to (and ignores the abort): the worst case for a stale pick.
    uninstall = installNativeSheetPresenter((_p, s) => { signal = s; return new Promise((resolve) => { answer = resolve }) })
    const onPick = vi.fn()
    const onFallback = vi.fn()
    const req = new AbortController()
    openNativeRewind(AT, undefined, t, onPick, onFallback, req.signal, async () => ({ files: 1, skipped: 0 }))
    await vi.waitFor(() => expect(signal).toBeDefined())
    req.abort()
    expect(signal?.aborted).toBe(true) // the host is told to dismiss the sheet
    answer({ id: 'conversation' })
    await flush(); await flush()
    expect(onPick).not.toHaveBeenCalled()
    expect(onFallback).not.toHaveBeenCalled()
  })

  it('host fails to present while the message is still there: falls back to the web menu', async () => {
    uninstall = installNativeSheetPresenter(async () => { throw new Error('plugin missing') })
    const onFallback = vi.fn()
    openNativeRewind(AT, undefined, t, vi.fn(), onFallback, new AbortController().signal, async () => ({ files: 0, skipped: 0 }))
    await vi.waitFor(() => expect(onFallback).toHaveBeenCalledTimes(1))
  })
})
