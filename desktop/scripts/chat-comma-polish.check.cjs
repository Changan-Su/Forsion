/**
 * 真 Electron:借鉴 Comma 第二轮的四件小事(方案页:仓根 docs/ToBeImproved/借鉴Comma方案_2026-10-21/more.html §2.1–2.4)。
 * npx electron-vite build && npm run check:commapolish        SHOTS=<目录> 另存亮 / 暗截图(110% 缩放)
 * 钉住:
 *  2.1 往上翻着时来了新回答 → 「↓ 1 条新消息」药丸,点了回到底部;
 *  2.2 ≥5000 字的纯文本粘贴成磁贴、输入框不收;点开看全文(等宽)、能放回输入框;发出时接在正文后、用代码块围住;
 *  2.3 提问卡出现时输入框空着 → 焦点给第一个选项;按数字直接选;在选项上打字跳进自由输入;⌘↵ 发出;用过键盘才出键位提示;
 *  2.4 引擎拒收 → 那条留在末尾(淡掉、带原因)、输入框清空;丢弃就没了;重试走同一段文字、成功后气泡消失。
 * 全程打隔离 loopback 桩引擎(lib/stub-engine.cjs),不碰真账号、不烧模型额度。
 */
const fs = require('fs')
const path = require('path')
const assert = require('node:assert/strict')
const { launch, boot, enterSpace } = require('./lib/uiux-electron.cjs')

let count = 0
function check(name, ok, detail) { assert.ok(ok, `${name}: ${JSON.stringify(detail)}`); console.log(`PASS ${name}`); count++ }
async function until(fn, ms = 8000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await new Promise((r) => setTimeout(r, 150)) } }

const SID = 'comma-polish'
const T = Date.UTC(2026, 9, 24, 9)
const para = (n) => Array.from({ length: n }, (_, i) => `第 ${i + 1} 段:把输入框、卡片和弹窗的圆角统一到三层,描边只留在需要分隔的地方。`).join('\n\n')
const messages = [
  { id: 'u1', role: 'user', content: '把界面风格统一一下,从圆角开始。', timestamp: T },
  { id: 'a1', role: 'model', content: para(8), timestamp: T + 1000 },
  { id: 'u2', role: 'user', content: '再看看描边。', timestamp: T + 2000 },
  { id: 'a2', role: 'model', content: para(8), timestamp: T + 3000 },
]
const SESSION = { id: SID, title: '界面风格统一', summary: '', model_id: 'm1', archived: false, agent_config: null, projectless: true, created_at: '2026-10-24 09:00:00', updated_at: '2026-10-24 09:10:00' }
const LOG = Array.from({ length: 60 }, (_, i) => `npm ERR! code ERESOLVE line ${i + 1}: While resolving: forsion-desktop@2.13.7  Found: react@18.3.1  peer react@"^19.0.0" from @dnd-kit/core@7.0.0`).join('\n')

