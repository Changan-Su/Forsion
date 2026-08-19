/**
 * **真后端** live 冒烟:真 Electron × 真本地引擎 × 真模型(直连 codex)。
 *
 * 为什么在假引擎之外还要这一条:桩会撒谎。`chat-events.e2e.cjs` 里那串事件是我按理解手写的,
 * 万一真引擎发的字段名/形状与它不一致(比如 context_info 少个键、usage 不带 costLimit),
 * 假引擎全绿而产品是坏的。这条用真引擎跑一句话,专门核**真事件的字段**能不能喂饱 UI。
 *
 * 凭据:不输入任何密码 —— 直接复用本机**已登录**的 `~/.forsion/auth.json`(+ provider-auth/config),
 * 拷进临时共享域;`state.db` 落临时 TANGU_HOME,**不污染真实会话历史**。
 * 会真实消耗一次模型额度(一句话,几百 token)。
 *
 * ⚠️ **状态:未跑通,卡在启动壳**(2026-08-18)。全新 user-data-dir 会弹引导/更新说明覆盖层,
 * 期间输入框与模型药丸恒 disabled;点按钮、轮询、直接写 localStorage 的 onboarding 标记(键名取自
 * OnboardingWizard.tsx)三种法子都没把它送进可交互态。**别再继续瞎点** —— 下一步该先拿观测:
 * 用 `win.screenshot()` + dump Root 的 onboarding/connState,看清到底是引导没关还是引擎没起来
 * (临时 TANGU_HOME 里引擎要冷启动 + 迁移,可能比 60s 还慢)。
 * 真机这条已按用户要求转给 Codex 用 computer use 跑(它更擅长驱动真实界面)。
 *
 * 需先 npm run build。用法:npm run e2e:live [-- --model=<关键字,默认 luna>]
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const REAL_SHARED = path.join(os.homedir(), '.forsion')
const WANT = (process.argv.find((a) => a.startsWith('--model=')) || '--model=luna').split('=')[1]

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  if (!fs.existsSync(path.join(REAL_SHARED, 'auth.json'))) {
    console.error('本机未登录(~/.forsion/auth.json 不在)——先在桌面端登录一次,本脚本不代填密码')
    process.exit(2)
  }
  // 临时共享域:只搬凭据与 provider 配置,不碰 state.db(会话历史留在真家目录里)
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-live-'))
  const home = path.join(shared, 'tangu') // TANGU_HOME 叫 tangu → 共享域=其父目录(见 core/tanguHome.ts)
  fs.mkdirSync(home, { recursive: true })
  for (const f of ['auth.json', 'provider-auth.json', 'config.json']) {
    const src = path.join(REAL_SHARED, f)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(shared, f)) // 只搬运,不读内容
  }

  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(shared, 'userdata')}`, ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home }, // 不设 TANGU_BACKEND_URL → 桌面自己拉起真引擎
  })
  try {
    const win = await app.firstWindow()
    await win.waitForSelector('#root', { timeout: 60_000 })
    // 全新的 user-data-dir = 全新 localStorage → 必定弹引导/更新说明,输入框与药丸全程 disabled。
    // 点按钮不靠谱(覆盖层异步出现、按钮不一定是 <button>),直接把「引导已完成」写进 localStorage 再重载。
    // 键名从 OnboardingWizard.tsx 取(ONBOARDING_DISMISS_KEY / ONBOARDING_VERSION_KEY)。
    await win.evaluate(() => {
      localStorage.setItem('forsion_tangu_onboarding_done', '1')
      localStorage.setItem('forsion_tangu_onboarding_version', '99.9.9')
    }).catch(() => {})
    await win.reload().catch(() => {})
    await win.waitForSelector('#root', { timeout: 60_000 })
    for (let i = 0; i < 40; i++) {
      await win.waitForTimeout(1500)
      const ready = await win.evaluate(() => {
        const ta = document.querySelector('textarea')
        return !!document.querySelector('.dv-groupview') && !!ta && !ta.disabled
      }).catch(() => false)
      if (ready) break
    }
    await win.waitForSelector('.dv-groupview', { timeout: 60_000 })
    // 引擎冷启动(装配 + 迁移)比渲染慢,等它把模型表发过来
    let models = []
    for (let i = 0; i < 40 && !models.length; i++) {
      await win.waitForTimeout(1500)
      models = await win.evaluate(() => {
        try { return (window.__forsionModels || []) } catch { return [] }
      }).catch(() => [])
      if (!models.length) {
        models = await win.evaluate(() => [...document.querySelectorAll('.model-pill-btn')].map((b) => b.textContent || ''))
          .then((x) => (x.length ? x : []))
          .catch(() => [])
      }
    }
    check('L1 真引擎起来了(模型药丸出现)', models.length > 0, JSON.stringify(models).slice(0, 120))

    // 选直连模型:药丸 → 模型面 → 关键字匹配(默认 luna)
    await win.locator('.model-pill-btn').first().click().catch(() => {})
    await win.waitForTimeout(800)
    const modelRow = win.locator('.model-pill-wrap .cm-row', { hasText: '模型' }).first()
    if (await modelRow.count().catch(() => 0)) { await modelRow.hover().catch(() => {}); await win.waitForTimeout(600) }
    const opt = win.locator(`.model-pill-wrap .menu-item:has-text("${WANT}")`).first()
    const picked = await opt.count().catch(() => 0)
    if (picked) { await opt.click().catch(() => {}); await win.waitForTimeout(800) }
    else await win.keyboard.press('Escape').catch(() => {})
    check(`L2 选中直连模型(关键字 ${WANT})`, picked > 0, picked ? '已选中' : '菜单里没找到该模型,退回会话默认模型继续')

    // 发一句极短的话,等真模型回复
    const ta = win.locator('.t2c-ta, textarea').first()
    await ta.click()
    await ta.fill('只回复两个字:收到')
    await win.keyboard.press('Enter')

    let reply = ''
    for (let i = 0; i < 60 && !reply; i++) {
      await win.waitForTimeout(1000)
      reply = await win.evaluate(() => {
        const cols = [...document.querySelectorAll('.t2-asst-col')]
        const last = cols[cols.length - 1]
        return (last?.querySelector('.t2-content')?.textContent || '').trim()
      }).catch(() => '')
    }
    check('L3 真模型回复渲染出来了', reply.length > 0, JSON.stringify(reply.slice(0, 60)))

    // ⭐ 本脚本的真正价值:真引擎发的 context_info 能不能喂饱 UI(假引擎里那串是我手写的)
    const ctx = await win.evaluate(() => {
      const s = window.__forsionStore?.getState?.()
      const info = s && s.ctxInfoBySession ? Object.values(s.ctxInfoBySession)[0] : null
      return info ? { ctxWindow: info.ctxWindow, source: info.ctxWindowSource, sections: (info.sections || []).length, files: (info.files || []).length, thinkingEffective: info.thinkingEffective } : null
    }).catch(() => null)
    let ctxPop = ''
    const ring = win.locator('.t2c-ctxring, [class*="ctxring"]').first()
    if (await ring.count().catch(() => 0)) {
      await ring.hover().catch(() => {})
      await win.waitForTimeout(900)
      ctxPop = await win.locator('[class*="ctxinfo"], .t2c-ctxring-pop').first().textContent().catch(() => '')
    }
    check('L4 ⚠️真引擎的 context_info 字段喂得饱 UI(窗口来源 + 分段)',
      /窗口|token/.test(ctxPop || '') && (ctxPop || '').length > 20,
      `store=${JSON.stringify(ctx)} pop=${JSON.stringify((ctxPop || '').slice(0, 100))}`)

    const usage = await win.evaluate(() => {
      const s = window.__forsionStore?.getState?.()
      const u = s && s.usageBySession ? Object.values(s.usageBySession)[0] : null
      return u ? { ctx: u.ctx, live: u.live, runCost: u.runCost, costLimit: u.costLimit } : null
    }).catch(() => null)
    check('L5 真 usage 事件带上了成本字段(成本闸 UI 的输入)',
      !!usage && (usage.runCost != null || usage.ctx > 0), JSON.stringify(usage))

    await win.screenshot({ path: process.env.LIVE_SHOT || '/tmp/live-chat.png' }).catch(() => {})
  } finally {
    await app.close().catch(() => {})
    fs.rmSync(shared, { recursive: true, force: true }) // 连同拷进去的凭据一起清掉
  }

  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} 通过`)
  process.exit(bad.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
