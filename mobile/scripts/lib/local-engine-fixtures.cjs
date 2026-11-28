/**
 * 本机引擎台架共用的两个假服务(local-engine-emu.cjs / local-engine-ui-emu.cjs):
 *   - 环境包文件服务器 127.0.0.1:18900(envDir = build-env.sh 的产物;支持 Range、可限速,记下每个请求)
 *   - 假模型 127.0.0.1:18901(OpenAI 兼容 /v1/chat/completions,流式):第一轮让引擎调 run_bash,拿到结果后回一句带结果的话
 * 模拟器里经 10.0.2.2 访问(manifest 地址 http://10.0.2.2:18900/manifest.json;provider baseUrl http://10.0.2.2:18901/v1)。
 */
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

function startFixtures({ envDir, throttle = 8 * 1024 * 1024 }) {
  // ── 环境包服务器(支持 Range,可限速;记下每个请求)──
  const served = []
  const files = http.createServer((req, res) => {
    const name = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '')
    const p = path.join(envDir, name)
    served.push({ t: Date.now(), url: req.url, range: req.headers.range || null })
    if (!name || name.includes('..') || !fs.existsSync(p)) { res.writeHead(404); return res.end() }
    const size = fs.statSync(p).size
    let start = 0, end = size - 1, status = 200
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '')
    if (m) { start = Number(m[1]); if (m[2]) end = Number(m[2]); status = 206 }
    res.writeHead(status, { 'Content-Length': end - start + 1, 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) })
    const s = fs.createReadStream(p, { start, end, highWaterMark: 64 * 1024 })
    let sent = 0; const t0 = Date.now()
    s.on('data', (chunk) => {
      sent += chunk.length
      const ahead = sent / throttle * 1000 - (Date.now() - t0)
      if (ahead > 0) { s.pause(); setTimeout(() => s.resume(), ahead) }
      if (!res.write(chunk)) { s.pause(); res.once('drain', () => s.resume()) }
    })
    s.on('end', () => res.end())
    req.on('close', () => s.destroy())
  })

  // ── 假模型(OpenAI 兼容 /v1/chat/completions,流式):第一轮让引擎调 run_bash,拿到结果后回一句带结果的话 ──
  const modelCalls = []
  const model = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      if (!req.url.endsWith('/chat/completions')) { res.writeHead(404); return res.end() }
      const j = JSON.parse(body || '{}')
      modelCalls.push(j)
      const msgs = j.messages || []
      const toolMsg = [...msgs].reverse().find((x) => x.role === 'tool')
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'echo', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
      if (!toolMsg) {
        send({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'run_bash', arguments: '' } }] })
        send({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: 'echo marker-$((6*7)) > probe.txt && cat probe.txt && uname -m && node -v' }) } }] })
        send({}, 'tool_calls')
      } else {
        const out = typeof toolMsg.content === 'string' ? toolMsg.content : JSON.stringify(toolMsg.content)
        for (const piece of ['PHONE-OK ', 'tool said: ', out.replace(/\s+/g, ' ').slice(0, 200)]) send({ content: piece })
        send({}, 'stop')
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })

  const listen = (srv, port) => new Promise((r) => srv.listen(port, '127.0.0.1', r))

  return Promise.all([listen(files, 18900), listen(model, 18901)]).then(() => ({
    served, modelCalls,
    close: () => { files.close(); model.close() },
  }))
}

module.exports = { startFixtures }

// ── signed-in account for the native side ──
// The native shell keys engine data by the account in the sign-in token (LocalEnginePaths.accountKey: sha256 of
// "forsion-account:" + the JWT payload's userId, first 24 hex). Benches sign in with a JWT-shaped fake (nothing
// verifies it on the phone; the cloud API is stubbed or unused).
const crypto = require('node:crypto')
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const fakeJwt = (userId) => `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ userId, username: userId })}.sig`
const accountKey = (userId) => crypto.createHash('sha256').update(`forsion-account:${userId}`).digest('hex').slice(0, 24)
const accountDirs = (userId) => {
  const base = `files/local-engine/accounts/${accountKey(userId)}`
  return { home: `${base}/home`, workspace: `${base}/workspace` }
}
module.exports.fakeJwt = fakeJwt
module.exports.accountKey = accountKey
module.exports.accountDirs = accountDirs