async function main() {
  let refuse = false
  const ctx = await launch({ tag: 'comma-polish', fixtures: { agents: [], sessions: [SESSION] }, messages,
    stubOverride: async ({ path: p, method }) => { if (refuse && p === '/agent/runs' && method === 'POST') return { __code: 503, body: { error: 'engine unreachable' } } } })
  const { win, app, stub } = ctx
  const shots = process.env.SHOTS
  if (shots) fs.mkdirSync(shots, { recursive: true })
  // 截图前藏掉桩环境里冒出来的成就 / 引导提示(首次发消息就弹,和这几件无关,会挡住输入框上方)
  const shot = async (name) => {
    if (!shots) return
    await win.waitForTimeout(350)
    await win.evaluate(() => { for (const el of document.querySelectorAll('body *')) if (getComputedStyle(el).position === 'fixed' && /完成：|成就达成/.test(el.textContent || '') && (el.textContent || '').length < 80) el.style.visibility = 'hidden' })
    await win.screenshot({ path: path.join(shots, `${name}.png`), scale: 'css' })
  }
  const dark = (on) => win.evaluate((on) => { const r = document.documentElement; r.dataset.mode = on ? 'dark' : 'light'; r.classList.toggle('dark', on) }, on)
  try {
    await boot(app, win, { space: 'tangu', width: 1512, height: 950 }); await enterSpace(win, 'tangu')
    await win.locator(`.t2s-srow[data-sel-id="${SID}"]`).first().click()
    await win.locator('#tocmsg-a2').waitFor()
    await win.evaluate(() => { document.fonts.ready; document.body.style.zoom = '1.1' })
    const ta = win.locator('.t2c-ta').first()
    const send = async (text) => { await ta.click(); await ta.fill(text); await win.keyboard.press('Enter') }
    const runs = () => stub.seen.runs.length

    // ── 2.1 新消息计数 ──
    await win.locator('.t2-stream').first().hover()
    await win.mouse.wheel(0, -1600)
    await until(() => win.locator('.t2-jump').count())
    check('翻上去出现 ↓ 键,还不带数', await win.evaluate(() => { const b = document.querySelector('.t2-jump'); return !!b && !b.classList.contains('t2-jump--count') && !b.textContent.trim() }))
    stub.script([{ type: 'token', payload: { delta: '好,描边也去掉。' } }])
    await send('那就开工')
    const pill = await until(() => win.evaluate(() => document.querySelector('.t2-jump--count')?.textContent.trim()))
    check('来了一条回答 → 药丸「1 条新消息」(自己发的那条不算)', pill === '1 条新消息', pill)
    const geo = await win.evaluate(() => { const b = document.querySelector('.t2-jump--count').getBoundingClientRect(), c = document.querySelector('.t2c-card').getBoundingClientRect(); return { mid: Math.abs((b.left + b.right) / 2 - (c.left + c.right) / 2), above: b.bottom <= c.top } })
    check('药丸在输入卡正上方、大致居中', geo.above && geo.mid < 40, geo)
    await win.waitForTimeout(1200) // 等发送动效(气泡飞行)落完再拍
    await shot('pill-light')
    await dark(true); await shot('pill-dark'); await dark(false)
    await win.locator('.t2-jump--count').click()
    const atBottom = await until(() => win.evaluate(() => { const e = document.querySelector('.t2-stream'); return !document.querySelector('.t2-jump') && e.scrollHeight - e.scrollTop - e.clientHeight < 40 }))
    check('点药丸回到底部、药丸收起', atBottom)

    // ── 2.2 长粘贴变磁贴 ──
    const paste = (text) => ta.evaluate((el, text) => { const dt = new DataTransfer(); dt.setData('text/plain', text); el.focus(); el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })) }, text)
    await paste('短的一句照常进输入框')
    check('短粘贴不拦(浏览器自己落字;这里只查没出磁贴)', await win.locator('.att-tile--paste').count() === 0)
    await ta.fill('')
    await paste(LOG)
    await win.locator('.att-tile--paste').waitFor()
    const tile = await win.evaluate(() => ({ head: document.querySelector('.att-tile--paste .att-tile-head')?.textContent, sub: document.querySelector('.att-tile--paste .att-tile-sub')?.textContent, ta: document.querySelector('.t2c-ta').value }))
    check('长粘贴成磁贴:标题 = 第一行,副行写行数 · 字数,输入框是空的', tile.head?.startsWith('npm ERR! code ERESOLVE line 1') && tile.sub === `粘贴 · 60 行 · ${LOG.length.toLocaleString()} 字` && tile.ta === '', tile)
    check('只有磁贴也能发(发送键不灰)', await win.evaluate(() => { const b = document.querySelector('.t2c-card .t2c-send'); return !!b && !b.disabled }))
    await shot('paste-light')
    await win.locator('.att-tile--paste .att-tile-open').click()
    await win.locator('.quote-preview').waitFor()
    const pv = await win.evaluate(() => { const b = document.querySelector('.quote-preview-body--mono'); return { title: document.querySelector('.quote-preview .dialog-title')?.textContent, mono: !!b && /mono|Menlo|Courier|SF Mono/i.test(getComputedStyle(b).fontFamily), full: b?.textContent.length } })
    check('点磁贴看全文:标题「粘贴的内容」、等宽、全文都在', pv.title === '粘贴的内容' && pv.mono && pv.full === LOG.length, pv)
    await win.locator('.quote-preview .dialog-btn', { hasText: '放回输入框' }).click()
    const back = await win.evaluate(() => ({ tiles: document.querySelectorAll('.att-tile--paste').length, len: document.querySelector('.t2c-ta').value.length, dialog: !!document.querySelector('.quote-preview') }))
    check('放回输入框:磁贴没了、字回到输入框、窗关上', back.tiles === 0 && back.len === LOG.length && !back.dialog, back)
    await ta.fill('')
    await paste(LOG)
    await win.locator('.att-tile--paste').waitFor()
    await ta.fill('帮我看下这个报错')
    const before = runs()
    await win.keyboard.press('Enter')
    await until(() => runs() > before)
    const sent = stub.seen.runs[stub.seen.runs.length - 1]?.message || ''
    check('发出去:正文在前,粘贴的内容用代码块围着接在后面', sent.startsWith('帮我看下这个报错\n\n```\nnpm ERR!') && sent.endsWith('```') && sent.includes('line 60:'), sent.slice(0, 60))
    check('发完磁贴清掉', await until(() => win.evaluate(() => !document.querySelector('.att-tile--paste'))))

    // ── 2.3 提问卡用键盘答 ──
    const ask = (id, options) => stub.script([
      { type: 'tool_call', payload: { id: `t-${id}`, name: 'ask_user', arguments: JSON.stringify({ question: '深色卡的层次用哪种?', options }) } },
      { type: 'inquiry_request', payload: { inquiryId: id, question: '深色卡的层次用哪种?', options, allowFreeText: true } },
      { type: '__hold' },
    ])
    await win.waitForTimeout(800) // 上一条 run 收尾
    ask('q1', ['底色小台阶', '保留 1px 线', '加淡阴影'])
    await send('把深色卡也统一一下')
    await win.locator('.t2c-apv .inquiry-opts .btn').first().waitFor()
    const focused = await until(() => win.evaluate(() => document.activeElement?.closest('.inquiry-opts') ? document.activeElement.textContent.trim() : null))
    check('提问卡出现、输入框空着 → 焦点在第一个选项上', focused === '1. 底色小台阶', focused)
    check('没碰键盘前不出键位提示', await win.locator('.inquiry-keys').count() === 0)
    await win.waitForTimeout(500) // 托盘换卡冷却 350ms(ApprovalTray ARM_MS):冷却期内按键 / 点击一律不送,防连按误答
    await win.keyboard.press('2')
    await until(() => stub.seen.inquiries.length >= 1)
    check('按 2 = 选第二项', stub.seen.inquiries[0]?.answer === '保留 1px 线', stub.seen.inquiries[0])
    await win.waitForTimeout(800)
    ask('q2', ['底色小台阶', '保留 1px 线'])
    await send('再问一次')
    await win.locator('.t2c-apv .inquiry-opts .btn').first().waitFor()
    await until(() => win.evaluate(() => !!document.activeElement?.closest('.inquiry-opts')))
    await win.waitForTimeout(500)
    // 焦点在按钮上时输入法不接管,按键是普通字母(Playwright 的 type 遇到汉字走 insertText、不发 keydown,所以这里打英文)
    await win.keyboard.type('none')
    const free = await win.evaluate(() => ({ value: document.querySelector('.t2c-apv .inquiry-input input')?.value, focus: document.activeElement?.matches('.inquiry-input input'), hint: document.querySelector('.inquiry-keys')?.textContent }))
    check('在选项上打字 → 跳进自由输入、字落进去', free.value === 'none' && free.focus, free)
    check('用过键盘 → 出键位提示', free.hint === '1–2 选一项 · 直接打字 = 其他回答 · ⌘↵ 发出', free.hint)
    await shot('ask-light')
    await win.keyboard.press('Meta+Enter')
    await until(() => stub.seen.inquiries.length >= 2)
    check('⌘↵ 发出自由回答', stub.seen.inquiries[1]?.answer === 'none', stub.seen.inquiries[1])
    await win.waitForTimeout(800)

    // ── 2.4 发送失败留在原地 ──
    refuse = true
    const n0 = runs()
    await send('把第 2 张的圆角改成 12px')
    await win.locator('.t2-userwrap--failed').waitFor()
    const failed = await win.evaluate(() => {
      const w = [...document.querySelectorAll('.t2-userwrap--failed')].pop()
      return { text: w.querySelector('.t2-user')?.textContent.trim(), why: w.querySelector('.t2-failed-why')?.textContent.trim(), title: w.querySelector('.t2-failed-why')?.getAttribute('title'), btns: [...w.querySelectorAll('.t2-failed-btn')].map((b) => b.textContent), ta: document.querySelector('.t2c-ta').value, last: !w.nextElementSibling || !w.nextElementSibling.matches('.t2-userwrap, .t2-asst') }
    })
    check('引擎拒收 → 那条留在末尾、写原因(原文在悬停里)、输入框清空', failed.text === '把第 2 张的圆角改成 12px' && failed.why === '没发出去：引擎拒绝了这次请求' && /engine unreachable/.test(failed.title || '') && failed.ta === '' && failed.last, failed)
    check('只有丢弃 / 重试(不是余量问题,没有「查看余量」)', JSON.stringify(failed.btns) === JSON.stringify(['丢弃', '重试']), failed.btns)
    check('失败那次没进引擎', runs() === n0)
    await shot('fail-light')
    await dark(true); await shot('fail-dark'); await dark(false)
    await win.locator('.t2-userwrap--failed .t2-failed-btn', { hasText: '丢弃' }).click()
    check('丢弃 → 那条没了', await until(() => win.evaluate(() => !document.querySelector('.t2-userwrap--failed'))))
    await send('把第 4 张的描边去掉')
    await win.locator('.t2-userwrap--failed').waitFor()
    refuse = false
    await win.locator('.t2-userwrap--failed .t2-failed-btn', { hasText: '重试' }).click()
    await until(() => runs() > n0)
    check('重试 = 同一段文字发出去', stub.seen.runs[stub.seen.runs.length - 1]?.message === '把第 4 张的描边去掉', stub.seen.runs[stub.seen.runs.length - 1]?.message)
    check('重试成功 → 失败气泡消失', await until(() => win.evaluate(() => !document.querySelector('.t2-userwrap--failed'))))
    console.log(`\n${count} checks passed`)
  } finally { await ctx.close() }
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
