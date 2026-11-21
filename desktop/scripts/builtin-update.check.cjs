/** 内置指令基线(引擎 tangu-agent/src/agents/builtinBaseline.ts)的配置页提示:真 Electron × 桩引擎,不碰用户数据。
 *  盯四件事:① 指令一节上方出提示,新旧默认的差异按行画(FileDiff);② 「保留我的」带着 token POST keep、提示消失;
 *  ③ 「用新默认」先二次确认,确认后 POST adopt、文本框换成新默认;④ 这一页指令还有没保存的修改时不许换新。
 *  顺带拍亮 / 暗 / 英文 / 窄窗四张图(DESIGN §8:几何全绿 ≠ 看起来对,自己看)。
 *  用法(desktop/):先 `npx electron-vite build`(量的是 out/ 产物),再 `npm run check:builtinupdate`;SHOT_DIR 指定截图目录。 */
const assert = require('assert/strict')
const path = require('path')
const { launch, boot, enterSpace, shotDir } = require('./lib/uiux-electron.cjs')

const OLD = ['You are Coding, an app-building partner inside Forsion.', '', 'Work in small, verified steps.', 'State assumptions where things are unclear.', 'Keep the preview running while you edit.'].join('\n')
const NEW = ['You are Coding, an app-building partner inside Forsion.', '', 'Work in small, verified steps.', 'State assumptions where things are unclear; stop and confirm scope before changes over 200 lines.', 'Run one diff self-check before you commit.', 'Keep the preview running while you edit.'].join('\n')
const MINE = `${OLD}\n\nAlways keep a CHANGELOG.md in the project root and answer in Chinese.`
const SOUL = '# Coding\n\nA thoughtful, practical app-building partner.'
const LIB = '/tmp/forsion-builtin-update-lib'
const agent = (slug, name, extra = {}) => ({ slug, name, nameZh: name, nameEn: name, description: '', tools: [], model: '', thinkingLevel: '', maxIterations: null, approvalMode: '', systemPrompt: 'Be precise.', soul: '', createdBy: 'user', version: '1.0.0', libraryDir: path.join(LIB, slug), ...extra })
const AGENTS = [agent('xyra', 'Arioso'), agent('coding', 'Coding', { description: 'Build and refine working web apps with a project brief, live preview, Forsion AI, and verified repairs', systemPrompt: MINE, soul: SOUL, version: '1.4.0' })]
const freshUpdate = (token) => ({ slug: 'coding', toVersion: '1.5.0', token, fields: [{ field: 'systemPrompt', current: MINE, newDefault: NEW, oldDefault: OLD, fromVersion: '1.4.0' }] })

let update = freshUpdate('tok-1')
const posts = []
const handler = async ({ path: p, method, body }) => {
  if (p !== '/agent/agents/coding/builtin-update') return undefined
  if (method === 'GET') return { update }
  const b = await body()
  posts.push(b)
  if (!update || b.token !== update.token) return { __code: 409, body: { detail: 'stale', update } }
  const saved = { ...AGENTS[1], ...(b.action === 'adopt' ? { systemPrompt: NEW, version: '1.5.0' } : {}) }
  AGENTS[1] = saved
  update = null
  return { agent: saved }
}

