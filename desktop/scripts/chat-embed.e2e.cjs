/**
 * 聊天内联嵌入整链 e2e:助手消息里独占一段的 `![[…]]` → 图片 / 音视频就地渲染(Agent Desk 之外的第二条展示通道)。
 * 真 Electron × 真组件 × 可编剧假引擎(media-citation.e2e 的骨架)。
 *
 *   E1  库外两张图(绝对路径)→ blob: 且真解码(naturalWidth>0);`|200` 宽度生效
 *   E2  库内图片(库内相对路径)→ amadeus-asset:// 且真解码
 *   E3  库外音频 `#t=20` → blob: 且真的停在 20 秒(浏览器原生 Media Fragments;量 currentTime 不量 src)
 *   E4  库内音频 `#t=95` → amadeus-asset:// 且停在 95 秒
 *   E5  >50MB 不内联 → 退回引用条,不留读盘占位
 *   E6  句中的 `![[x]]` 不升格,仍是引用条
 *   E7  PDF 不内联 → 引用条
 *   E8  用户气泡里的 `![[…]]` 不升格(嵌入只给助手消息开)
 *   E9  点图片 → Agent Desk 开出这张图
 *   E10 流式:嵌入逐条到达(中间有半截 `![[…`),先到的图片**不重挂**(身份戳还在),收尾不留半截
 *
 * 需先 npm run build(e2e 吃 out/ 产物,不重建 = 在验旧代码)。用法:npm run e2e:chatembed
 * 截图:$TMPDIR/forsion-chatembed-{light,dark}.png(观感类改动交付前必看)。
 * ⚠️ 有 dev 版 Electron 在跑会「启动失败」(单实例锁)。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('zlib')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.join(__dirname, '..')
const SHOTS = { light: path.join(os.tmpdir(), 'forsion-chatembed-light.png'), dark: path.join(os.tmpdir(), 'forsion-chatembed-dark.png') }
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const SESSION = {
  id: 'embed-s1', title: '内联嵌入会话', summary: '', model_id: 'm1', archived: false, emoji: null,
  agent_config: null, project_path: '/tmp/embed-demo', project_name: 'embed-demo',
  created_at: '2026-09-25 09:00:00', updated_at: '2026-09-25 09:00:00',
}

/** 横向渐变 PNG(免依赖:zlib 压 IDAT + zlib.crc32 做校验)。纯色也行,渐变截图里更好认。 */
function gradientPng(w, h, from, to) {
  const row = Buffer.alloc(1 + w * 3)
  for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) row[1 + x * 3 + c] = Math.round(from[c] + (to[c] - from[c]) * (x / (w - 1)))
  const chunk = (type, data) => {
    const td = Buffer.concat([Buffer.from(type), data])
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))])
}

/** N 秒 8kHz 静音 wav(抄 media-citation.e2e)。 */
function silentWav(seconds) {
  const n = 8000 * seconds
  const buf = Buffer.alloc(44 + n)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(8000, 24); buf.writeUInt32LE(8000, 28); buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34)
  buf.write('data', 36); buf.writeUInt32LE(n, 40)
  buf.fill(128, 44)
  return buf
}

/** 轮询等某个媒体元素就位并停在 want 秒附近(最长 15s)。 */
async function waitMedia(win, sel, want, ms = 15_000) {
  const t0 = Date.now()
  let s = { found: false }
  while (Date.now() - t0 < ms) {
    s = await win.evaluate((q) => {
      const el = document.querySelector(q)
      return el ? { found: true, at: el.currentTime, ready: el.readyState, src: el.getAttribute('src') || '' } : { found: false }
    }, sel).catch(() => s)
    if (s.found && s.ready >= 1 && Math.abs(s.at - want) < 1.5) return s
    await win.waitForTimeout(300)
  }
  return s
}

/** 同 chat-runstats:启动缺省是 Home Space,先切 Agent/Tangu Space,再把侧栏切到会话列表点进会话。 */
async function openChatSession(win) {
  await win.waitForSelector('.dv-groupview', { timeout: 40_000 })
  await win.waitForTimeout(1000)
  await win.evaluate((names) => {
    const button = [...document.querySelectorAll('button.rb-space')]
      .find((item) => names.some((name) => (item.getAttribute('title') || item.textContent || '').includes(name)))
    button?.click()
  }, ['Agent', 'Tangu'])
  await win.waitForTimeout(1500)
  if (!(await win.locator('.t2s-search input').first().count().catch(() => 0))) {
    await win.click('.dv-edge-left').catch(() => {})
    await win.waitForTimeout(700)
  }
  const picker = win.locator('.t2sw-mode-picker').first()
  if (await picker.count().catch(() => 0)) {
    await picker.locator('.t2sw-mode-trigger').click().catch(() => {})
    await picker.locator('[data-workspace-mode="sessions"]').click().catch(() => {})
    await win.waitForTimeout(1000)
  }
  await win.locator('.t2s-srow', { hasText: '内联嵌入会话' }).first().click()
  await win.waitForTimeout(900)
}

