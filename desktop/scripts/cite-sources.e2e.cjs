/**
 * 搜索来源编号(借鉴 DeepSeek chat-demo 方案 ②A)—— 真 Electron × 桩引擎 × 隔离 home。
 * 会话历史里的 web_search 结果带引擎落库的 metadata.sources(与 tangu-agent tools/webSources.ts 同形),
 * 不注入任何 DOM:编号、来源卡、右栏结果、悬停联动全是产品代码画的。引擎那半(另存来源、给模型的文字不变)由
 * tangu-agent 的 src/tools/webSources.test.ts 钉,本台架只证渲染层。
 *
 *   C1 正文指向来源的链接带号:1 / 2 / 3 / 1(同网址同号),↗ 换成方块(::after content = 号)
 *   C2 悬停第一条链接:出来源卡(站点 · 日期 / 标题 / 被引那句垫底色 / 来源 1)
 *   C3 悬停正文编号 → 右栏第 1 行垫底色;C4 悬停右栏第 2 行 → 正文第 2 条链接垫底色
 *   C5 老消息(没有 metadata.sources):编号照出,悬停退回素卡
 *   拍图:cite-light(对照方案页 c2Ah)/ cite-dark / cite-teal-en
 *
 * 用法(先在本检出 npx electron-vite build):
 *   node ../../.claude/hooks/devlock.cjs run --vehicle=e2e --what="来源编号" --eta=4 -- node scripts/cite-sources.e2e.cjs
 *   SHOTS=<目录> 指定出图位置(缺省 shotDir('cite'))
 */
const fs = require('fs'), path = require('path')
const { launch, boot, enterSpace, shotDir, makeReporter, sleep } = require('./lib/uiux-electron.cjs')

const SID = 'cite-demo', OLD = 'cite-old'
const T = 1794704400000
const SESSION = (id, title) => ({ id, title, summary: '', model_id: 'm1', archived: false, agent_config: null, projectless: true, created_at: '2026-11-15 09:00:00', updated_at: '2026-11-15 09:20:00' })
const SOURCES = [
  { url: 'https://www.hokkaido-ski.jp/niseko/beginner', title: '二世谷新手指南：雪道、雪具与教学', site: 'hokkaido-ski.jp', date: '2026-10-28',
    snippet: '格兰比洛雪场山脚有一条 1.2 公里的缓坡，坡度不超过 8 度，适合第一次上板的人。' },
  { url: 'https://www.rusutsu-resort.com/winter/lessons', title: '留寿都度假村 · 冬季课程', site: 'rusutsu-resort.com', date: '2026-11-02',
    snippet: '中文、英文教练全季可约，半天团体课 9,800 日元起，含雪具租赁。' },
  { url: 'https://travel.example-hokkaido.cn/furano-2026', title: '富良野雪场 2026–27 雪季攻略', site: 'example-hokkaido.cn', date: '2026-11-10',
    snippet: '富良野离旭川机场约 1 小时车程，雪质干，人少，新手道占 40%。' },
]
const searchText = SOURCES.map((s, i) => `${i + 1}. ${s.title}\n  ${s.url}\n  ${s.snippet}`).join('\n')
const A1 = [
  '适合新手的有这三家，都在新雪季（12 月中旬到 3 月）开放：',
  '',
  `1. **二世谷（格兰比洛）**：[山脚有一条 1.2 公里的缓坡，坡度不超过 8 度](${SOURCES[0].url})，第一次上板也能自己滑下来。`,
  `2. **留寿都**：[中文、英文教练全季可约](${SOURCES[1].url})，半天团体课 9,800 日元起，含雪具。`,
  `3. **富良野**：[离旭川机场约 1 小时车程](${SOURCES[2].url})，人比二世谷少，新手道占四成。`,
  '',
  `如果只去一家，我会选二世谷：[缓坡长、教学多](${SOURCES[0].url})，雪场之间也有巴士接驳。`,
].join('\n')
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) }, ui_content_offset: 0 })
const answer = (withMeta) => ({
  id: 'a1', role: 'model', timestamp: T + 38000, content: A1,
  tool_calls: [call('s1', 'web_search', { query: '北海道 新手 滑雪场 2026' })],
  tool_results: [{ tool_call_id: 's1', name: 'web_search', content: `Cite for the user: …\n\nSearch results (Bocha):\n${searchText}`, isError: false, ...(withMeta ? { metadata: { sources: SOURCES } } : {}) }],
})
const messagesFor = (sid) => [
  { id: 'u1', role: 'user', timestamp: T, content: '今年冬天想去北海道滑雪，我是第一次滑，哪几个雪场适合新手？' },
  answer(sid !== OLD),
  { id: 'u2', role: 'user', timestamp: T + 300000, content: '把这三个的交通、雪票和新手道整理成表。' },
  { id: 'a2', role: 'model', timestamp: T + 362000, content: '| 雪场 | 交通 |\n| --- | --- |\n| 二世谷 | 巴士约 3 小时 |' },
]