async function run() {
  const dir = shotDir('builtin-update')
  const ctx = await launch({ tag: 'builtin-update', fixtures: { agents: AGENTS, sessions: [] }, stubOverride: handler })
  const { app, win } = ctx
  const failures = []
  const step = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`) } catch (e) { failures.push(name); console.log(`  ✗ ${name}\n    ${String(e?.message || e).split('\n').slice(0, 4).join('\n    ')}`) } }
  try {
    win.setDefaultTimeout(15000)
    await boot(app, win, { space: 'tangu', width: 1512, height: 950 })
    await win.evaluate(() => localStorage.setItem('tangu_locale', 'zh'))
    const quiet = () => win.evaluate(() => { document.querySelectorAll('.ntf-close').forEach((b) => b.click()) })
    const notice = win.locator('[data-builtin-update]')
    const reload = async () => { await win.reload({ waitUntil: 'domcontentloaded' }); await win.waitForSelector('.dv-groupview', { timeout: 30_000 }); await win.waitForTimeout(1500); await quiet() }
    const openCoding = async () => {
      await enterSpace(win, 'agents'); await win.locator('[data-agents-space]').waitFor()
      await win.locator('.agents-roster-item').filter({ hasText: 'Coding' }).first().click()
      await notice.waitFor(); await notice.evaluate((e) => { e.scrollIntoView({ block: 'start' }); let p = e.parentElement; while (p && p.scrollHeight <= p.clientHeight + 1) p = p.parentElement; if (p) p.scrollTop -= 60 })
      await win.waitForTimeout(500)
    }
    const shot = async (name) => { await quiet(); await win.mouse.move(5, 940); await win.waitForTimeout(400); await win.screenshot({ path: path.join(dir, `${name}.png`) }); console.log(`  shot ${path.join(dir, `${name}.png`)}`) }
    const mode = (m) => win.evaluate((m) => { const r = document.documentElement; r.setAttribute('data-mode', m); r.classList.toggle('dark', m === 'dark') }, m)

    await reload(); await openCoding()
    await step('① 指令一节上方出提示,标题带版本,差异按行画', async () => {
      assert.match(await notice.locator('strong').innerText(), /1\.4\.0 → 1\.5\.0/)
      assert.ok(await notice.locator('.ct-diff tr.del').count() >= 1, '没有删去的行')
      assert.ok(await notice.locator('.ct-diff tr.add').count() >= 2, '新增的两行没画出来')
      const order = await win.evaluate(() => { const n = document.querySelector('[data-builtin-update]'); const ta = n?.closest('.profile-config-group')?.querySelector('.profile-text-editor'); return !!(n && ta && (n.compareDocumentPosition(ta) & Node.DOCUMENT_POSITION_FOLLOWING)) })
      assert.ok(order, '提示不在工作指令编辑框上方')
    })
    await shot('builtin-update-light')
    await mode('dark'); await shot('builtin-update-dark'); await mode('light')

    await step('③ 用新默认先二次确认;返回能退回', async () => {
      await notice.getByRole('button', { name: '用新默认' }).click()
      await notice.getByRole('button', { name: '替换' }).waitFor()
      assert.match(await notice.locator('p').innerText(), /会被替换/)
      assert.equal(posts.length, 0, '确认之前就发了请求')
    })
    await shot('builtin-update-confirm')
    await notice.getByRole('button', { name: '返回' }).click()

    await step('② 保留我的:POST keep + token,提示消失,文本不动', async () => {
      await notice.getByRole('button', { name: '保留我的' }).click()
      await notice.waitFor({ state: 'detached' })
      assert.deepEqual(posts.at(-1), { action: 'keep', token: 'tok-1' })
      const value = await win.locator('.profile-text-editor textarea').first().inputValue()
      assert.equal(value, MINE)
    })

    update = freshUpdate('tok-2'); AGENTS[1] = { ...AGENTS[1], systemPrompt: MINE, version: '1.4.0' }
    await reload(); await openCoding()
    await step('④ 指令有没保存的修改时,用新默认不可点', async () => {
      const box = win.locator('.profile-text-editor textarea').first()
      await box.focus(); await win.keyboard.press('End'); await win.keyboard.type(' draft')
      assert.equal(await notice.getByRole('button', { name: '用新默认' }).isDisabled(), true)
      assert.match(await notice.locator('p').innerText(), /先保存或放弃/)
      assert.equal(await notice.getByRole('button', { name: '保留我的' }).isDisabled(), false)
    })

    await reload(); await openCoding()
    await step('③ 确认替换:POST adopt + token,文本框换成新默认', async () => {
      await notice.getByRole('button', { name: '用新默认' }).click()
      await notice.getByRole('button', { name: '替换' }).click()
      await notice.waitFor({ state: 'detached' })
      assert.deepEqual(posts.at(-1), { action: 'adopt', token: 'tok-2' })
      await win.waitForFunction((v) => document.querySelector('.profile-text-editor textarea')?.value === v, NEW)
    })

    // 没有基线的老用户那一版文案 + 英文 + 窄窗:只拍图,看排版
    update = { slug: 'coding', toVersion: '1.5.0', token: 'tok-3', fields: [{ field: 'systemPrompt', current: MINE, newDefault: NEW, oldDefault: null }, { field: 'soul', current: SOUL, newDefault: `${SOUL}\nValues honest capabilities.`, oldDefault: null }] }
    await win.evaluate(() => localStorage.setItem('tangu_locale', 'en'))
    await reload(); await openCoding()
    await step('无基线文案:标题换成「你的版本和内置指令不一样」(英文),两项各一段差异', async () => {
      assert.match(await notice.locator('strong').innerText(), /differs from the built-in/)
      assert.equal(await notice.locator('.builtin-update-field').count(), 2)
    })
    await shot('builtin-update-unknown-en')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(860, 950)); await win.waitForTimeout(900)
    await notice.scrollIntoViewIfNeeded(); await shot('builtin-update-narrow-en')
  } finally {
    await ctx.close()
  }
  if (failures.length) { console.error(`\n${failures.length} 项没过:${failures.join(' / ')}`); process.exit(1) }
  console.log('\n全部通过')
}
run().catch((e) => { console.error(e); process.exit(1) })
