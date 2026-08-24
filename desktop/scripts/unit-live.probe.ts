/**
 * 活体探针:对**正在运行**的 Forsion(unitWeb)做端到端体检 —— 不起假件,测真进程。
 * 用途:用户报「设备页不实时/插件不显示」时,把 B 侧管道逐环钉死(配对→RPC→SSE→watcher→插件清单)。
 *
 * 会弹一次真配对确认框(需要在 B 机上点「允许」);探针会在库里建又删一篇 `__unit探针__.md`。
 * 跑:npx tsx scripts/unit-live.probe.ts [base]   (缺省 http://127.0.0.1:8791)
 */
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'

const base = process.argv[2] || 'http://127.0.0.1:8791'
const PROBE_NOTE = '__unit探针__.md'
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

  // 2 配对(B 机屏幕会弹确认框;2 分钟内点「允许」)
  const req = (await (await fetch(`${base}/unit/pair/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Claude 活体探针' }),
  })).json()) as { requestId?: string; code?: string; detail?: string }
  if (!req.requestId) {
    console.log(`配对请求被拒(${req.detail ?? '未知'})——若是 429,先在切换器脚部移除挂着的待确认,再重跑`)
    process.exit(2)
  }
  console.log(`\n>>> 请在 Forsion 弹框上核对配对码 ${req.code} 并点「允许」(等 120s)…\n`)
  let token = ''
  for (let i = 0; i < 80 && !token; i++) {
    await sleep(1500)
    const st = (await (await fetch(`${base}/unit/pair/poll?id=${req.requestId}`)).json()) as { status?: string; token?: string }
    if (st.status === 'approved' && st.token) token = st.token
    if (st.status === 'denied' || st.status === 'expired') break
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

  // 5 RPC 写 → SSE 必须吐 externalChange(origin=probe-a;真桥会丢自己的,这里裸看流证明发了)
  await rpc('page:save', [PROBE_NOTE, { blocks: [] }, { main: '# 探针\n\n第一笔\n' }])
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

  // 8 清理:探针笔记进回收站
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
