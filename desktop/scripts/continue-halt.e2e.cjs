/**
 * 停在半截、但不是出错的两种(2026-11-15,借鉴 DeepSeek chat-demo 方案 ①):写到输出上限 / 用户按了停止。
 * 真 Electron × 真 Chat View × 可编剧假引擎:
 *   ① done 带 truncated → 回答下面「停在了半句」+「继续生成 / 重新生成」;点「继续生成」发出去的是 length 那句 <turn_resume>
 *   ② done 只带 lengthResumed → 一行「自动接着写了一次」,没有继续按钮
 *   ③ 老引擎的 done(两样都不带)→ 什么都不多画
 *   ④ 用户按停止 →「⏹ 已停止」下面有「继续生成」;点了发出去的是 stopped 那句
 * 需先 npm run build。用法:npm run e2e:continue-halt(本机有 GUI 锁时套 devlock run)。
 * 负对照:把 EditorialMessage 里 <HaltRow …/> 换回原来那行「⏹ 已停止」→ ① ④ 红。
 */
const fs = require('fs')
const path = require('path')
const { launch, boot, enterSpace } = require('./lib/uiux-electron.cjs')

const ROOT = path.join(__dirname, '..')
const SHOT = process.env.SHOT_DIR || path.join(require('os').tmpdir(), 'continue-halt-shots')
fs.mkdirSync(SHOT, { recursive: true })
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}
const SESSION = { id: 's1', title: '截断续写', summary: '', model_id: 'm1', archived: false, agent_config: null, projectless: true, created_at: '2026-11-15 09:00:00', updated_at: '2026-11-15 09:00:00' }
const CUT = '第 4 天：从二世谷坐巴士到留寿都，中午前到，下午'

async function send(win, text) {
  const ta = win.locator('.t2c-ta').first()
  for (let i = 0; i < 40; i++) { if (await ta.isEnabled().catch(() => false)) break; await win.waitForTimeout(500) }
  await ta.click(); await ta.fill(text); await win.keyboard.press('Enter')
}
const lastAnswer = (win) => win.locator('.t2-asst').last()

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) { console.error('缺 out/main/main.js —— 先跑 npm run build'); process.exit(1) }
  const ctx = await launch({ tag: 'continue-halt', fixtures: { agents: [], sessions: [SESSION] }, messages: [] })
  const { win, stub } = ctx
  try {
    await boot(ctx.app, win, { space: 'tangu', width: 1512, height: 950 }); await enterSpace(win, 'tangu')
    await win.locator('.t2s-srow[data-sel-id="s1"]').first().click()
    await win.waitForTimeout(800)

    // ① 截断
    stub.script([{ type: 'token', payload: { delta: CUT } }, { type: 'done', payload: { content: CUT, toolOffsets: [], truncated: true, lengthResumed: true } }])
    await send(win, '排一个 5 天行程')
    const halt = win.locator('[data-halt="length"]').last()
    await halt.waitFor({ timeout: 8000 }).catch(() => {})
    check('① 截断:回答下面有「停在了半句」', await halt.isVisible().catch(() => false), await halt.textContent().catch(() => ''))
    check('① 截断:不再另画「自动接着写」那行', !(await lastAnswer(win).textContent()).includes('自动接着写了一次'))
    const cont = lastAnswer(win).locator('[data-testid="msg-continue"]')
    const regen = lastAnswer(win).locator('[data-testid="msg-retry"]')
    check('① 截断:有「继续生成」和「重新生成」', (await cont.count()) === 1 && (await regen.count()) === 1)
    await win.waitForTimeout(1500) // 发送的飞行动画落定再拍,否则回答还没进画面
    await win.screenshot({ path: path.join(SHOT, 'truncated.png') })
    const before = stub.seen.runs.length
    stub.script([{ type: 'done', payload: { content: '上第二节课。', toolOffsets: [] } }])
    await cont.click().catch(() => {})
    await win.waitForTimeout(1500)
    const sent = String(stub.seen.runs[before]?.message || '')
    check('① 点「继续生成」发出 length 那句', sent.startsWith('<turn_resume>') && sent.includes('output length limit'), sent.slice(0, 90))

    // ② 自动接过一次、写完了
    stub.script([{ type: 'token', payload: { delta: '写完了。' } }, { type: 'done', payload: { content: '写完了。', toolOffsets: [], lengthResumed: true } }])
    await send(win, '再来一段')
    await win.waitForTimeout(1800)
    const txt2 = await lastAnswer(win).textContent()
    check('② 自动接过:有「自动接着写了一次」', txt2.includes('自动接着写了一次'))
    check('② 自动接过:没有继续按钮', (await lastAnswer(win).locator('[data-testid="msg-continue"]').count()) === 0)

    // ③ 老引擎的 done
    stub.script([{ type: 'token', payload: { delta: '普通回答。' } }, { type: 'done', payload: { content: '普通回答。', toolOffsets: [] } }])
    await send(win, '普通一句')
    await win.waitForTimeout(1800)
    const txt3 = await lastAnswer(win).textContent()
    check('③ 普通收尾:什么都不多画', !txt3.includes('自动接着写') && !txt3.includes('停在了半句') && (await lastAnswer(win).locator('[data-testid="msg-continue"]').count()) === 0)

    // ④ 用户停下
    stub.script([{ type: 'token', payload: { delta: '写到一半，' } }, { type: '__hold' }])
    await send(win, '写长一点')
    await win.waitForTimeout(1200)
    await win.locator('.t2c-stop').first().click().catch(() => {})
    const stopped = win.locator('[data-halt="stopped"]').last()
    await stopped.waitFor({ timeout: 12000 }).catch(() => {})
    check('④ 停下:「⏹ 已停止」还在', await stopped.isVisible().catch(() => false))
    const cont4 = lastAnswer(win).locator('[data-testid="msg-continue"]')
    check('④ 停下:有「继续生成」', (await cont4.count()) === 1)
    await win.screenshot({ path: path.join(SHOT, 'stopped.png') })
    const before4 = stub.seen.runs.length
    stub.script([{ type: 'done', payload: { content: '接着写完。', toolOffsets: [] } }])
    await cont4.click().catch(() => {})
    await win.waitForTimeout(1500)
    const sent4 = String(stub.seen.runs[before4]?.message || '')
    check('④ 点「继续生成」发出 stopped 那句', sent4.includes('The user stopped your previous response'), sent4.slice(0, 90))
  } finally {
    await ctx.close()
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} PASS · 截图 ${SHOT}`)
  process.exitCode = failed.length ? 1 : 0
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
