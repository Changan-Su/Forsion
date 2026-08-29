/**
 * 活体探针:对**正在运行**的 Forsion(unitWeb)做端到端体检 —— 不起假件,测真进程。
 * 用途:用户报「设备页不实时/插件不显示」时,把 B 侧管道逐环钉死(配对→RPC→SSE→watcher→插件清单)。
 *
 * 免手点:B 机的 dev 用 `FORSION_UNIT_AUTO_PAIR=1 npm run dev` 起(双闸后门,仅非打包),
 * 配对请求会被自动批准,探针从头到尾无需人工。否则会弹一次真确认框(点一次后令牌落盘,以后复用)。
 * 探针会在库里建又删一篇 `__unit探针__.md`。
 * 跑:npx tsx scripts/unit-live.probe.ts [base]   (缺省 http://127.0.0.1:8791)
 */
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const base = process.argv[2] || 'http://127.0.0.1:8791'
const PROBE_NOTE = '__unit探针__.md'
/** 配对令牌落盘复用:免得每跑一次都要在 B 机点一次弹框。 */
const TOKEN_FILE = join(tmpdir(), 'forsion-unit-probe-token.txt')
const results: Array<{ name: string; ok: boolean }> = []
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  // 1 服务活着
  const meta = (await (await fetch(`${base}/unit/meta`)).json()) as { instanceId?: string; name?: string; version?: string }
  check('unit/meta 可达', !!meta.instanceId, `${meta.name} v${meta.version}`)

  // 2 配对:先试落盘的旧令牌(whoami 过闸即复用);不行再走弹框流(B 机 2 分钟内点「允许」)
  let token = ''
  try {
    const saved = (await readFile(TOKEN_FILE, 'utf8')).trim()
    if (saved && (await fetch(`${base}/unit/whoami`, { headers: { Authorization: `Bearer ${saved}` } })).status === 200) {
      token = saved
      console.log('(复用上次的配对令牌,免弹框)')
    }
  } catch { /* 没存过 */ }
  if (!token) {
    const req = (await (await fetch(`${base}/unit/pair/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Claude 活体探针' }),
    })).json()) as { requestId?: string; code?: string; detail?: string }
    if (!req.requestId) {
      console.log(`配对请求被拒(${req.detail ?? '未知'})——若是 429,等 2 分钟或点掉挂着的弹框再重跑`)
      process.exit(2)
    }
    console.log(`\n>>> 请在 Forsion 弹框上核对配对码 ${req.code} 并点「允许」(等 240s;配对请求 2 分钟一枚,过期自动再发)…\n`)
    for (let i = 0; i < 160 && !token; i++) {
      await sleep(1500)
      const st = (await (await fetch(`${base}/unit/pair/poll?id=${req.requestId}`)).json()) as { status?: string; token?: string }
      if (st.status === 'approved' && st.token) token = st.token
      if (st.status === 'denied') break
      if (st.status === 'expired') {
        // 上一枚过期:补发一枚(新码会另弹一框),继续等
        const again = (await (await fetch(`${base}/unit/pair/request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Claude 活体探针' }),
        })).json()) as { requestId?: string; code?: string }
        if (!again.requestId) break
        req.requestId = again.requestId
        console.log(`>>> 上一枚过期,新配对码 ${again.code},请点新弹框的「允许」…`)
      }
    }
    if (token) await writeFile(TOKEN_FILE, token, 'utf8').catch(() => {})
  }
  check('配对拿到令牌', !!token)
  if (!token) { finish(); return }
  const auth = { Authorization: `Bearer ${token}` }

  const rpc = async <T>(ch: string, args: unknown[] = []): Promise<T> => {
    const r = (await (await fetch(`${base}/vault/rpc`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ch, args, client: 'probe-a' }),
    })).json()) as { ok?: boolean; result?: T; error?: string }
    if (!r.ok) throw new Error(r.error || 'rpc failed')
    return r.result as T
  }

  // 3 vault 面:restoreVault + listPages
  const vault = await rpc<{ root: string; pages: string[] } | null>('vault:restore')
  check('restoreVault 有库', !!vault?.root, `root=${vault?.root} pages=${vault?.pages?.length}`)
  if (!vault?.root) { finish(); return }

  // 4 SSE 开流(?at=)
  const at = ((await (await fetch(`${base}/vault/asset-token`, { method: 'POST', headers: auth })).json()) as { token?: string }).token
  check('资源令牌可取', !!at)
  const events: Array<{ ch: string; payload?: unknown; origin?: string | null }> = []
  const es = await fetch(`${base}/vault/events?at=${at}`)
  check('SSE 开流', es.status === 200 && String(es.headers.get('content-type')).includes('event-stream'))
  const reader = es.body!.getReader()
  const dec = new TextDecoder()
  void (async () => {
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined as any }))
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i: number
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2)
        const data = block.split('\n').find((l) => l.startsWith('data: '))?.slice(6)
        if (data) { try { events.push(JSON.parse(data)) } catch { /* 心跳 */ } }
      }
    }
  })()
  await sleep(300)

  // 5a RPC 建页(page:new 走真编译器出合法 manifest)→ SSE 必须吐 structureChange(origin=probe-a)
  await rpc('page:new', [PROBE_NOTE])
  await sleep(1200)
  const newEv = events.find((e) => e.ch === 'vault:structure-change' && e.origin === 'probe-a')
  check('RPC 建页 → SSE structureChange(带 origin)', !!newEv, JSON.stringify(newEv ?? events.slice(-3)))

  // 5b 真数据往返:load 取真 manifest/blocks → 按 savePage 的 contents 形状(blockId→正文)回存
  //    → SSE 必须吐 externalChange(origin=probe-a;真桥会按 origin 丢自己的,这里裸看流证明发了)。
  //    ⚠️ LoadedPage 是 {manifest, blocks:{id:{id,type,content}}},**没有 contents 字段** ——
  //    写错字段名会让 undefined 经 JSON 数组变成 null,设备端报 `null['1']`(2026-08-24 栽过)。
  const loaded = await rpc<{ manifest: unknown; blocks: Record<string, { content: string }> }>('page:load', [PROBE_NOTE])
  const contents = Object.fromEntries(Object.entries(loaded.blocks || {}).map(([id, b]) => [id, `${b.content ?? ''}\n探针写入 ${Date.now()}\n`]))
  await rpc('page:save', [PROBE_NOTE, loaded.manifest, contents])
  await sleep(1200)
  const rpcEv = events.find((e) => e.ch === 'page:external-change' && e.payload === PROBE_NOTE)
  check('RPC 写 → SSE 回灌事件(带 origin)', !!rpcEv && rpcEv.origin === 'probe-a', JSON.stringify(rpcEv ?? events.slice(-3)))

  // 6 外部改盘(绕过一切接口直接 fs 追加)→ watcher → SSE(origin=null)
  const before = events.length
  await appendFile(join(vault.root, PROBE_NOTE), '\n外部追加的一行\n', 'utf8')
  let extEv: typeof events[number] | undefined
  for (let i = 0; i < 20 && !extEv; i++) {
    await sleep(500)
    extEv = events.slice(before).find((e) => e.ch === 'page:external-change' && e.payload === PROBE_NOTE && e.origin == null)
  }
  check('外部改盘 → watcher → SSE 回灌', !!extEv, extEv ? 'origin=null ✓' : `10s 无事件(收到 ${events.length - before} 条其他)`)

  // 7 插件清单
  const plugins = (await (await fetch(`${base}/unit/plugins`, { headers: auth })).json()) as { plugins?: Array<{ id?: string; blocked?: unknown }> }
  const ids = (plugins.plugins || []).map((p) => p.id)
  check('unit/plugins 有货', ids.length > 0, `${ids.length} 个: ${ids.slice(0, 6).join(', ')}${ids.length > 6 ? '…' : ''}`)

  // 8 P2P 面冒烟(方案 §12):路由在不在 + 隐藏窗应答链活不活。垃圾 offer 的**预期**是 500
  // (accept 走到 WebRTC 栈才对垃圾 SDP 报错=整条应答链活着);501=跑的还是没有 P2P 的旧构建;
  // 401 不该出现(带着配对令牌)。真打洞要两台实例,这里只冒烟到应答链。
  const p2p = await fetch(`${base}/unit/p2p/offer`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sdp: 'v=0\r\n(garbage-probe)' }),
  })
  check('unit/p2p/offer 应答链活着(垃圾 offer 预期 500)', p2p.status === 500,
    p2p.status === 501 ? '501=运行中的实例还是旧构建(无 P2P),重启 dev 再探' : `HTTP ${p2p.status}`)

  // 9 清理:探针笔记进回收站
  try { await rpc('page:delete', [PROBE_NOTE]); console.log('(探针笔记已删,可在废纸篓找到)') } catch { console.log('(清理失败,库里留有 __unit探针__.md,手动删即可)') }
  await reader.cancel().catch(() => {})
  finish()
}

function finish(): void {
  const fails = results.filter((r) => !r.ok).length
  console.log(fails ? `\n❌ ${fails} 条未过` : '\n✅ B 侧管道全通(若页面仍不更新,问题在页面侧/所用库侧)')
  process.exit(fails ? 1 : 0)
}

void main().catch((e) => { console.error('探针崩了:', e); process.exit(1) })
