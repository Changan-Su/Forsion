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

import { fimInline } from './inlineAi'

const sse = (...events: object[]): Response => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })

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
