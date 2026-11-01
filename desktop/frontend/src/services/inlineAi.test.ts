/**
 * 行内补全(ctx.tangu.fim)的渲染层客户端:fimInline → 引擎 /agent/inline 的 fim 动作。
 * 钉三件事:①请求体字段名对上引擎(max_tokens / stop / model_id)②回的是模型原文(空白照留)
 * ③做不了 FIM 的几种样子(老引擎 400 / 没这条路由 404 / error 事件 fim_unsupported)一律成 fim_unavailable,别的错照原样。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fetchMock = vi.hoisted(() => ({ impl: null as null | ((body: any) => Response) , bodies: [] as any[] }))
vi.mock('./engine/targets', () => ({
  homeTarget: () => ({ key: 'home' }),
  engineFetch: async (_t: unknown, _path: string, init: { body: string }) => {
    const body = JSON.parse(init.body)
    fetchMock.bodies.push(body)
    return fetchMock.impl!(body)
  },
}))
vi.mock('./agentRunService', () => ({ AGENT_APP_ID: 'tangu', currentClientId: () => 'desktop/test' }))

import { completeInline, fimInline } from './inlineAi'

const sse = (...events: object[]): Response => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })

describe('completeInline protected translation (all host and plugin entries)', () => {
  beforeEach(() => { fetchMock.bodies = []; fetchMock.impl = null })
  it('restores formulas and code; no partial marker leaks through SSE chunks', async () => {
    fetchMock.impl = (body) => {
      const out = body.selection.replace('Spin', '自旋')
      return sse(...Array.from(out, (text) => ({ type: 'delta', text })), { type: 'done', content: out })
    }
    const deltas: string[] = []
    const selection = String.raw`Spin $s=\frac12$ and ` + '`code()`'
    const result = await completeInline({ action: 'translate', selection, language: 'Chinese', modelId: 'mt' }, null, { onDelta: (d) => deltas.push(d) })
    expect(result.text).toBe(selection.replace('Spin', '自旋'))
    expect(deltas).toEqual([result.text])
    expect(fetchMock.bodies[0].selection).not.toContain('frac')
    expect(fetchMock.bodies[0].model_id).toBe('mt')
  })
  it('retries integrity failure once, then reports an error with no applicable partial output', async () => {
    fetchMock.impl = () => sse({ type: 'delta', text: 'broken' }, { type: 'done', content: 'broken' })
    const onDelta = vi.fn()
    await expect(completeInline({ action: 'translate', selection: 'Spin $s$' }, 'mt', { onDelta })).rejects.toMatchObject({ code: 'translation_format_lost' })
    expect(fetchMock.bodies).toHaveLength(2)
    expect(onDelta).not.toHaveBeenCalled()
  })
  it('retry success emits exactly once; plain prose keeps original streaming', async () => {
    let attempts = 0
    fetchMock.impl = (body) => sse({ type: 'done', content: ++attempts === 1 ? 'lost' : body.selection })
    const onDelta = vi.fn()
    expect((await completeInline({ action: 'translate', selection: 'Spin $s$' }, 'mt', { onDelta })).text).toBe('Spin $s$')
    expect(onDelta).toHaveBeenCalledTimes(1)
    fetchMock.impl = () => sse({ type: 'delta', text: '你好' }, { type: 'done', content: '你好' })
    const plain = vi.fn()
    await completeInline({ action: 'translate', selection: 'Hello' }, 'mt', { onDelta: plain })
    expect(plain).toHaveBeenCalledWith('你好')
  })
  it('cancellation prevents retries/output, and oversize source is never silently truncated', async () => {
    const ac = new AbortController()
    fetchMock.impl = () => { ac.abort(); return sse({ type: 'done', content: 'broken' }) }
    await expect(completeInline({ action: 'translate', selection: '$s$' }, 'mt', { signal: ac.signal })).rejects.toThrow()
    expect(fetchMock.bodies).toHaveLength(1)
    fetchMock.bodies = []
    await expect(completeInline({ action: 'translate', selection: '$x$ '.repeat(3000) }, 'mt')).rejects.toThrow(/过长/)
    expect(fetchMock.bodies).toHaveLength(0)
  })
})

describe('fimInline', () => {
  beforeEach(() => { fetchMock.bodies = []; fetchMock.impl = null })

  it('请求体对上引擎字段;回模型原文(不 trim)', async () => {
    fetchMock.impl = () => sse({ type: 'delta', text: '  return' }, { type: 'delta', text: ' a;\n' }, { type: 'done', content: '  return a;\n', toolCallText: false, modelId: 'ds' })
    const deltas: string[] = []
    const r = await fimInline({ before: 'f() {\n', after: '\n}', maxTokens: 32, stop: ['\n\n'] }, 'ds', { onDelta: (d) => deltas.push(d) })
    expect(r).toEqual({ text: '  return a;\n' })
    expect(deltas.join('')).toBe('  return a;\n')
    expect(fetchMock.bodies[0]).toEqual({ action: 'fim', before: 'f() {\n', after: '\n}', max_tokens: 32, stop: ['\n\n'], model_id: 'ds', app_id: 'tangu', client: 'desktop/test' })
  })

  it('老引擎 400 / 404 / error 事件 fim_unsupported → fim_unavailable;额度用尽等别的错照原样', async () => {
    fetchMock.impl = () => new Response(JSON.stringify({ detail: 'invalid inline request: unknown action' }), { status: 400 })
    await expect(fimInline({ before: 'a' }, 'ds')).rejects.toThrow('fim_unavailable')
    fetchMock.impl = () => new Response('Cannot POST', { status: 404 })
    await expect(fimInline({ before: 'a' }, 'ds')).rejects.toThrow('fim_unavailable')
    fetchMock.impl = () => sse({ type: 'error', error: 'fim_unsupported' })
    await expect(fimInline({ before: 'a' }, 'chat')).rejects.toThrow('fim_unavailable')
    fetchMock.impl = () => new Response(JSON.stringify({ detail: 'Too many inline requests in flight' }), { status: 429 })
    await expect(fimInline({ before: 'a' }, 'ds')).rejects.toThrow('Too many inline requests in flight')
  })
})
