/**
 * 云端转写:httpBrain.asr 打 POST /api/brain/transcribe(带账号令牌,base64 JSON,不填 client);
 * 「没人声」是空文本;别的拒绝带状态码报错;200 但回包读不出来要报错,不能当成空文本。
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
const asr = (base: string) => createHttpBrain({ cloudUrl: base, token: 'tok' }).asr!
const json = (code: number, body: unknown) => (_req: http.IncomingMessage, res: http.ServerResponse) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }

describe('httpBrain.asr', () => {
  it('posts base64 audio with the account token and no client tag; returns the text', async () => {
    respond = json(200, { text: ' 你好 ' })
    const out = await asr(await start()).transcribe({ audio: Buffer.from('WAVDATA'), mime: 'audio/wav', language: 'zh' })
    expect(out).toEqual({ text: '你好' })
    expect(seen[0].url).toBe('/api/brain/transcribe')
    expect(seen[0].auth).toBe('Bearer tok')
    expect(seen[0].body).toEqual({ audioBase64: Buffer.from('WAVDATA').toString('base64'), mime: 'audio/wav', language: 'zh', projectSource: 'tangu' })
  })

  it('no speech in the piece is empty text', async () => {
    respond = json(502, { detail: 'upstream(native) 400: ASR_RESPONSE_HAVE_NO_WORDS' })
    expect(await asr(await start()).transcribe({ audio: Buffer.from('x'), mime: 'audio/wav' })).toEqual({ text: '' })
  })

  it('a refusal carries its status', async () => {
    respond = json(402, { detail: 'token_quota_exceeded' })
    await expect(asr(await start()).transcribe({ audio: Buffer.from('x'), mime: 'audio/wav' })).rejects.toThrow(/402 \(quota exceeded\): token_quota_exceeded/)
  })

  it('a 200 whose body cannot be read is an error, not an empty transcript', async () => {
    const base = await start()
    respond = (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"text": "cut of') }
    await expect(asr(base).transcribe({ audio: Buffer.from('x'), mime: 'audio/wav' })).rejects.toThrow(/unreadable response/)
    respond = json(200, { ok: true })
    await expect(asr(base).transcribe({ audio: Buffer.from('x'), mime: 'audio/wav' })).rejects.toThrow(/no text field/)
  })
})
