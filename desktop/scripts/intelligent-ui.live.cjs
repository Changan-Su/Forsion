/** Ordinary user journeys: compiled Electron -> real standalone -> the model the harness was given.
 * Run through live-harness --only intelligentusers; no stub, route fulfillment or document injection.
 * Setup creates empty sessions only. Every model request originates from an actual composer/button.
 * The first five journeys are the fixed acceptance set. --intelligent-random <seed>:<slot> instead draws
 * one journey of each kind (pick / list / compare) from the whole pool; two slots never share a journey. */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const electron = require('./lib/launch-electron.cjs')
const { enterSpace } = require('./lib/uiux-electron.cjs')
const ROOT = path.resolve(__dirname, '..')
const OUT = process.env.TANGU_IUI_OUT, base = process.env.TANGU_BACKEND_URL, token = process.env.TANGU_IUI_TOKEN
const MODEL = process.env.TANGU_IUI_MODEL, workspace = process.env.TANGU_IUI_WORKSPACE
const imageBase = 'https://cdn.jsdelivr.net/gh/sachinchoolur/lightGallery@9813e97837fddca82e4734bcbf4b77b0cd227772/site/static/images/demo/'
const img = n => `${imageBase}${n}-480.jpg`
const cases = [
  { key: 'user-dinner', kind: 'compare', name: '朋友聚餐：改人数、换菜、采购量联动', preset: 'chat', prompt: '周六请朋友来家里吃饭，暂定4个人，可能增加到6个。我想在咖喱鸡、番茄炖牛肉、香菇豆腐里挑一个主菜，再配西兰花和拍黄瓜。帮我安排一下。我想自己切换主菜和人数，买菜用量能跟着变，买完的东西可以打勾。用量按家常估算即可。' },
  { key: 'user-moving', kind: 'list', name: '搬宿舍：逐项勾选、复制与刷新恢复', preset: 'chat', prompt: '下周我要搬宿舍，一个人、两个行李箱，没有车。从今天到搬完，帮我整理一份实用的待办清单，分成提前准备、搬家当天、入住以后。我想做完一项就勾掉一项，还能复制发给家人。控制在12项左右，不需要替我设提醒或联系别人。' },
  { key: 'user-study', kind: 'list', name: '复习计划：真实追问、调整约束', preset: 'chat', prompt: '我还有一周考线性代数，矩阵运算还行，特征值和特征向量很不熟。每天能学40分钟，帮我安排7天复习，任务要具体，做完能勾掉。最后给我一个继续细化第一天练习的入口，我想先看总体再决定。' },
  { key: 'user-photos', kind: 'pick', images: [1, 4, 13], name: '旅行相册封面：实际看图、并列查看和放大', prompt: `我想给旅行相册挑一张安静、适合放标题的封面。这三张是候选：${[1, 4, 13].map(img).join(' ，')}。帮我看看哪张合适，把图片放在一起方便比较，能点开放大，我想自己选。说清各自适合把标题放哪里，附上来源。` },
  { key: 'user-research', kind: 'compare', name: '选笔记工具：官方网页检索、摘要与来源', prompt: '我在选个人笔记工具，主要写中文学习笔记，经常离线，希望以后能方便导出。请查 Obsidian 和 Notion 的官方资料，按离线使用、数据存放、导出格式比较一下，给一个建议。把依据的网页放在回答里，摘要可以展开，我想点开核实。不要只凭旧印象回答，不用查价格。' },
  // Pool only: drawn by --intelligent-random, never part of the fixed five.
  { key: 'user-poster', kind: 'pick', images: [2, 4, 13], pool: true, name: '读书会海报底图：实际看图、三选一', prompt: `社团下周办读书会，我要做一张竖版海报，标题字比较多。这三张图想挑一张当底图：${[2, 4, 13].map(img).join(' ，')}。帮我看看每张压上标题会不会乱，放在一起让我自己选，能点开看大图。图是从 https://github.com/sachinchoolur/lightGallery 拿的，注明一下出处。` },
  { key: 'user-wallpaper', kind: 'pick', images: [1, 2, 4, 13], pool: true, name: '电脑壁纸：四张里挑一张', prompt: `我想换电脑壁纸，桌面左边会放两列图标。这四张里帮我挑：${[1, 2, 4, 13].map(img).join(' ，')}。看看哪张左边比较干净、图标不会看不清，把四张摆在一起我自己定，想放大看细节。图片来源是 https://github.com/sachinchoolur/lightGallery 。` },
  { key: 'user-trip', kind: 'list', min: 8, pool: true, name: '带爸妈短途出行：行李逐项勾选、复制', preset: 'chat', prompt: '周末带爸妈去苏州玩两天一夜，高铁往返，住一晚酒店。帮我列一份出发前要收拾的东西，分成证件和票、衣物洗漱、给爸妈带的药和零食。我想收拾好一样勾一样，还能复制发到家庭群里。10 到 14 项就够，不用帮我订票。' },
  { key: 'user-party', kind: 'list', min: 8, pool: true, name: '给同事办生日会：准备事项逐项勾选', preset: 'chat', prompt: '周五下班后在公司会议室给同事小林过生日，大概 10 个人，预算 300 块以内。帮我把要准备的事排一下：前两天订什么买什么、当天下午布置什么、结束后收拾什么。做完一件勾一件，清单能复制给一起帮忙的同事。' },
  { key: 'user-commute', kind: 'compare', pool: true, name: '三种通勤方式：自己切换看差别', preset: 'chat', prompt: '我下个月换到新公司，家到公司大概 9 公里。骑电动车、地铁加步行、自己开车这三种我都行，帮我比一比时间稳不稳、每月大概花多少、下雨天麻不麻烦，按一般城市的情况估算就行，不用查实时数据。我想自己点着切换，看每种方式分别要提前准备什么。' },
  { key: 'user-gym', kind: 'compare', pool: true, name: '健身安排：每周几练自己切换', preset: 'chat', prompt: '我想开始规律健身，纯新手，只有哑铃和瑜伽垫。每周练 3 次还是 4 次我还没想好，帮我各排一版一周的安排，我想自己切换着对比，每次练什么要具体，练完能勾掉。再简单说说两种安排各自适合什么情况。' },
]
let selectedKeys = process.env.TANGU_IUI_CASES ? process.env.TANGU_IUI_CASES.split(',').filter(Boolean) : null
let draw = null
if (process.env.TANGU_IUI_RANDOM) {
  const [seed, slot] = process.env.TANGU_IUI_RANDOM.split(':').map(Number)
  assert.ok(Number.isInteger(seed) && Number.isInteger(slot) && slot >= 0, 'Use --intelligent-random <seed>:<slot>')
  let a = seed >>> 0
  const rand = () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 }
  const order = Object.fromEntries(['pick', 'list', 'compare'].map(kind => {
    const keys = cases.filter(c => c.kind === kind).map(c => c.key)
    for (let i = keys.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [keys[i], keys[j]] = [keys[j], keys[i]] }
    return [kind, keys]
  }))
  selectedKeys = Object.values(order).map(keys => keys[slot % keys.length])
  draw = { seed, slot, order, picked: selectedKeys }
} else if (!selectedKeys) selectedKeys = cases.filter(c => !c.pool).map(c => c.key)
{
  assert.ok(selectedKeys.length && selectedKeys.every(k => cases.some(c => c.key === k)), 'Unknown user journey')
  for (let i = cases.length - 1; i >= 0; i--) if (!selectedKeys.includes(cases[i].key)) cases.splice(i, 1)
}
async function api(route, method = 'GET', body) {
  const r = await fetch(base + route, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const value = await r.json(); assert.ok(r.ok, `${route}: ${r.status}`); return value
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const parse = value => { try { return typeof value === 'string' ? JSON.parse(value) : value } catch { return null } }
const succeeded = receipt => !receipt.isError && receipt.success !== false && !/^Error:/i.test(receipt.result) && parse(receipt.result)?.success !== false
const official = (url, domain) => { try { const host = new URL(url).hostname; return host === domain || host.endsWith(`.${domain}`) } catch { return false } }
function inspectionCoverage(ev) {
  let currentUrl
  const screenshots = new Map(), viewed = new Set()
  for (const receipt of ev.results) {
    const call = ev.calls.find(c => c.id === receipt.id), args = parse(call?.arguments) || {}, data = parse(receipt.result)
    if (receipt.name === 'browser_navigate') currentUrl = succeeded(receipt) ? data?.url : undefined
    if (!succeeded(receipt)) continue
    if (receipt.name === 'browser_screenshot' && currentUrl && data?.screenshot_path) screenshots.set(data.screenshot_path, currentUrl)
    if (receipt.name === 'view_image' && screenshots.has(args.path)) viewed.add(screenshots.get(args.path))
  }
  return [...viewed]
}
async function observeRun(runId) {
  const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 300000)
  const evidence = { runId, calls: [], results: [], content: '', done: false, usages: [], tools: [], statuses: [] }
  try {
    const r = await fetch(`${base}/agent/runs/${runId}/events`, { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal })
    assert.ok(r.ok && r.body, 'Real engine event stream opens')
    let buf = ''; const decoder = new TextDecoder()
    for await (const chunk of r.body) {
      buf += decoder.decode(chunk, { stream: true })
      let pos
      while ((pos = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, pos); buf = buf.slice(pos + 2)
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          const e = JSON.parse(line.slice(5)), p = e.payload || {}
          if (e.type === 'tool_call') { evidence.calls.push(p); evidence.tools.push(p.name) }
          if (e.type === 'tool_result') evidence.results.push({ id: p.id, name: p.name, isError: !!p.isError, success: parse(p.result)?.success, result: String(p.result || '').slice(0, 16000) })
          if (e.type === 'usage') evidence.usages.push(p)
          if (e.type === 'approval_request' || e.type === 'inquiry_request') evidence.statuses.push({ type: e.type, payload: p })
          if (e.type === 'done') { evidence.done = true; evidence.content = p.content || ''; return evidence }
          if (e.type === 'error') { evidence.error = p.error; return evidence }
        }
      }
    }
    evidence.error = 'Stream ended without done'
  } catch (e) {
    evidence.error = String(e.message)
    if (ac.signal.aborted) await api(`/agent/runs/${runId}/abort`, 'POST', {}).catch(() => {})
  } finally { clearTimeout(timer); ac.abort() }
  return evidence
}
async function main() {
  assert.ok(OUT && base && token && MODEL, 'Use the real live harness')
  const home = path.join(OUT, 'intelligent-ui-shell'), shots = path.join(OUT, 'intelligent-ui-shots')
  fs.mkdirSync(shots, { recursive: true })
  for (const dir of [path.join(home, 'userdata'), path.join(home, 'userdata-dev')]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: base, token, defaultWorkspaceDir: workspace }))
  }
  for (const c of cases) {
    const config = c.preset ? { preset: c.preset, execMode: 'sandbox' } : { execMode: 'host', cwd: workspace }
    c.sid = (await api('/agent/sessions', 'POST', { title: `ZZ-IUI ${c.name}`, model_id: MODEL, project_path: workspace, project_name: '真实用户验收', agent_config: config })).session.id
  }
  const report = { model: MODEL, transport: 'real Electron composer and native actions', draw, startedAt: new Date().toISOString(), results: [] }
  const save = () => fs.writeFileSync(path.join(OUT, 'intelligent-users-evidence.json'), JSON.stringify(report, null, 2))
  let app, win
  const requests = [], pageErrors = []
  try {
    app = await electron.launch({ args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: path.join(home, 'shell'), TANGU_BACKEND_URL: base } })
    win = await app.firstWindow(); win.setDefaultTimeout(20000)
    win.on('pageerror', e => pageErrors.push(String(e)))
    win.on('request', r => { if (r.method() === 'POST' && /\/agent\/runs$/.test(r.url())) requests.push(r.postDataJSON()) })
    await win.waitForSelector('#root')
    await win.evaluate(() => { localStorage.setItem('tangu_locale', 'zh'); localStorage.setItem('forsion_theme_pref', 'light'); localStorage.setItem('forsion_default_space', 'tangu'); localStorage.setItem('forsion_tangu_onboarding_done', '1'); localStorage.setItem('builtin.browser.inAppLinks', '1') })
    await win.reload(); await win.waitForTimeout(1800)
    for (const label of ['跳过引导', 'Skip']) { const b = win.getByText(label, { exact: true }); if (await b.count()) { await b.first().click(); break } }
    await win.waitForSelector('.dv-groupview:visible'); await enterSpace(win, 'tangu')
    async function open(c) {
      if (!(await win.locator('.t2s-srow').first().isVisible().catch(() => false))) await win.locator('.dv-edge-left').click()
      await win.locator(`.t2s-srow[data-sel-id="${c.sid}"]`).first().click()
      await win.locator('.t2c-ta').first().waitFor()
    }
    async function turn(c, result, prompt, click) {
      const t0 = Date.now(), response = win.waitForResponse(r => /\/agent\/runs$/.test(r.url()) && r.request().method() === 'POST', { timeout: 30000 })
      if (click) await click()
      else { const ta = win.locator('.t2c-ta').first(); await ta.fill(prompt); await ta.press('Enter') }
      const res = await response, req = res.request().postDataJSON()
      assert.equal(req.model_id, MODEL, 'Actual composer selected the requested model')
      assert.ok(req.client_capabilities.includes('intelligent-ui.v1'), 'Actual client advertises native UI')
      const { runId } = await res.json(), ev = await observeRun(runId)
      const docs = ev.calls.filter(x => x.name === 'intelligent_ui').flatMap(x => { try { const a = typeof x.arguments === 'string' ? JSON.parse(x.arguments) : x.arguments; return [JSON.parse(a.document)] } catch { return [] } })
      result.turns.push({ prompt: req.message, client: req.client, model: req.model_id, preset: req.agent_config?.preset || 'work', ms: Date.now() - t0, documents: docs, ...ev })
      save()
      assert.ok(ev.done && !ev.error, `Model completed: ${ev.error || ''}`)
      assert.ok(!/"blocks"\s*:|"document"\s*:/.test(ev.content), 'No raw UI JSON in prose')
      await win.waitForTimeout(700)
      return { ev, docs }
    }
    async function screenshot(c, suffix, doc) {
      const scroller = win.locator('.t2-stream').first(), box = await scroller.boundingBox()
      await win.mouse.move(box.x + box.width / 2, box.y + 150); await win.mouse.wheel(0, -800); await win.waitForTimeout(300)
      const target = doc || win.locator('.intelligent-ui').last()
      if (await target.count()) await target.locator('.iui-title').evaluate(el => el.scrollIntoView({ block: 'start', behavior: 'instant' }))
      await win.waitForTimeout(250)
      await win.screenshot({ path: path.join(shots, `${c.key}-${suffix}.png`) })
    }
    // The composer floats over the bottom of the stream; bring a target to the middle before clicking it.
    const center = async target => { await target.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' })); await win.waitForTimeout(150) }
    for (const c of cases) {
      const t0 = Date.now(), r = { key: c.key, name: c.name, prompt: c.prompt, ok: false, turns: [], checks: [], sessionId: c.sid }
      report.results.push(r); console.log(`START ${c.key}`); save()
      const check = (label, value) => { r.checks.push({ label, ok: !!value }); assert.ok(value, label) }
      try {
        await open(c)
        const { ev, docs } = await turn(c, r, c.prompt)
        const ui = win.locator('.intelligent-ui').last()
        check('普通提问产生可操作的原生回答', docs.length > 0 && await ui.count() > 0)
        check('原生文档完整呈现', await ui.getAttribute('data-complete') === 'true')
        await screenshot(c, 'initial', ui)
        const before = requests.length
        if (c.key === 'user-dinner') {
          const number = ui.locator('.iui-number').first(), output = number.locator('output')
          const n0 = Number(await output.innerText()), quantities = await ui.locator('.iui-quantity').allTextContents()
          check('默认人数与可缩放食材', n0 === 4 && quantities.length > 0)
          for (let i = 0; i < 10 && Number(await output.innerText()) < 6; i++) await number.getByRole('button').last().click()
          const scaled = await ui.locator('.iui-quantity').allTextContents(), amount = s => Number(s.replace(/,/g, '').match(/[\d.]+/)?.[0])
          check('4改6人后所有食材按1.5倍缩放', Number(await output.innerText()) === 6 && scaled.length === quantities.length && scaled.every((s, i) => Math.abs(amount(s) - amount(quantities[i]) * 1.5) < 0.11))
          const rows = await ui.locator('.iui-check-rows').allTextContents()
          await ui.getByRole('radio').last().check()
          check('切换主菜后采购内容变化', JSON.stringify(rows) !== JSON.stringify(await ui.locator('.iui-check-rows').allTextContents()))
          await ui.getByRole('checkbox').first().check()
        } else if (c.kind === 'list' && c.key !== 'user-study') {
          check('清单任务数量合理', await ui.getByRole('checkbox').count() >= (c.min || 10))
          if (c.key === 'user-moving') check('待办按单列排列便于顺序阅读', await ui.locator('.iui-check-rows').first().evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length === 1))
          await ui.getByRole('checkbox').nth(0).check(); await ui.getByRole('checkbox').nth(1).check()
          r.clipboard = []
          const lists = ui.locator('.iui-checklist')
          for (let i = 0; i < await lists.count(); i++) {
            const list = lists.nth(i), labels = await list.locator('.iui-check-rows label > span:first-of-type').allTextContents()
            await list.getByRole('button', { name: '复制清单', exact: true }).click()
            let clip = ''
            for (let tries = 0; tries < 25; tries++) {
              clip = await app.evaluate(({ clipboard }) => clipboard.readText())
              if (labels.every(label => clip.includes(label))) break
              await sleep(100)
            }
            r.clipboard.push(clip)
            check(`第${i + 1}组复制包含全部事项`, labels.length > 0 && labels.every(label => clip.includes(label)))
          }
          check('复制保留完成状态', r.clipboard.join('\n').includes('☑'))
          await win.reload(); await open(c)
          check('刷新后保留两项勾选', await win.locator('.intelligent-ui input[type=checkbox]:checked').count() === 2)
        } else if (c.key === 'user-study') {
          check('复习任务可勾选', await ui.getByRole('checkbox').count() >= 7)
          check('学习任务按单列排列', await ui.locator('.iui-check-rows').first().evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length === 1))
          await ui.getByRole('checkbox').first().check()
          const originalId = await ui.getAttribute('data-document-id')
          const action = ui.locator('.iui-actions button').filter({ hasNotText: /复制/ }).first()
          check('存在继续细化的入口', await action.count() > 0)
          await turn(c, r, null, () => action.click())
          check('卡内追问真实进入新模型轮次', requests.length === before + 1)
          const revision = await turn(c, r, '计划要改一下：周三完全没时间，其他六天每天只有20分钟。第一天的练习我已经完成了，请据此重新安排剩下的复习。不要增加总时长。')
          check('多轮修改后仍有可读答复', await win.locator('.t2-asst-col').last().innerText().then(t => t.length > 50))
          check('后续回复不清掉原回答已勾任务', await win.locator(`[data-document-id="${originalId}"] input[type=checkbox]`).first().isChecked())
          check('新清单不把已完成事项变成未勾待办', revision.docs.every(d => d.blocks.filter(b => b.kind === 'checklist').every(b => !/已完成/.test(b.title || '') && b.items.every(i => !/^已完成/.test(i.label)))))
        } else if (c.kind === 'pick') {
          const expectedImages = c.images.map(img), n = expectedImages.length
          await win.waitForFunction(n => { const imgs = [...document.querySelectorAll('.intelligent-ui img')]; return imgs.length >= n && imgs.every(i => i.complete && i.naturalWidth > 0) }, n, { timeout: 30000 })
          const renderedImages = await ui.locator('img').evaluateAll(imgs => imgs.map(i => i.src))
          r.renderedImageUrls = renderedImages
          check('原始候选图全部加载成功且没有替换', new Set(renderedImages).size === n && expectedImages.every(url => renderedImages.includes(url)) && renderedImages.every(url => expectedImages.includes(url)))
          const cards = ui.locator('.iui-pick-card'), radios = ui.getByRole('radio')
          check('候选图并成一排可选图卡，同一张图不重复出现', await cards.count() === n && renderedImages.length === n)
          await center(cards.last()); await cards.last().click()
          check('点图卡就是选它', await radios.last().isChecked() && await cards.last().getAttribute('data-selected') !== null)
          await center(cards.first()); await cards.first().hover(); await cards.first().getByRole('button', { name: '展开原图', exact: true }).click()
          check('放大看图不改变选择', await ui.locator('.iui-pick-card[data-expanded]').count() === 1 && await radios.last().isChecked())
          await screenshot(c, 'expanded', ui)
          await center(cards.first()); await cards.first().getByRole('button', { name: '收起原图', exact: true }).click()
          // Last on purpose: a model that skipped looking must not hide how the answer rendered.
          r.inspectedImageUrls = inspectionCoverage(ev)
          check('每张候选图都有导航、截图及实际看图回执', expectedImages.every(url => r.inspectedImageUrls.includes(url)))
        } else if (c.kind === 'compare' && c.pool) {
          const radios = ui.getByRole('radio')
          check('有可以自己切换的选项', await radios.count() >= 2)
          const shown = await ui.innerText()
          await center(radios.last()); await radios.last().check()
          check('切换选项后内容跟着变', shown !== await ui.innerText())
        } else if (c.key === 'user-research') {
          r.retrievedUrls = ev.results.filter(x => ['web_fetch', 'browser_navigate'].includes(x.name) && succeeded(x) && x.result.length > 400).map(x => {
            const call = ev.calls.find(c => c.id === x.id)
            return parse(x.result)?.url || parse(call?.arguments)?.url
          }).filter(Boolean)
          check('实际取得两家官方网页正文', r.retrievedUrls.some(x => official(x, 'obsidian.md')) && r.retrievedUrls.some(x => official(x, 'notion.so') || official(x, 'notion.com')))
          const sources = ui.locator('.iui-source'), links = await sources.locator('a').evaluateAll(es => es.map(a => a.href))
          check('提供两家官方来源', links.some(x => official(x, 'obsidian.md')) && links.some(x => official(x, 'notion.so') || official(x, 'notion.com')))
          await sources.locator('summary').first().click()
          check('网页摘要可展开', await sources.locator('details[open]').count() > 0)
          r.sourceUrls = links
          await sources.locator('a').first().click()
          for (let i = 0; i < 40; i++) {
            r.openedSource = await app.evaluate(({ webContents }, href) => {
              const page = webContents.getAllWebContents().find(c => c.getURL().split('#')[0] === href.split('#')[0])
              return page && !page.isLoading() ? { url: page.getURL(), title: page.getTitle() } : null
            }, links[0])
            if (r.openedSource?.title) break
            await sleep(500)
          }
          check('点击来源实际打开官方网页', !!r.openedSource?.title && !/404|not found|error/i.test(r.openedSource.title))
          await open(c)
        }
        if (c.key !== 'user-study') check('本地操作没有触发模型请求', requests.length === before)
        // Rendering contract on what a real model actually wrote, whatever shape that took.
        r.look = await win.locator('.intelligent-ui[data-complete="true"]').evaluateAll(els => els.map(el => ({
          title: getComputedStyle(el.querySelector('.iui-title')).fontSize,
          prose: [...new Set([...el.querySelectorAll('.iui-prose')].map(p => getComputedStyle(p).fontSize))],
          oldToolbar: el.querySelectorAll('.iui-list-toolbar').length,
          lists: el.querySelectorAll('.iui-checklist').length, heads: el.querySelectorAll('.iui-checklist > .iui-list-head').length,
          // Facts of the items in one visual row must start on the same line (rows are 3 wide, or the pair when there are two).
          misaligned: innerWidth < 600 ? 0 : [...el.querySelectorAll('.iui-comparison')].filter(grid => {
            const items = [...grid.children].slice(0, 3), tops = items.map(a => a.querySelector('ul:not(:empty)')?.getBoundingClientRect().top).filter(v => v !== undefined)
            return tops.length > 1 && Math.max(...tops) - Math.min(...tops) > 1
          }).length,
          kinds: [...el.querySelectorAll('.iui-block')].map(b => b.className.replace('iui-block iui-block-', '')), seg: el.querySelectorAll('.iui-seg').length, pick: el.querySelectorAll('.iui-pick').length,
        })))
        check('新版界面：标题与正文字号、清单标题行、对比对齐', r.look.length > 0 && r.look.every(d => d.title === '17.5px' && d.prose.every(s => s === '14px') && d.oldToolbar === 0 && d.lists === d.heads && d.misaligned === 0))
        check('可用宽度无横向溢出', await win.locator('.intelligent-ui').last().evaluate(el => el.scrollWidth <= el.clientWidth + 1))
        await screenshot(c, 'interacted')
        r.messages = (await api(`/agent/sessions/${c.sid}/messages`)).messages
        r.ok = true
      } catch (e) { r.error = String(e.stack || e); await win.screenshot({ path: path.join(shots, `${c.key}-failure.png`) }).catch(() => {}) }
      r.ms = Date.now() - t0
      r.detail = r.error || r.checks.map(x => x.label).join('；')
      r.toolCalls = r.turns.flatMap(t => t.tools)
      r.output = r.turns.map((t, i) => `用户第${i + 1}轮：${t.prompt}\n模型：${t.content}\n界面：${t.documents.map(d => JSON.stringify(d)).join('\n')}`).join('\n\n')
      r.pageErrors = [...pageErrors]; save(); console.log(`${r.ok ? 'PASS' : 'FAIL'} ${c.key}: ${r.error || r.checks.length + ' checks'}`)
    }
  } catch (e) {
    if (win) {
      await win.screenshot({ path: path.join(shots, 'startup-failure.png') }).catch(() => {})
      fs.writeFileSync(path.join(OUT, 'intelligent-users-startup-evidence.json'), JSON.stringify({ error: String(e.stack || e), ui: await win.locator('body').innerText().catch(() => ''), pageErrors }, null, 2))
    }
    throw e
  } finally { report.finishedAt = new Date().toISOString(); save(); await app?.close().catch(() => {}); fs.rmSync(home, { recursive: true, force: true }) }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
