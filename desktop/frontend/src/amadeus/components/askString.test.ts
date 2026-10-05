// 输入框是单例:Web 对话框(askStringOrAlt / 无原生宿主的 askString)与 Android 原生半屏(askString)互相顶替时,
// 被顶掉的那一个必须按「取消」收尾**且从屏幕上撤掉**(评审 2026-10-02:原生询问顶掉 Web 询问后,旧对话框还挂在半屏底下)。
import { afterEach, describe, expect, it } from 'vitest'
import { installNativeSheetPresenter, type NativeSheetPayload } from '@lcl/engine'
import { ASK_ALT, askString, askStringOrAlt, pendingWebPrompt } from './askString'

let uninstall: (() => void) | undefined
afterEach(async () => {
  uninstall?.()
  uninstall = undefined
  void askStringOrAlt('cleanup', '', { altLabel: 'x' }) // 顶掉残留的询问……
  void askString('cleanup') // ……再用一个无宿主的 Web 询问顶掉它,最后留下的这个不影响下一条用例的断言起点
})

/** 假原生宿主:记下每次呈现的标题与 signal;abort = 以取消收尾(同真宿主);answer(i, text) 模拟用户点确定。 */
function fakeHost(): { shown: Array<{ title: string; signal: AbortSignal }>; answer: (i: number, text: string | null) => void } {
  const shown: Array<{ title: string; signal: AbortSignal }> = []
  const resolvers: Array<(v: unknown) => void> = []
  uninstall = installNativeSheetPresenter((payload: NativeSheetPayload, signal) => new Promise((resolve) => {
    shown.push({ title: payload.kind === 'prompt' ? payload.title : payload.kind, signal })
    resolvers.push(resolve)
    signal.addEventListener('abort', () => resolve(null))
  }))
  return { shown, answer: (i, text) => resolvers[i](text === null ? null : { text }) }
}
const settled = async <T>(p: Promise<T>): Promise<T | 'pending'> => Promise.race([p, new Promise<'pending'>((r) => setTimeout(() => r('pending'), 10))])

describe('askString / askStringOrAlt replace each other', () => {
  it('a native prompt replacing a pending web prompt cancels it AND unmounts its dialog', async () => {
    const web = askStringOrAlt('Edit link', 'https://a', { altLabel: 'Remove link' })
    expect(pendingWebPrompt()).toEqual({ title: 'Edit link', altLabel: 'Remove link' })
    const host = fakeHost()
    const native = askString('Rename', 'old')
    expect(await web).toBeNull()
    expect(pendingWebPrompt()).toBeNull() // previously the stale dialog stayed mounted under the native sheet
    await expect.poll(() => host.shown.map((s) => s.title)).toEqual(['Rename'])
    host.answer(0, '  new name  ')
    expect(await native).toBe('new name')
  })

  it('a web prompt replacing a pending native prompt dismisses the sheet and cancels it', async () => {
    const host = fakeHost()
    const native = askString('Rename', 'old')
    await expect.poll(() => host.shown.length).toBe(1)
    const web = askStringOrAlt('Edit link', '', { altLabel: 'Remove link' })
    expect(host.shown[0].signal.aborted).toBe(true)
    expect(await native).toBeNull()
    // The cancelled native prompt must not fall back to a web dialog of its own: that would replace the new one.
    expect(pendingWebPrompt()).toEqual({ title: 'Edit link', altLabel: 'Remove link' })
    expect(await settled(web)).toBe('pending')
  })

  it('a native prompt replacing a native prompt cancels the first; the second answers normally', async () => {
    const host = fakeHost()
    const first = askString('First')
    await expect.poll(() => host.shown.length).toBe(1)
    const second = askString('Second')
    expect(host.shown[0].signal.aborted).toBe(true)
    expect(await first).toBeNull()
    await expect.poll(() => host.shown.length).toBe(2)
    expect(host.shown[1].signal.aborted).toBe(false)
    host.answer(1, 'ok')
    expect(await second).toBe('ok')
    expect(pendingWebPrompt()).toBeNull()
  })

  it('without a native host: web prompts replace each other as before (old one resolves null, new one is mounted)', async () => {
    const a = askStringOrAlt('A', '', { altLabel: 'alt' })
    const b = askString('B')
    expect(await a).toBeNull()
    expect(pendingWebPrompt()).toEqual({ title: 'B', altLabel: undefined })
    expect(await settled(b)).toBe('pending')
    expect(ASK_ALT.toString()).toContain('askString.alt')
  })

  it('a host that fails to present falls back to the web dialog', async () => {
    uninstall = installNativeSheetPresenter(async () => { throw new Error('plugin missing') })
    const p = askString('Fallback')
    await expect.poll(() => pendingWebPrompt()?.title).toBe('Fallback')
    expect(await settled(p)).toBe('pending')
  })
})
