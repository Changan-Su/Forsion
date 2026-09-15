/**
 * 引擎必须把客户端面标识(`desktop/2.7.9`)随请求发给云端 brain ——
 * 否则 `api_usage_logs.client` 恒空,admin「API 用量」的「端/版本」列永远是「—」。
 *
 * 这条钉的是**转发本身**:httpBrain 靠 `{modelId, ...opts}` 整体展开把 opts 带过去,
 * 一旦有人改成逐字段挑选(很容易顺手做的"清理"),client 会静默消失,而 typecheck 与
 * 任何单测都不会红 —— 2026-08-09 那轮就是靠这个展开才做到零改动接线的。
 *
 * F1 之后 buildProviderPayload 不再自己发请求(返回惰性描述符),所以两条落地路径都要钉:
 * 新服务端 → 合并端点 /brain/llm/build-and-stream 的请求体;老服务端(合并端点 404)→
 * 回落的 /brain/llm/build-payload 请求体。
 */
import { describe, it, expect } from 'vitest'
import http from 'node:http'
import { createHttpBrain } from './httpBrain.js'

const buildOpts = {
  model: { id: 'm', name: 'M', provider: 'openai' } as any,
  apiModelId: 'm',
  messages: [],
  projectSource: 'tangu',
  client: 'desktop/9.9.9',
}

const done = 'data: ' + JSON.stringify({
  t: 'done', content: 'ok', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 },
}) + '\n\n'

/** combined=true 时合并端点回 SSE;false 时回 404(模拟老服务端)。返回每个路径收到的请求体。 */
async function runOnce(combined: boolean): Promise<Record<string, any>> {
  const seen: Record<string, any> = {}
  const srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      const path = (req.url || '').replace(/^.*\/api\/brain\/llm\//, '')
      seen[path] = JSON.parse(body || '{}')
      if (path === 'build-and-stream' && !combined) {
        res.writeHead(404, { 'Content-Type': 'text/html' })
        return res.end('Cannot POST')
      }
      if (path === 'build-payload') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ payload: { __forsion_model_id: 'm', built: true } }))
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(done)
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const port = (srv.address() as any).port
  try {
    const brain = createHttpBrain({ cloudUrl: `http://127.0.0.1:${port}`, token: 'test' })
    const payload = await brain.llm.buildProviderPayload(buildOpts)
    const r = await brain.llm.streamProviderCompletion({ apiKey: 'x', baseUrl: '', payload })
    expect(r.content).toBe('ok')
  } finally {
    srv.close()
  }
  return seen
}

describe('httpBrain 上报 client', () => {
  it('client 原样出现在合并端点的请求体里(新服务端)', async () => {
    const seen = await runOnce(true)
    expect(seen['build-and-stream']?.client).toBe('desktop/9.9.9')
    expect(seen['build-and-stream']?.projectSource).toBe('tangu')
    expect(seen['build-and-stream']?.modelId).toBe('m')
    expect(seen['build-payload']).toBeUndefined() // 合并端点可用时不再走老两步
  })

  it('client 原样出现在 build-payload 的请求体里(老服务端回落)', async () => {
    const seen = await runOnce(false)
    expect(seen['build-payload']?.client).toBe('desktop/9.9.9')
    expect(seen['build-payload']?.projectSource).toBe('tangu')
    expect(seen['stream']?.payload?.built).toBe(true)
  })
})