async function main() {
  const out = process.env.SHOTS || shotDir('cite')
  fs.mkdirSync(out, { recursive: true })
  const r = makeReporter()
  const ctx = await launch({
    tag: 'cite', fixtures: { agents: [], sessions: [SESSION(SID, '北海道新手雪场'), SESSION(OLD, '老会话')] },
    stubOverride: ({ path: p, method }) => { const m = method === 'GET' && /^\/agent\/sessions\/([^/]+)\/messages$/.exec(p); return m ? { messages: messagesFor(decodeURIComponent(m[1])) } : undefined },
  })
  const { win } = ctx
  try {
    await boot(ctx.app, win, { space: 'tangu', width: 1512, height: 950 }); await enterSpace(win, 'tangu')
    const open = async (sid) => {
      const row = win.locator(`.t2s-srow[data-sel-id="${sid}"]`).first(); await row.waitFor({ timeout: 20000 }); await row.click()
      await win.locator('#tocmsg-a1').waitFor({ timeout: 20000 })
      await win.evaluate(() => document.fonts.ready); await sleep(900)
    }
    const look = (mode, skin) => win.evaluate(({ mode, skin }) => {
      const el = document.documentElement; el.dataset.mode = mode; el.classList.toggle('dark', mode === 'dark'); el.dataset.skin = skin; el.dataset.bg = skin
    }, { mode, skin })
    const toA1 = async () => {
      // 往上翻用真滚轮:吸底跟随只认手势松开,程序滚动会被拽回底部
      await win.mouse.move(700, 400); await win.mouse.wheel(0, -4000); await sleep(500)
      await win.evaluate(() => {
        const row = document.querySelector('#tocmsg-a1'); let e = row.parentElement
        while (e && !/(auto|scroll)/.test(getComputedStyle(e).overflowY)) e = e.parentElement
        if (e) e.scrollTop += row.getBoundingClientRect().top - e.getBoundingClientRect().top - 40
      }); await sleep(300)
    }
    const openRail = async () => {
      const card = win.locator('details[data-card="sources"]').first()
      if (await card.count() && !(await card.evaluate((d) => d.open))) { await card.locator('summary').first().click(); await sleep(400) }
    }
    const links = win.locator('#tocmsg-a1 .t2-content a.citelink')
    const hoverLink = async (i) => { await win.mouse.move(1500, 900); await sleep(200); await links.nth(i).hover(); await sleep(900) }

    // ── 新会话:有结构化来源 ──
    await open(SID); await openRail(); await toA1()
    const nums = await links.evaluateAll((as) => as.map((a) => [a.getAttribute('data-cite-n'), getComputedStyle(a, '::after').content]))
    r.check('C1 正文链接带号,同网址同号,::after 画的是号', JSON.stringify(nums) === JSON.stringify([['1', '"1"'], ['2', '"2"'], ['3', '"3"'], ['1', '"1"']]), JSON.stringify(nums))
    await hoverLink(0)
    const card = await win.evaluate(() => {
      const c = document.querySelector('.lcl-hovercard.chat-link-card .chat-link-card-src')
      return c && { site: c.querySelector('.chat-link-card-repo')?.textContent, day: c.querySelector('.chat-link-card-day')?.textContent,
        title: c.querySelector('.chat-link-card-title')?.textContent, mark: c.querySelector('mark')?.textContent, foot: c.querySelector('.chat-link-card-foot')?.textContent }
    })
    r.check('C2 来源卡:站点 · 日期 / 标题 / 被引那句 / 来源 1', !!card && card.site === 'hokkaido-ski.jp' && card.day === '2026-10-28'
      && card.title === SOURCES[0].title && card.mark === '山脚有一条 1.2 公里的缓坡，坡度不超过 8 度' && card.foot === '来源 1 · 点开滚到这句', JSON.stringify(card))
    const railHot = await win.evaluate(() => [...document.querySelectorAll('details[data-card="sources"] .t2-tsum-sub')].map((x) => [x.querySelector('.t2-tsum-n')?.textContent ?? null, x.hasAttribute('data-cite-hot')]))
    r.check('C3 悬停正文第 1 条 → 右栏第 1 行垫底色', JSON.stringify(railHot) === JSON.stringify([['1', true], ['2', false], ['3', false]]), JSON.stringify(railHot))
    await win.screenshot({ path: path.join(out, 'cite-light.png'), scale: 'css' })

    await win.mouse.move(1500, 900); await sleep(300)
    await win.locator('details[data-card="sources"] .t2-tsum-sub').nth(1).hover(); await sleep(300)
    const lit = await links.evaluateAll((as) => as.map((a) => a.getAttribute('data-cite-hot')))
    r.check('C4 悬停右栏第 2 行 → 正文第 2 条链接垫底色', JSON.stringify(lit) === JSON.stringify([null, 'rail', null, null]), JSON.stringify(lit))
    const count = await win.locator('details[data-card="sources"] .t2-card-count, details[data-card="sources"] [class*="count"]').first().textContent().catch(() => null)
    r.note('右栏数字', `右栏「来源」卡上的数字:${count}(搜索词 1 行 + 结果 3 行)`)

    await look('dark', 'cream'); await hoverLink(0)
    await win.screenshot({ path: path.join(out, 'cite-dark.png'), scale: 'css' })
    await look('light', 'teal')
    await win.evaluate(() => localStorage.setItem('tangu_locale', 'en')); await win.reload(); await win.waitForSelector('.dv-groupview', { timeout: 30000 })
    await enterSpace(win, 'tangu'); await open(SID); await look('light', 'teal'); await openRail(); await toA1(); await hoverLink(0)
    const foot = await win.locator('.lcl-hovercard .chat-link-card-foot').textContent().catch(() => null)
    r.check('C2en 英文界面的来源卡脚注', foot === 'Source 1 · opens at this sentence', String(foot))
    await win.screenshot({ path: path.join(out, 'cite-teal-en.png'), scale: 'css' })
    await win.evaluate(() => localStorage.setItem('tangu_locale', 'zh'))

    // ── 老会话:没有 metadata.sources ──
    await win.reload(); await win.waitForSelector('.dv-groupview', { timeout: 30000 }); await enterSpace(win, 'tangu')
    await open(OLD); await look('light', 'cream'); await toA1()
    const oldNums = await links.evaluateAll((as) => as.map((a) => a.getAttribute('data-cite-n')))
    await hoverLink(1)
    const plain = await win.evaluate(() => !!document.querySelector('.lcl-hovercard .chat-link-card-plain') && !document.querySelector('.lcl-hovercard .chat-link-card-src'))
    r.check('C5 老消息:编号照出,悬停退回素卡', JSON.stringify(oldNums) === JSON.stringify(['1', '2', '3', '1']) && plain, `${JSON.stringify(oldNums)} plain=${plain}`)
    await win.screenshot({ path: path.join(out, 'cite-old.png'), scale: 'css' })
  } finally { await ctx.close() }
  console.log(`shots → ${out}`)
  process.exitCode = r.summary() ? 1 : 0
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
