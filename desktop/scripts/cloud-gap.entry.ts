/**
 * check:cloudgap 的被测体(由 cloud-gap.check.cjs 用 esbuild 打包后在 node 里真跑):生产的 web cloudBridge +
 * cloudEvents 跑在一个按服务端契约建模的假服务端上,量「断线期间别处的修改,重连后开着的 v4 笔记有没有补上」。
 * 评审 G2-01(探针原型:docs/ToBeImproved/amadeus-editor-review-2026-09-27-probes/verify-cross-end-host-1/verify.entry.ts)。
 *
 * 假服务端语义照 server/microserver/amadeus:
 *  - 文件 seq 逐文件自增;PUT baseSeq 不符 → 409 {code:'CONFLICT',seq,content};force 跳过比对;每次写 vault 级 seq++,
 *    经 SSE 推 change {seq,op,path,newPath,fileSeq,origin:{client}}(services/vaultService.ts)。
 *  - SSE:先发 hello {seq:last_change_seq};URL 带 ?since=N 且 N < seq → 从变更日志重放 (N, seq],日志被剪到不够
 *    → 发 reset(routes.ts `/vaults/:v/events`)。与原探针的唯一差别就是这条 —— 原探针的假服务端不认 since。
 * 编辑器 = UnifiedPage 回灌模型(订阅 onExternalChange 且 p!==path 丢弃;reconcile 读盘;有待写只换基线),
 * 并像 UnifiedPage 一样登记进 unified 生命周期(lifecycle.registerUnifiedPipe)—— 兜底补课靠它找到开着的 v4 笔记。
 */

type Result = { name: string; ok: boolean; detail: string }

// ---------------- 浏览器全局桩(必须先于被测模块求值:被测模块一律在 run() 里动态 import) ----------------
const g = globalThis as any
g.window = g
const ls = new Map<string, string>()
g.localStorage = {
  getItem: (k: string) => (ls.has(k) ? ls.get(k)! : null),
  setItem: (k: string, v: string) => { ls.set(k, String(v)) },
  removeItem: (k: string) => { ls.delete(k) },
  key: (i: number) => [...ls.keys()][i] ?? null,
  get length() { return ls.size },
}
g.addEventListener = () => {}
g.removeEventListener = () => {}

// ---------------- 假服务端 ----------------
type File = { content: string; seq: number }
const files = new Map<string, File>()
let vaultSeq = 0
const changeLog: any[] = []
const log: string[] = []
/** 模拟服务端变更日志被剪:重放窗口不够 → reset。 */
let pruned = false
/** 重放第 N 条之后掐断连接(量「重放中途断线」时 lastSeq 不许越过没收到的事件)。 */
let dropAfterReplayed: number | null = null

class FakeES {
  static all: FakeES[] = []
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  listeners = new Map<string, Array<(e: any) => void>>()
  closed = false
  alive = true
  constructor(readonly url: string) {
    FakeES.all.push(this)
    setTimeout(() => {
      if (this.closed || !this.alive) return
      this.onopen?.()
      this.dispatch('hello', JSON.stringify({ seq: vaultSeq }))
      const sinceRaw = new URL(this.url).searchParams.get('since')
      const since = sinceRaw === null ? NaN : Number(sinceRaw)
      if (Number.isFinite(since) && since >= 0 && since < vaultSeq) {
        const rows = changeLog.filter((e) => e.seq > since)
        if (!pruned && rows.length === vaultSeq - since) {
          let n = 0
          for (const r of rows) {
            this.dispatch('change', JSON.stringify(r))
            if (dropAfterReplayed !== null && ++n >= dropAfterReplayed) { dropAfterReplayed = null; this.drop(); return }
          }
        } else this.dispatch('reset', '{}')
      }
    }, 5)
  }
  addEventListener(n: string, f: (e: any) => void) { (this.listeners.get(n) ?? this.listeners.set(n, []).get(n)!).push(f) }
  dispatch(n: string, data: string) { if (this.closed || !this.alive) return; for (const f of this.listeners.get(n) ?? []) f({ data }) }
  close() { this.closed = true }
  drop() { this.alive = false; this.onerror?.() }
}
g.EventSource = FakeES
const live = () => FakeES.all.filter((s) => !s.closed && s.alive)
function emit(ev: any) { changeLog.push(ev); for (const s of live()) s.dispatch('change', JSON.stringify(ev)) }

