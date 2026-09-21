/**
 * 真链路探针:服务端(express.json inflate)和它前面的反代(nginx)放不放行 gzip 压缩的请求体。
 * 云同步的文本 PUT 走 Content-Encoding: gzip(electron/amadeus/sync/cloudClient.ts,省上行)——单测只能钉
 * 客户端那一半,「链路上有没有人拒/剥这个头」只有真发才知道。换反代、上 WAF、改 body parser 后重跑。
 *
 *   node scripts/gzip-upload.probe.cjs https://api.forsion.net                          # 免登录:不用 token、零写入
 *   node scripts/gzip-upload.probe.cjs http://localhost:3001 ~/.forsion-dev/auth.json   # 带 token:再证「解出来的就是原 JSON」
 *
 * 判据(全局 express.json 跑在路由鉴权之前):
 *   免登录   带头 → 401(解压 + 解析都过了,卡在鉴权) | 同一份字节不带头 → 解析器拒(4xx/5xx 非 401;负对照:解析器确实在看 body)
 *   带 token 不存在的路径 + baseSeq≠0 → 409 CONFLICT seq=0:handler 读到了 path/baseSeq;CAS 在任何写入之前抛,零落盘。
 */
const { gzipSync } = require('node:zlib')
const fs = require('node:fs')
const os = require('node:os')

const [base, authPath] = process.argv.slice(2)
if (!base) {
  console.error('usage: node scripts/gzip-upload.probe.cjs <serverOrigin> [auth.json]')
  process.exit(2)
}
const api = `${base.replace(/\/+$/, '')}/api/amadeus`
const payload = { path: '.forsion-probe/gzip-upload.md', content: '# 探针 probe — 不会落盘\n'.repeat(300), baseSeq: 999999 }
const gz = gzipSync(JSON.stringify(payload))

/** 只回状态码 + code/seq —— 409 体里可能带用户笔记正文,绝不打印。 */
const put = async (url, { encoded, token }) => {
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Amadeus-Client': 'probe-gzip-upload',
      ...(encoded ? { 'Content-Encoding': 'gzip' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: gz,
    signal: AbortSignal.timeout(20_000),
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, code: body?.code ?? null, seq: body?.seq ?? null }
}

let failed = false
const check = (label, got, want) => {
  const ok = Object.entries(want).every(([k, v]) => got[k] === v)
  console.log(`${ok ? '✓' : '✗'} ${label} → ${JSON.stringify(got)}`)
  if (!ok) failed = true
}

;(async () => {
  console.log(`probe ${api}  (payload ${JSON.stringify(payload).length}B → gzip ${gz.byteLength}B)`)
  const anon = `${api}/vaults/probe/file`
  check('免登录 · gzip 带头(期望 401:解析过了,卡在鉴权)', await put(anon, { encoded: true }), { status: 401 })
  // 负对照:同一份字节不带头 → JSON 解析器直接炸(到不了鉴权的 401)。09-21 之前的服务端把它映射成 500,之后(errorHandler.ts)是 400;
  // 两种都算数,故只断言「被解析器拒、非 401」。
  const bare = await put(anon, { encoded: false })
  check('免登录 · 同字节不带头(期望被解析器拒,非 401:负对照)', { ...bare, parserRejected: bare.status >= 400 && bare.status !== 401 }, { parserRejected: true })

  if (authPath) {
    const token = JSON.parse(fs.readFileSync(authPath.replace(/^~/, os.homedir()), 'utf8')).token
    if (!token) throw new Error(`no token in ${authPath}`)
    const list = await fetch(`${api}/vaults`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) })
    if (!list.ok) throw new Error(`GET /vaults → ${list.status}(token 过期?)`)
    const vaultId = (await list.json()).vaults?.[0]?.id
    if (!vaultId) throw new Error('account has no vault')
    check(
      '带 token · gzip PUT 不存在的路径 + baseSeq≠0(期望 409 CONFLICT seq 0:body 被完整解出,零写入)',
      await put(`${api}/vaults/${vaultId}/file`, { encoded: true, token }),
      { status: 409, code: 'CONFLICT', seq: 0 },
    )
  }
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error('probe error:', e?.message || e)
  process.exit(1)
})
