/**
 * 成就面板 · 云端成就(web harness `harness.html?ach`,真组件 × 真 CSS × 桩 cloudFetch)。
 *
 * 钉住:
 *  ① 左栏分「云端成就 / 本机成就」两组,云端在前;有「达成未领」的云端系列名后有红点;
 *  ② 云端系列标题旁「云端 · 跟账号走」;每行带奖励;已领的写「已在 Mac 上领取」;过期的写「已过期」;
 *  ③ 点「领取」→ POST /achievements/<id>/claim 带设备名 → 换上服务端回的列表:那行变已领、红点灭;
 *  ④ 没登录(缓存里 signedIn=false):进度改按本机计数,「领取」换成「登录后领取」,不亮红点。
 * 截图:os.tmpdir()/forsion-achievements-cloud/(亮 / 暗;DESIGN §8:几何全绿 ≠ 看起来对,自己看)。
 *
 * 跑:node scripts/achievements-cloud.check.cjs(自起一份 vite,端口现找,不借别的检出开着的 5173)
 */
const fs = require('fs')
const os = require('os')
const net = require('net')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')
const { chromium } = require('playwright-core')
const { findChromium } = require('./lib/find-chromium.cjs')

const SHOTS = process.env.SHOT_DIR || path.join(os.tmpdir(), 'forsion-achievements-cloud')
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
const ping = (url) => new Promise((res) => { const r = http.get(url, (x) => { res(x.statusCode === 200); x.resume() }); r.on('error', () => res(false)); r.setTimeout(1500, () => { r.destroy(); res(false) }) })

