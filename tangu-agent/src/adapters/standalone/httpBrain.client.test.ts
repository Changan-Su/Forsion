/**
 * 引擎必须把客户端面标识(`desktop/2.7.9`)随 build-payload 发给云端 brain ——
 * 否则 `api_usage_logs.client` 恒空,admin「API 用量」的「端/版本」列永远是「—」。
 *
 * 这条钉的是**转发本身**:httpBrain 靠 `{modelId, ...opts}` 整体展开把 opts 带过去,
 * 一旦有人改成逐字段挑选(很容易顺手做的"清理"),client 会静默消失,而 typecheck 与
 * 任何单测都不会红 —— 2026-08-09 那轮就是靠这个展开才做到零改动接线的。
 */
import { describe, it, expect } from 'vitest'
import http from 'node:http'
import { createHttpBrain } from './httpBrain.js'

describe('httpBrain 上报 client', () => {
  it('client 原样出现在 build-payload 的请求体里', async () => {
    let seen: any = null
    const srv = http.createServer((req, res) => {
      let body = ''
      req.on('data', (d) => (body += d))
      req.on('end', () => {
        if (req.url?.endsWith('/build-payload')) seen = JSON.parse(body || '{}')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ payload: { __forsion_model_id: 'm' } }))
      })
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
    const port = (srv.address() as any).port

    try {
      const brain = createHttpBrain({ cloudUrl: `http://127.0.0.1:${port}`, token: 'test' })
      await brain.llm.buildProviderPayload({
        model: { id: 'm', name: 'M', provider: 'openai' } as any,
        apiModelId: 'm',
        messages: [],
        projectSource: 'tangu',
        client: 'desktop/9.9.9',
      })
    } finally {
      srv.close()
    }

    expect(seen?.client).toBe('desktop/9.9.9')
    expect(seen?.projectSource).toBe('tangu')
  })
})
