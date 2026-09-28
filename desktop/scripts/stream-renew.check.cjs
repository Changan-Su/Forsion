/**
 * 远程会话事件流续订台架(P1 · K9,INTEGRATION §4 G1「>1h 流续订用例」)—— `npm run check:streamrenew`。
 *
 * 生产上一条经 hub 的事件流有两道时限(方案 §3「时长」):设备上行 POST /stream 的 Node requestTimeout = 1h(server/src/index.ts:21)、
 * 空闲 15min(socket.setTimeout)。两道都以 `abortClient → client.destroy()` 收场 —— 手机收到的是**半截断开**(网络错),不是干净收尾。
 * 渲染层 subscribeRunEvents 必须按 fromSeq 续订,且不丢、不重。1h / 15min 在台架里缩成秒级(STREAMRENEW_TOTAL_MS / STREAMRENEW_IDLE_MS,
 * 缺省 4000 / 1200ms),其余全是真的:手机形态页(mobile dev 构建 + 原生层 Node 替身)→ 假 hub → 真 unitHost → 真 unitWeb → 真引擎,
 * 模型是假 hub 里的可编剧模型:先匀速吐一段比总时长更久的带序号 token(逼出总时长断流),再每 4 个停一段比空闲时限更长的时间
 * (逼出空闲断流),共 ≥ 7 次断流。
 *
 * 断言:断流次数 ≥ 7(越过 subscribeRunEvents 的 6 次失败上限 —— 若失败计数在续订成功后不清零,第 7 次就会整条 run 挂掉);
 *   每次重连都带上 fromSeq 且单调前进;最终那条助手消息 = 48 个 token 按序拼接(不丢、不重),过程中的采样都是终稿的前缀(没有一闪而过的重复);
 *   消息没被标错;每次重连都带有效 X-Forsion-Caller(票每请求现取)。
 *   每条被掐的流都是**半截断开**(hub destroy 两侧),不是干净收尾 —— 与生产同形。
 * ⚠️ 「终稿」那条单独判不出丢帧:引擎的 done 事件带整段正文,appStore 收尾时用它覆盖流式拼出来的内容 —— 丢 / 重只在流式过程中可见,
 *   所以真正有牙的是「过程采样都是终稿的前缀」那条(负对照实测:两种故障终稿都完整,红的是采样)。
 * 负对照:NEGCTL=drop(hub 在第 2 次续订的回放里丢一帧 → 流式过程缺 token,须红);NEGCTL=fromseq0(续订时 fromSeq 被改回 0 →
 *   引擎从头回放 → 客户端不按 seq 去重、过程里出现重复,须红)。
 *
 * 前置同 check:remotechain(tangu-agent 的 dist;mobile 构建缺省复用 REMOTECHAIN_DIST / 临时目录那份)。
 */
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { startRemoteWorld } = require('./lib/remote-world.cjs')
const { createFakePhoneNative } = require('./lib/fake-phone-native.cjs')
const { PHONE_ORIGIN, buildPhoneDist, openPhonePage, pickComputer, closeOverlays, compose } = require('./lib/phone-page.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const TOTAL_MS = Number(process.env.STREAMRENEW_TOTAL_MS) || 4000
const IDLE_MS = Number(process.env.STREAMRENEW_IDLE_MS) || 1200
// 前 STEADY 个 token 匀速(每 150ms 一个,整段 > 总时长 → 逼出总时长断流),之后每 4 个停一段比空闲时限更长的时间(逼出空闲断流)
const STEADY = Math.ceil((TOTAL_MS * 1.5) / 150)
const TOKENS = STEADY + 32
const NEGCTL = process.env.NEGCTL || ''
const SHOT_DIR = process.env.SHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-streamrenew-shots-'))
const MARK = `SR-${crypto.randomBytes(3).toString('hex').toUpperCase()}`
const tok = (i) => `[${String(i).padStart(3, '0')}]`
const EXPECT = Array.from({ length: TOKENS }, (_, i) => tok(i + 1)).join('')

const results = []
const check = (name, ok, detail) => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  | ${detail}` : ''}`) }
const info = (name, detail) => console.log(`INFO  ${name}${detail ? `  | ${detail}` : ''}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function llm(call) {
  const usage = { prompt_tokens: 50, completion_tokens: TOKENS }
  const msgs = call.messages || []
  const last = msgs[msgs.length - 1] || {}
  const text = typeof last.content === 'string' ? last.content : Array.isArray(last.content) ? last.content.map((x) => x?.text || '').join('') : ''
  if (!call.tools.includes('run_bash') || last.role !== 'user' || !text.includes(MARK)) return [{ t: 'token', d: 'ok' }, { t: 'done', content: 'ok', toolCalls: [], usage }]
  const frames = []
  for (let i = 1; i <= TOKENS; i++) frames.push({ t: 'token', d: tok(i), delay: i <= STEADY ? 150 : (i - STEADY) % 4 === 1 ? IDLE_MS + 700 : 80 })
  frames.push({ t: 'done', content: EXPECT, toolCalls: [], usage })
  return frames
}

async function main() {
  console.log(`K9 stream renew  total=${TOTAL_MS}ms idle=${IDLE_MS}ms tokens=${TOKENS}(匀速 ${STEADY})${NEGCTL ? `  NEGCTL=${NEGCTL}` : ''}`)
  const dist = buildPhoneDist(process.env.REMOTECHAIN_DIST || path.join(os.tmpdir(), 'forsion-remotechain-dist'))
  const nativeCfg = JSON.parse(fs.readFileSync(path.join(dist, 'forsion-native.json'), 'utf8'))
  const home = await startStubEngine({ sessions: [], models: [{ id: 'cloud-model', name: 'Cloud Model', provider: 'forsion', contextWindow: 128000 }], agents: [{ slug: 'xyra', name: 'Tangu' }] })
  const world = await startRemoteWorld({
    staticDir: dist, homeEngineUrl: home.url, llm,
    streamCut: { totalMs: TOTAL_MS, idleMs: IDLE_MS },
    hubNegctl: { dropReplayFrame: NEGCTL === 'drop' ? 2 : 0, rewriteFromSeq0: NEGCTL === 'fromseq0' },
  })
  console.log(`  产物目录 ${world.out}`)
  const native = createFakePhoneNative({
    apiBase: nativeCfg.apiBase, token: () => world.PHONE_TOKEN, deviceName: 'K9 Pixel',
    fetch: (u, init) => fetch(String(u).startsWith(PHONE_ORIGIN) ? world.hub.url + String(u).slice(PHONE_ORIGIN.length) : u, init),
  })
  let browser = null
  try {
    const opened = await openPhonePage({ world, native })
    browser = opened.browser
    const { page, tap, pageErrors } = opened
    await pickComputer({ page, tap, unitId: world.DESKTOP_UNIT })
    await page.waitForFunction(() => window.__forsionEngineTargets?.focusRef().kind === 'unit', null, { timeout: 30_000 })
    await closeOverlays(page)
    await compose(page, `长回答续订测试 ${MARK}`)
    await page.keyboard.press('Enter')

    // 过程采样:每 250ms 读一次那条助手消息;任何一次都必须是终稿的前缀(一闪而过的重复 / 乱序也算红)
    const samples = []
    const t0 = Date.now()
    let final = null
    while (Date.now() - t0 < 120_000) {
      const m = await page.evaluate(() => { const s = window.__forsionStore.getState(); const list = s.messagesBySession[s.activeId] || []; const a = [...list].reverse().find((x) => x.role === 'assistant'); return a ? { st: a.status, c: String(a.content || '') } : null })
      if (m) samples.push({ at: Date.now() - t0, ...m })
      if (m && (m.st === 'done' || m.st === 'error')) { final = m; break }
      await sleep(250)
    }
    const cuts = world.hub.ledger.cuts.filter((c) => /\/events\?/.test(c.path || '') && c.reason !== 'negctl-drop')
    const evGets = world.hub.ledger.proxy.filter((x) => /\/engine\/agent\/runs\/[^/]+\/events\?/.test(x.path))
    const fromSeqs = evGets.map((x) => Number(/fromSeq=(\d+)/.exec(x.path)?.[1] ?? NaN))
    info('断流', `${cuts.length} 次(${[...new Set(cuts.map((c) => c.reason))].join('/')}),各次存活 ${cuts.map((c) => c.afterMs).join('/')}ms`)
    info('续订请求 fromSeq 序列', fromSeqs.join(' → '))
    check(`断流 ≥ 7 次(越过 subscribeRunEvents 的 6 次失败上限;含总时长与空闲两种)`, cuts.length >= 7 && cuts.some((c) => c.reason === 'total') && cuts.some((c) => c.reason === 'idle'), `${cuts.length} 次`)
    check('每次断流后都重连且带 fromSeq(首连 0,之后 > 0、单调不减)', evGets.length >= cuts.length + 1 && fromSeqs[0] === 0 && fromSeqs.slice(1).every((v, i) => v > 0 && v >= fromSeqs[i]), fromSeqs.join(','))
    check('每次重连都带有效 X-Forsion-Caller(票每请求现取,不因流被掐而丢)', evGets.every((x) => x.callerHeader && x.callerUnit === native.identity?.unitId && !x.rejected), `${evGets.filter((x) => !x.callerUnit).length} 条缺`)
    check('run 跑完、消息没被标错', final?.st === 'done', JSON.stringify(final && { st: final.st, len: final.c.length }))
    const content = final?.c || ''
    const got = content.match(/\[\d{3}\]/g) || []
    const missing = Array.from({ length: TOKENS }, (_, i) => tok(i + 1)).filter((x) => !got.includes(x))
    const dups = got.filter((x, i) => got.indexOf(x) !== i)
    check(`终稿 = ${TOKENS} 个 token 按序拼接(不丢、不重)`, content === EXPECT, `缺 ${missing.join('') || '无'};重 ${dups.join('') || '无'};长 ${content.length}/${EXPECT.length}`)
    const badSample = samples.find((s) => s.c && !EXPECT.startsWith(s.c.replace(/^\s+/, '')))
    check('过程中每次采样都是终稿的前缀(没有一闪而过的重复 / 乱序)', !badSample, badSample ? `@${badSample.at}ms ${badSample.c.slice(0, 80)}` : `${samples.length} 次采样`)
    check('页面无未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
    await page.screenshot({ path: path.join(SHOT_DIR, 'streamrenew-done.png') })
    console.log(`screenshots → ${SHOT_DIR}`)
  } finally {
    if (browser) await browser.close().catch(() => {})
    await world.close()
    home.close()
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过${NEGCTL ? `(负对照 ${NEGCTL}:期望有红)` : ''}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error('✗', e?.stack || e); process.exit(1) })