const def = (o) => ({
  series: 'guide', seriesTitle: { zh: '使用指南', en: 'Guide' }, desc: { zh: '', en: '' }, event: 'space.switch', points: 30,
  reward: [{ kind: 'points', label: { zh: '积分 ×50', en: 'Points ×50' } }], claimUntil: null, expired: false, progress: 0, claimed: null, ...o,
})
const LIST = [
  def({ id: 'g1', title: { zh: '初来乍到', en: 'First steps' }, desc: { zh: '指南 Lv.1 的 9 个任务全部完成', en: 'Finish all 9 tasks in guide Lv.1' }, goal: 1, progress: 1 }),
  def({ id: 'g2', title: { zh: '熟门熟路', en: 'Finding your way' }, desc: { zh: '指南 Lv.2 的 10 个任务全部完成', en: 'Finish all 10 tasks in guide Lv.2' }, goal: 10, progress: 3, points: 40,
    reward: [{ kind: 'custom_item', label: { zh: '头像框「扶桑」 ×1', en: 'Fusang frame ×1' } }] }),
  def({ id: 'g3', title: { zh: '尝鲜', en: 'Early bird' }, desc: { zh: '体验一个新版本里的新功能', en: 'Try something new in this version' }, goal: 1, progress: 1, points: 10, claimed: { device: 'Mac', at: '2026-10-17T10:00:00Z' } }),
  def({ id: 'g4', title: { zh: '限时', en: 'Limited' }, goal: 1, progress: 1, points: 10, expired: true }),
  def({ id: 'c1', series: 'cloud', seriesTitle: { zh: 'Forsion 云端', en: 'Forsion Cloud' }, title: { zh: '云上有我', en: 'Up in the cloud' }, event: 'chat.send', goal: 5, progress: 2, reward: null }),
]
const claimedList = () => LIST.map((a) => (a.id === 'g1' ? { ...a, claimed: { device: 'Mac', at: '2026-10-18T00:00:00Z' } } : a))

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true })
  const port = await freePort()
  const base = `http://127.0.0.1:${port}/harness.html`
  const vite = spawn('npx', ['vite', 'frontend', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: path.resolve(__dirname, '..'), stdio: 'ignore' })
  const browser = await chromium.launch({ executablePath: findChromium() })
  try {
    let up = false
    for (let i = 0; i < 60 && !up; i++) { up = await ping(base); if (!up) await new Promise((r) => setTimeout(r, 500)) }
    if (!up) throw new Error('vite 起不来')

    async function open({ signedIn = true, dark = false } = {}) {
      // 钉中文(浏览器台架的 --lang 无效,走 newPage 的 locale)
      const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1100, height: 720 }, reducedMotion: 'reduce' })
      const errors = []
      page.on('pageerror', (e) => errors.push(e.message))
      await page.addInitScript(({ list, signedIn, claimed }) => {
        localStorage.setItem('forsion_tangu_achievements', JSON.stringify({ v: 1, counters: { 'chat.send': 3, 'space.switch': 1 }, claimed: [] }))
        localStorage.setItem('forsion_cloud_achievements', JSON.stringify({ signedIn, list: signedIn ? list : list.map((a) => ({ ...a, progress: 0, claimed: null })) }))
        window.__calls = []
        window.tangu = {
          platform: 'darwin',
          cloudFetch: async (req) => {
            window.__calls.push(req)
            if (!signedIn) return { status: 401, error: 'not_signed_in' }
            if (/\/claim$/.test(req.path)) return { status: 200, json: { claimed: true, alreadyClaimed: false, achievements: claimed } }
            return { status: 200, json: { achievements: window.__claimedYet ? claimed : list } }
          },
        }
      }, { list: LIST, signedIn, claimed: claimedList() })
      await page.goto(base + '?ach' + (dark ? '&dark' : ''))
      await page.locator('.settings-page').waitFor({ timeout: 60000 }) // 第一次打开要等 vite 现编
      await page.waitForTimeout(300)
      return { page, errors }
    }

    // ── 已登录 ──
    const { page, errors } = await open()
    const nav = await page.evaluate(() => [...document.querySelectorAll('.settings-nav-group')].map((g) => ({
      head: g.querySelector('.settings-nav-grouphead').textContent,
      items: [...g.querySelectorAll('button')].map((b) => ({ text: b.textContent, dot: !!b.querySelector('.ach-dot'), active: b.classList.contains('active') })),
    })))
    check('左栏两组:云端成就在前(使用指南 / Forsion 云端),本机成就在后', nav[0]?.head === '云端成就' && nav[0].items.map((i) => i.text).join('|') === '使用指南|Forsion 云端' && nav[1]?.head === '本机成就', JSON.stringify(nav))
    check('有「达成未领」的云端系列名后有红点,没有的不亮;默认打开第一个云端系列', nav[0]?.items[0]?.dot && !nav[0]?.items[1]?.dot && nav[0]?.items[0]?.active, JSON.stringify(nav[0]))
    const main = await page.locator('.settings-main').innerText()
    check('系列标题旁「云端 · 跟账号走」', main.includes('云端 · 跟账号走'))
    check('行尾:奖励、已在 Mac 上领取、已过期、进度', main.includes('积分 ×50') && main.includes('头像框「扶桑」 ×1') && main.includes('已在 Mac 上领取') && main.includes('已过期') && main.includes('3/10'), main.slice(0, 400))
    check('只有达成未领的那条有「领取」', await page.locator('.ach-claim').count() === 1)
    await page.screenshot({ path: path.join(SHOTS, 'cloud-light.png') })

    await page.evaluate(() => { window.__claimedYet = true })
    await page.locator('.ach-claim').click()
    await page.waitForFunction(() => !document.querySelector('.ach-claim'), null, { timeout: 5000 }).catch(() => {})
    const claim = await page.evaluate(() => window.__calls.find((c) => /\/claim$/.test(c.path)))
    check('领取 → POST /achievements/g1/claim 带设备名 Mac', claim && claim.method === 'POST' && claim.path === '/achievements/g1/claim' && claim.body.device === 'Mac', JSON.stringify(claim))
    const after = await page.evaluate(() => ({ claimBtns: document.querySelectorAll('.ach-claim').length, dot: !!document.querySelector('.settings-nav-group:first-child .ach-dot'), text: document.querySelector('.settings-main').innerText }))
    // 红点只看云端组(本机「对话」那颗是本机计数亮的)
    check('领完:那行变已领(两条「已在 Mac 上领取」)、红点灭', after.claimBtns === 0 && !after.dot && after.text.split('已在 Mac 上领取').length === 3, JSON.stringify({ ...after, text: after.text.slice(0, 200) }))
    check('无页面错误', errors.length === 0, errors.join(' / '))
    await page.close()

    // ── 没登录 ──
    const out = await open({ signedIn: false })
    const outText = await out.page.locator('.settings-main').innerText()
    check('没登录:「领取」换成「登录后领取」、进度按本机计数、不亮红点',
      outText.includes('登录后领取') && await out.page.locator('.ach-claim').count() === 0 && outText.includes('1/1') && !(await out.page.locator('.settings-nav-group:first-child .ach-dot').count()), outText.slice(0, 300))
    await out.page.locator('.settings-nav-group button', { hasText: 'Forsion 云端' }).click()
    check('没登录:云端系列进度 = 本机累计(chat.send 3/5)', (await out.page.locator('.settings-main').innerText()).includes('3/5'))
    await out.page.close()

    // ── 暗色截图 ──
    const dk = await open({ dark: true })
    await dk.page.screenshot({ path: path.join(SHOTS, 'cloud-dark.png') })
    await dk.page.locator('.settings-nav-group button', { hasText: '对话' }).click()
    await dk.page.screenshot({ path: path.join(SHOTS, 'local-dark.png') })
    await dk.page.close()
  } finally {
    await browser.close()
    vite.kill()
  }
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} 通过 · 截图在 ${SHOTS}`)
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
