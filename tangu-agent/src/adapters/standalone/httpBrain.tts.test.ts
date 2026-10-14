/**
 * 云端朗读:httpBrain.tts 打 POST /api/brain/tts(带账号令牌、模型 id 与朗读参数),回音频字节和上游的 Content-Type;
 * 云端拒(额度不够 / 不是朗读模型)时带着状态码报错;模型目录把 ttsModels 带出来。
 */
import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import { createHttpBrain } from './httpBrain.js'

let srv: http.Server | undefined
const seen: Array<{ url: string; auth: string; body: any }> = []
let respond: (req: http.IncomingMessage, res: http.ServerResponse) => void = () => {}

async function start(): Promise<string> {
  seen.length = 0
  srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => { seen.push({ url: req.url || '', auth: String(req.headers.authorization || ''), body: body ? JSON.parse(body) : null }); respond(req, res) })
  })
  await new Promise<void>((r) => srv!.listen(0, '127.0.0.1', () => r()))
  return `http://127.0.0.1:${(srv!.address() as any).port}`
}
afterEach(async () => { await new Promise((r) => srv?.close(() => r(null))) })

describe('httpBrain.tts', () => {
  it('打 /api/brain/tts:带令牌、模型 id 与朗读参数;回字节和 Content-Type', async () => {
    respond = (_req, res) => { res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.end('AUDIO') }
    const base = await start()
    const out = await createHttpBrain({ cloudUrl: base, token: 'tok' }).tts!.synthesize({ model: 'reader', text: '你好', voice: 'Cherry', speed: 1.2 })
    expect(Buffer.from(out.audio).toString()).toBe('AUDIO')
    expect(out.mime).toBe('audio/wav')
    expect(seen[0].url).toBe('/api/brain/tts')
    expect(seen[0].auth).toBe('Bearer tok')
    expect(seen[0].body).toEqual({ modelId: 'reader', text: '你好', voice: 'Cherry', speed: 1.2, projectSource: 'tangu' })
  })

  it('云端拒了:带着状态码和原因报错', async () => {
    respond = (_req, res) => { res.writeHead(402, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ detail: 'token_quota_exceeded' })) }
    const base = await start()
    await expect(createHttpBrain({ cloudUrl: base, token: 'tok' }).tts!.synthesize({ model: 'reader', text: 'hi' })).rejects.toThrow(/402: token_quota_exceeded/)
  })

  it('模型目录:ttsModels 带出来(只要 id / 名字 / 上游模型名)', async () => {
    respond = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ models: [], ttsModels: [{ id: 'reader', name: 'Reader', apiModelId: 'qwen3-tts-flash', apiKey: 'leak?' }, { name: 'no id' }] }))
    }
    const base = await start()
    const r = await createHttpBrain({ cloudUrl: base, token: 'tok' }).models.listModelsForProject!('tangu')
    expect(r.ttsModels).toEqual([{ id: 'reader', name: 'Reader', apiModelId: 'qwen3-tts-flash' }])
  })
})