async function send(win, text) {
  const ta = win.locator('.t2c-ta').first()
  for (let i = 0; i < 40 && !(await ta.isEnabled().catch(() => false)); i++) await win.waitForTimeout(500)
  await ta.click()
  await ta.fill(text)
  await win.keyboard.press('Enter')
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-chatembed-'))
  const vaultDir = path.join(home, 'vault')
  fs.mkdirSync(path.join(vaultDir, '图'), { recursive: true })
  fs.mkdirSync(path.join(vaultDir, '素材'), { recursive: true })
  fs.writeFileSync(path.join(vaultDir, '图', 'cover.png'), gradientPng(320, 180, [245, 158, 11], [239, 68, 68]))
  fs.writeFileSync(path.join(vaultDir, '素材', 'lecture.wav'), silentWav(200))
  const media = path.join(home, 'media')
  fs.mkdirSync(media, { recursive: true })
  const shotA = path.join(media, 'shot-a.png')
  const shotB = path.join(media, 'shot-b.png')
  const talk = path.join(media, 'talk.wav')
  const huge = path.join(media, 'huge.wav')
  const pdf = path.join(media, 'r.pdf')
  fs.writeFileSync(shotA, gradientPng(480, 270, [59, 130, 246], [16, 185, 129]))
  fs.writeFileSync(shotB, gradientPng(480, 270, [168, 85, 247], [236, 72, 153]))
  fs.writeFileSync(talk, silentWav(200))
  fs.writeFileSync(huge, Buffer.alloc(51 * 1024 * 1024)) // 过 fs:readFile 的 50MB 闸即可,内容不会被读
  fs.writeFileSync(pdf, '%PDF-1.4 not really')
  const udDev = path.join(home, 'userdata-dev')
  fs.mkdirSync(udDev, { recursive: true })
  fs.writeFileSync(path.join(udDev, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vaultDir, localVault: vaultDir }))

  const stub = await startStubEngine({
    sessions: [SESSION],
    messages: [
      { id: 'hu1', role: 'user', timestamp: 1790000000000, content: `用户气泡里的不升格 ![[${shotA}]]` },
      {
        id: 'hm1', role: 'model', timestamp: 1790000001000,
        content: [
          '改版前后两张截图:', '',
          `![[${shotA}]]`, `![[${shotB}|200]]`, '',
          '库里的封面:', '', '![[图/cover.png]]', '',
          '配音从 20 秒起:', '', `![[${talk}#t=20]]`, '',
          '库内录音:', '', '![[素材/lecture.wav#t=95]]', '',
          '太大的:', '', `![[${huge}]]`, '',
          `报告:`, '', `![[${pdf}]]`, '',
          `句中的不升格 ![[${shotB}]] 这里。`,
        ].join('\n'),
      },
    ],
    models: [{ id: 'm1', name: 'Stub 模型', provider: 'stub', contextWindow: 128_000 }],
  })
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url },
  })
  try {
    const win = await app.firstWindow()
    await win.setViewportSize({ width: 1400, height: 1000 })
    await win.waitForSelector('#root', { timeout: 40_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await openChatSession(win)
    try {
      await win.waitForSelector('.t2-asst .t2-embeds', { timeout: 30_000 })
    } catch (e) {
      await win.screenshot({ path: path.join(os.tmpdir(), 'forsion-chatembed-fail.png') }).catch(() => {})
      throw e
    }
    // 读盘 + 解码要一点时间:等占位全部消失(库外走 IPC base64,库内走协议流)
    await win.waitForFunction(() => !document.querySelector('.t2-asst .t2-embed-pending'), null, { timeout: 15_000 }).catch(() => {})
    await win.waitForTimeout(800)

    const probe = await win.evaluate(({ shotA, shotB }) => {
      const asst = document.querySelector('.t2-asst')
      const img = (sel) => [...asst.querySelectorAll(sel)].map((el) => ({ src: el.getAttribute('src') || '', nw: el.naturalWidth, w: el.getBoundingClientRect().width, title: el.title }))
      const chipsIn = (needle) => [...asst.querySelectorAll('.t2-embeds a.wikilink')].filter((a) => (a.getAttribute('data-wiki') || '').includes(needle)).length
      const mid = [...asst.querySelectorAll('p')].find((p) => p.textContent.includes('句中的不升格'))
      const user = [...document.querySelectorAll('.t2-user')].find((u) => u.textContent.includes('用户气泡里的不升格'))
      return {
        host: img('img.t2-embed-image').filter((x) => x.title === shotA || x.title === shotB),
        vault: img('img.t2-embed-image').filter((x) => x.src.startsWith('amadeus-asset://')),
        hugeChip: chipsIn('huge.wav'),
        pdfChip: chipsIn('r.pdf'),
        pending: asst.querySelectorAll('.t2-embed-pending').length,
        midChip: !!mid?.querySelector('a.wikilink'),
        midEmbed: !!mid?.querySelector('.t2-embed'),
        userEmbed: !!user?.querySelector('.t2-embed'),
        userChip: !!user?.querySelector('a.wikilink'),
      }
    }, { shotA, shotB })

    check('E1 库外两张图 → blob: 真解码,`|200` 宽度生效',
      probe.host.length === 2 && probe.host.every((x) => x.src.startsWith('blob:') && x.nw > 0) && Math.abs(probe.host[1].w - 200) < 2,
      JSON.stringify(probe.host.map((x) => ({ src: x.src.slice(0, 5), nw: x.nw, w: Math.round(x.w) }))))
    check('E2 库内图片 → amadeus-asset:// 真解码', probe.vault.length === 1 && probe.vault[0].nw === 320, JSON.stringify(probe.vault))
    const e3 = await waitMedia(win, '.t2-asst audio.t2-embed-audio[title$="talk.wav"]', 20)
    check('E3 库外音频 `#t=20` → blob: 且停在 20 秒', e3.found && e3.src.startsWith('blob:') && Math.abs(e3.at - 20) < 1.5, JSON.stringify(e3))
    const e4 = await waitMedia(win, '.t2-asst audio.t2-embed-audio[title$="lecture.wav"]', 95)
    check('E4 库内音频 `#t=95` → amadeus-asset:// 且停在 95 秒', e4.found && e4.src.startsWith('amadeus-asset://') && Math.abs(e4.at - 95) < 1.5, JSON.stringify(e4))
    check('E5 >50MB 不内联 → 退回引用条,不留读盘占位', probe.hugeChip === 1 && probe.pending === 0, `chip=${probe.hugeChip} pending=${probe.pending}`)
    check('E6 句中的 `![[x]]` 不升格,仍是引用条', probe.midChip && !probe.midEmbed, `chip=${probe.midChip} embed=${probe.midEmbed}`)
    check('E7 PDF 不内联 → 引用条', probe.pdfChip === 1, `chip=${probe.pdfChip}`)
    check('E8 用户气泡里的 `![[…]]` 不升格', probe.userChip && !probe.userEmbed, `chip=${probe.userChip} embed=${probe.userEmbed}`)

    await win.evaluate(() => document.querySelector('.t2-asst .t2-embeds')?.scrollIntoView({ block: 'start' }))
    await win.waitForTimeout(400)
    await win.locator('.t2-chat-col').first().screenshot({ path: SHOTS.light }).catch(() => win.screenshot({ path: SHOTS.light }))
    await win.evaluate(() => { document.documentElement.classList.add('dark'); document.documentElement.dataset.mode = 'dark' })
    await win.waitForTimeout(300)
    await win.locator('.t2-chat-col').first().screenshot({ path: SHOTS.dark }).catch(() => win.screenshot({ path: SHOTS.dark }))
    await win.evaluate(() => { document.documentElement.classList.remove('dark'); document.documentElement.dataset.mode = 'light' })

    // ── E9 点图片 → Agent Desk 开出这张图 ─────────────────────────────────────────────
    await win.locator(`.t2-asst img.t2-embed-image[title="${shotA}"]`).first().click()
    let desk = null
    for (let i = 0; i < 40; i++) {
      desk = await win.evaluate(() => {
        const im = document.querySelector('.agent-desk img')
        return im ? { src: (im.getAttribute('src') || '').slice(0, 5), nw: im.naturalWidth } : null
      }).catch(() => null)
      if (desk && desk.nw > 0) break
      await win.waitForTimeout(250)
    }
    check('E9 点图片 → Agent Desk 开出这张图', !!desk && desk.nw === 480, JSON.stringify(desk))

    // ── E10 流式:逐条到达(中间有半截),先到的图不重挂,收尾不留半截 ───────────────────────
    stub.script([
      { type: 'token', delay: 300, payload: { delta: `新的两张:\n\n![[${shotA}]]\n` } },
      { type: 'token', delay: 2000, payload: { delta: `![[${shotB}` } },
      { type: 'token', delay: 1500, payload: { delta: '|200]]' } },
      { type: 'token', delay: 1500, payload: { delta: '\n\n就这些。' } },
      { type: 'done', delay: 300, payload: {} },
    ])
    await send(win, '再摆两张')
    let marked = false
    for (let i = 0; i < 40 && !marked; i++) {
      marked = await win.evaluate(() => {
        const all = [...document.querySelectorAll('.t2-asst:not(#tocmsg-hm1)')] // 只认新的流式消息(历史那条也有图)
        const im = all[all.length - 1]?.querySelector('img.t2-embed-image')
        if (!im || !im.naturalWidth) return false
        // 逐层打身份戳:重挂时能看出是哪一层换了节点(图片 / 嵌入段 / 正文块 / 整条消息)
        im.dataset.e2emark = 'keep'
        const layers = { embeds: im.closest('.t2-embeds'), content: im.closest('.t2-content'), asst: im.closest('.t2-asst') }
        for (const [k, el] of Object.entries(layers)) if (el) el.dataset.e2emark = k
        window.__e2eMarkId = layers.asst?.id
        return true
      }).catch(() => false)
      if (!marked) await win.waitForTimeout(150)
    }
    // 半截那一拍:第一张还在、半截原样显示
    await win.waitForTimeout(2300)
    const mid = await win.evaluate(() => {
      const all = [...document.querySelectorAll('.t2-asst:not(#tocmsg-hm1)')] // 只认新的流式消息(历史那条也有图)
      const last = all[all.length - 1]
      return {
        imgs: last?.querySelectorAll('img.t2-embed-image').length ?? 0, mark: last?.querySelector('img.t2-embed-image')?.dataset.e2emark ?? null,
        tail: last?.querySelector('.t2-embeds-tail')?.textContent ?? null,
        layers: ['.t2-embeds', '.t2-content'].map((q) => last?.querySelector(q)?.dataset.e2emark ?? null).concat(last?.dataset.e2emark ?? null),
        ids: [window.__e2eMarkId, last?.id],
      }
    })
    await win.waitForFunction(() => {
      const all = [...document.querySelectorAll('.t2-asst:not(#tocmsg-hm1)')] // 只认新的流式消息(历史那条也有图)
      return (all[all.length - 1]?.textContent || '').includes('就这些')
    }, null, { timeout: 15_000 }).catch(() => {})
    await win.waitForTimeout(800)
    const end = await win.evaluate(() => {
      const all = [...document.querySelectorAll('.t2-asst:not(#tocmsg-hm1)')] // 只认新的流式消息(历史那条也有图)
      const last = all[all.length - 1]
      const imgs = [...(last?.querySelectorAll('img.t2-embed-image') || [])]
      return { imgs: imgs.length, mark: imgs[0]?.dataset.e2emark ?? null, w2: Math.round(imgs[1]?.getBoundingClientRect().width || 0), tail: last?.querySelectorAll('.t2-embeds-tail').length ?? -1 }
    })
    check('E10a 流式半截那一拍:第一张在场、半截原样显示', marked && mid.imgs === 1 && mid.mark === 'keep' && !!mid.tail && mid.tail.startsWith('![['), JSON.stringify({ marked, ...mid }))
    check('E10b 收尾:两张都在、第一张没重挂(身份戳还在)、不留半截', end.imgs === 2 && end.mark === 'keep' && end.w2 === 200 && end.tail === 0, JSON.stringify(end))
  } finally {
    await app.close().catch(() => {})
    try { await stub.close() } catch { /* 桩关不掉不该盖掉断言结果 */ }
    fs.rmSync(home, { recursive: true, force: true })
  }
  const bad = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - bad}/${results.length} 通过\n截图:${Object.values(SHOTS).join('\n     ')}`)
  process.exit(bad ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