const json = (status: number, body: any) =>
  new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

g.fetch = async (input: any, init: any = {}) => {
  const url = new URL(String(input))
  const method = (init.method || 'GET').toUpperCase()
  const client = init.headers?.['X-Amadeus-Client'] ?? null
  const p = url.pathname.replace(/^\/api/, '')
  if (p === '/amadeus/vaults' && method === 'GET') return json(200, { vaults: [{ id: 'default', name: 'default', lastChangeSeq: vaultSeq, sizeBytes: 0, createdAt: '' }] })
  if (p.endsWith('/tree')) return json(200, { pages: [...files.keys()].filter((k) => k.endsWith('.md')), files: [], folders: [], seq: vaultSeq })
  if (p.endsWith('/asset-token')) return json(200, { token: 'tok', ttlSec: 600 })
  if (p.endsWith('/shared-with-me')) return json(200, { items: [] })
  if (p.endsWith('/page-props')) return json(200, [])
  if (p.endsWith('/file') && method === 'GET') {
    const path = url.searchParams.get('path')!
    const f = files.get(path)
    if (!f) return json(404, { detail: 'not found' })
    return json(200, { path, kind: 'page', content: f.content, seq: f.seq, hash: '', updatedAt: '' })
  }
  if (p.endsWith('/file') && method === 'PUT') {
    const b = JSON.parse(init.body)
    const ex = files.get(b.path)
    if (!b.force) {
      if (b.baseSeq === 0 && ex) { log.push(`409-EXISTS ${b.path}`); return json(409, { code: 'EXISTS', seq: ex.seq, content: ex.content }) }
      if (b.baseSeq > 0) {
        if (!ex) return json(409, { code: 'CONFLICT', seq: 0, content: null })
        if (ex.seq !== b.baseSeq) { log.push(`409 ${b.path} base=${b.baseSeq} cur=${ex.seq}`); return json(409, { code: 'CONFLICT', seq: ex.seq, content: ex.content }) }
      }
    }
    const seq = ex ? ex.seq + 1 : 1
    files.set(b.path, { content: b.content, seq })
    vaultSeq++
    log.push(`PUT ${b.path} seq=${seq}${b.force ? ' FORCE' : ''}`)
    emit({ seq: vaultSeq, type: 'page', op: 'write', path: b.path, newPath: null, fileSeq: seq, origin: { client, actor: 'u' } })
    return json(200, { seq, hash: '' })
  }
  return json(404, { detail: `unmocked ${method} ${p}` })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
// 退避首跳 1s + ≤30% 抖动;留余量。
const RECONNECT_WAIT = 1700

function reset(seed: Record<string, string>) {
  files.clear(); vaultSeq = 0; log.length = 0; changeLog.length = 0; pruned = false; dropAfterReplayed = null
  for (const s of FakeES.all) s.close()
  FakeES.all.length = 0
  ls.clear()
  for (const [k, v] of Object.entries(seed)) {
    vaultSeq++
    files.set(k, { content: v, seq: 1 })
    changeLog.push({ seq: vaultSeq, type: 'page', op: 'write', path: k, newPath: null, fileSeq: 1, origin: { client: 'seed', actor: 'u' } })
  }
}

export async function run(): Promise<Result[]> {
  // 与 cloudBridge 里 `@/amadeus/unified/lifecycle` 解析到同一文件 → 同一模块实例(esbuild 按路径去重)。
  const { createCloudAmadeusBridge } = await import('../../web/src/amadeus/cloudBridge')
  const { registerUnifiedPipe } = await import('../frontend/src/amadeus/unified/lifecycle')
  const mk = () => createCloudAmadeusBridge({ apiBase: 'http://srv/api', getToken: () => 'header.eyJzdWIiOiJ1MSJ9.sig', onAuthError: () => {} }) as any

  /** UnifiedPage 回灌模型(UnifiedPage.tsx 订阅 onExternalChange 那段的最小镜像)+ 生命周期登记。 */
  class EditorModel {
    text = ''
    lastSaved = ''
    pending = false
    reconciles = 0
    offs: Array<() => void> = []
    constructor(readonly b: any, readonly path: string) {}
    async mount() {
      const raw = await this.b.readTextFile(this.path) // v4 路由只调 readTextFile,从不 loadPage
      this.text = raw ?? ''
      this.lastSaved = this.text
      this.offs.push(this.b.onExternalChange((p: string) => { if (p === this.path) void this.reconcile() }))
      this.offs.push(registerUnifiedPipe({ path: this.path, flush: async () => {}, retire: () => {} }))
    }
    async reconcile() {
      this.reconciles++
      const raw = await this.b.readTextFile(this.path)
      if (raw == null) return
      if (raw === this.lastSaved && !this.pending) return
      if (this.pending) { this.lastSaved = raw; return } // 活动编辑器赢(G2-02 策略,不在本条范围)
      this.text = raw
      this.lastSaved = raw
    }
    typeLocal(s: string) { this.text += s; this.pending = true }
    async save() { await this.b.writeTextFile(this.path, this.text); this.lastSaved = this.text; this.pending = false }
    unmount() { for (const off of this.offs.splice(0)) off() }
  }

  const results: Result[] = []
  const check = (name: string, ok: boolean, detail: string) => results.push({ name, ok, detail })
  const sinceOf = (u: string) => new URL(u).searchParams.get('since')

  /** 基本场景:B 开着 v4 笔记,SSE 断线期间 A 改了它,B 重连后接着打字。 */
  async function gap(opts: { pruned: boolean; loadStart: boolean }) {
    reset({ 'Start.md': 'start\n', 'notes/Note.md': 'base\n' })
    const A = mk(); const B = mk()
    await A.restoreVault(); await B.restoreVault()
    await sleep(30)
    // 启动页恢复(pageStore.restoreVault → loadPage(lastPage))设 lastLoadedPage = Start.md;移动端单列导航连这步都没有。
    if (opts.loadStart) await B.loadPage('Start.md')
    let structs = 0
    B.onStructureChange(() => { structs++ })
    const ed = new EditorModel(B, 'notes/Note.md')
    await ed.mount()
    await A.writeTextFile('notes/Note.md', 'base\nA1-online\n')
    await sleep(50)
    const onlineSeen = ed.text.includes('A1-online')
    const bConn = FakeES.all[1] // B 后建
    const seqBeforeDrop = vaultSeq
    bConn.drop()
    pruned = opts.pruned
    structs = 0
    await A.writeTextFile('notes/Note.md', 'base\nA1-online\nA2-WHILE-B-OFFLINE\n')
    await sleep(RECONNECT_WAIT)
    await sleep(400) // 结构刷新 300ms 防抖
    const reconnectUrl = FakeES.all.length >= 3 ? FakeES.all[2].url : ''
    const sawOffline = ed.text.includes('A2-WHILE-B-OFFLINE')
    ed.typeLocal('B-typed\n')
    await ed.save()
    await sleep(20)
    const final = files.get('notes/Note.md')!.content
    ed.unmount()
    return { onlineSeen, reconnectUrl, seqBeforeDrop, sawOffline, final, structs, log: [...log] }
  }

  // ① 服务端能重放:重连带 since,重放的那条变更直达开着的 v4 笔记;不走「兜底全量补课」。
  {
    const r = await gap({ pruned: false, loadStart: true })
    check('G1 重连 URL 带 ?since=<断线前最后见到的 seq>', sinceOf(r.reconnectUrl) === String(r.seqBeforeDrop), `url=${r.reconnectUrl} seqBeforeDrop=${r.seqBeforeDrop}`)
    check('G2 since 重放 → 开着的 v4 笔记(lastLoadedPage 指着别篇)看到断线期间的修改', r.onlineSeen && r.sawOffline, `online=${r.onlineSeen} offline=${r.sawOffline}`)
    check('G3 接着打字不 409、不强写,两边的字都在', r.final === 'base\nA1-online\nA2-WHILE-B-OFFLINE\nB-typed\n' && !r.log.some((l) => l.startsWith('409') || l.includes('FORCE')), `final=${JSON.stringify(r.final)} log=${JSON.stringify(r.log)}`)
    check('G4 能重放时不做兜底全量补课(hello 早于重放到达,不许见缺口就补)', r.structs === 0, `structureRefreshes=${r.structs}`)
  }
  // ② 服务端日志被剪 → reset → 兜底:所有开着的 unified 实例逐篇回灌(不只 lastLoadedPage)。
  for (const loadStart of [true, false]) {
    const r = await gap({ pruned: true, loadStart })
    const tag = loadStart ? 'lastLoadedPage=Start.md' : '从没 loadPage(移动端单列)'
    check(`G5 reset 兜底补课覆盖开着的 v4 笔记[${tag}]`, r.sawOffline && r.structs >= 1, `offline=${r.sawOffline} structureRefreshes=${r.structs}`)
    check(`G6 reset 后接着打字不强写覆盖[${tag}]`, r.final.includes('A2-WHILE-B-OFFLINE') && !r.log.some((l) => l.includes('FORCE')), `final=${JSON.stringify(r.final)} log=${JSON.stringify(r.log)}`)
  }
  // ③ 重放中途又断:下一次 since 只能推进到真收到的那条,剩下的下一轮接着重放(hello 的 seq 不能当「已收到」)。
  {
    reset({ 'a.md': 'a\n', 'b.md': 'b\n' })
    const A = mk(); const B = mk()
    await A.restoreVault(); await B.restoreVault()
    await sleep(30)
    const ea = new EditorModel(B, 'a.md'); await ea.mount()
    const eb = new EditorModel(B, 'b.md'); await eb.mount()
    FakeES.all[1].drop()
    await A.writeTextFile('a.md', 'a\nA-OFF\n')
    const firstOffline = vaultSeq
    await A.writeTextFile('b.md', 'b\nB-OFF\n')
    dropAfterReplayed = 1 // 第一次重连:重放完 a.md 那条就断
    await sleep(RECONNECT_WAIT)
    await sleep(RECONNECT_WAIT) // 第二次重连
    const urls = FakeES.all.slice(2).map((s) => s.url)
    const secondSince = urls[1] ? sinceOf(urls[1]) : null
    check('G7 重放中途断线:第二次重连的 since = 真收到的最后一条', secondSince === String(firstOffline), `sinces=${JSON.stringify(urls.map(sinceOf))} expected second=${firstOffline}`)
    check('G8 两篇开着的 v4 笔记最终都补上', ea.text.includes('A-OFF') && eb.text.includes('B-OFF'), `a=${JSON.stringify(ea.text)} b=${JSON.stringify(eb.text)}`)
    ea.unmount(); eb.unmount()
  }
  // ④ 比对交换写(Codex g3#1):UnifiedPage 带 base(= 它以为盘上是什么的 textFingerprint)写。云桥原先忽略 base ——
  //    409 后拉最新 seq 强写,别处的修改既不回灌也没有冲突副本。现在盘上不是基线 → 回 { ok:false, current } 交渲染层,
  //    与桌面主进程同一形状;不带 base 的调用方(插件文件类型等)一字不变。
  //    负对照(实跑过):摘掉 409 分支的指纹比对 → G9 红;摘掉写前的本端指纹预检 → G10 红而 G9 仍绿(两半各自被钉住)。
  {
    const { textFingerprint } = await import('../shared/amadeus/writeConflict')
    const fp = textFingerprint
    const puts = (path: string) => log.filter((l) => l.startsWith(`PUT ${path} `))
    // G9 跨端:B 读过基线,A 随后改了它(B 的 seq 已陈旧)→ B 带 base 保存 = 409 → 盘上不是基线 → 拒写交回现文,不强写
    {
      reset({ 'n.md': 'base\n' })
      const A = mk(); const B = mk()
      await A.restoreVault(); await B.restoreVault()
      await B.readTextFile('n.md')
      await A.writeTextFile('n.md', 'base\nA-elsewhere\n')
      const res = await B.writeTextFile('n.md', 'base\nB-local\n', { base: fp('base\n') })
      const disk = files.get('n.md')!.content
      check('G9 跨端 409 且盘上不是基线 → { ok:false, current },不强写、别处的修改还在',
        JSON.stringify(res) === JSON.stringify({ ok: false, current: 'base\nA-elsewhere\n' }) && disk === 'base\nA-elsewhere\n' && !log.some((l) => l.includes('FORCE')),
        `res=${JSON.stringify(res)} disk=${JSON.stringify(disk)} log=${JSON.stringify(log)}`)
    }
    // G10 同端两个实例(分屏 / 陈旧编辑器):seq 是本端自己推进的、服务端不会 409 —— 靠本端记下的指纹认出陈旧基线
    {
      reset({ 'n.md': 'base\n' })
      const B = mk()
      await B.restoreVault()
      await B.readTextFile('n.md')
      const r1 = await B.writeTextFile('n.md', 'base\nE1\n', { base: fp('base\n') })
      const r2 = await B.writeTextFile('n.md', 'base\nE2-stale\n', { base: fp('base\n') })
      const disk = files.get('n.md')!.content
      check('G10 同端陈旧实例带旧 base → 拒写交回现文,零次成功 PUT',
        JSON.stringify(r1) === JSON.stringify({ ok: true }) && JSON.stringify(r2) === JSON.stringify({ ok: false, current: 'base\nE1\n' }) && disk === 'base\nE1\n' && puts('n.md').length === 1,
        `r1=${JSON.stringify(r1)} r2=${JSON.stringify(r2)} disk=${JSON.stringify(disk)} log=${JSON.stringify(log)}`)
    }
    // G11 阳性对照:不带 base 的老调用方语义不变(409 → 拉 seq 强写,后写胜,返回 void)
    {
      reset({ 'n.md': 'base\n' })
      const A = mk(); const B = mk()
      await A.restoreVault(); await B.restoreVault()
      await B.readTextFile('n.md')
      await A.writeTextFile('n.md', 'base\nA\n')
      const res = await B.writeTextFile('n.md', 'base\nB-plugin\n')
      const disk = files.get('n.md')!.content
      check('G11 不带 base 照旧:409 后强写、返回 void', res === undefined && disk === 'base\nB-plugin\n' && log.some((l) => l.includes('FORCE')),
        `res=${JSON.stringify(res)} disk=${JSON.stringify(disk)} log=${JSON.stringify(log)}`)
    }
    // G12 409 但盘上内容恰好就是基线(别处写了同样的字,seq 白跳一格)→ 按新 seq 正常写,不误报冲突、不强写
    {
      reset({ 'n.md': 'base\n' })
      const A = mk(); const B = mk()
      await A.restoreVault(); await B.restoreVault()
      await B.readTextFile('n.md')
      await A.writeTextFile('n.md', 'base\n')
      const res = await B.writeTextFile('n.md', 'base\nB\n', { base: fp('base\n') })
      const disk = files.get('n.md')!.content
      check('G12 409 但内容等于基线 → 换新 seq 写成、{ ok:true }、无 FORCE',
        JSON.stringify(res) === JSON.stringify({ ok: true }) && disk === 'base\nB\n' && !log.some((l) => l.includes('FORCE')),
        `res=${JSON.stringify(res)} disk=${JSON.stringify(disk)} log=${JSON.stringify(log)}`)
    }
    // G13 新文件(服务端没有、本会话没见过)带 base → 无冲突照建
    {
      reset({})
      const B = mk()
      await B.restoreVault()
      const res = await B.writeTextFile('fresh.md', 'hello\n', { base: fp('') })
      check('G13 新文件带 base → 建成、{ ok:true }', JSON.stringify(res) === JSON.stringify({ ok: true }) && files.get('fresh.md')?.content === 'hello\n',
        `res=${JSON.stringify(res)} log=${JSON.stringify(log)}`)
    }
  }
  for (const s of FakeES.all) s.close()
  return results
}
