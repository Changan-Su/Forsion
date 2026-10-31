/**
 * 插件列表源(ctx.registerListSource)行首图标的**真浏览器几何**。
 *
 * 为什么存在:`.t2s-lead` 一族的尺寸规则全挂在 `.t2s-side` 选择子下,而列表源的容器是
 * `.t2sw-plug` —— 生产里它嵌在侧栏的 `.t2s-side` 里才拿得到 `--t2s-icon`。哪天有人把列表源
 * 挪到没有 `.t2s-side` 的地方,favicon <img> 就按 .ico 原始尺寸(32/48px)撑爆行、lucide 退回
 * 自带 24px —— 类型、单测、tsc 全绿,只有眼睛看得见。这支就钉这一条,外加 iconUrl 取不到时
 * 必须退回词表图标(老宿主/断网/CDN 404 的兜底路径)。
 *
 * 2026-10-10 起还钉层级那一半(`?listsrc&tree`):文件夹行与同级行对齐、开合记得住、行在列表里拖动的
 * 落点(前 / 后 / 放进去,插件拒了有退路,不落进自己下面)、就地改名(回车 / Esc / 失焦 / F2)、
 * 搜索时平铺,以及没有层级的老列表不变样。负对照实跑过:把「文件夹中间 = 放进去」和「不落进自己下面」
 * 改坏,对应两条变红。
 *
 * 2026-10-14 起还钉组头那一半(`?listsrc&groups`,收件箱按发信人用的那种列表):组头与工作区一级行同档、
 * 三种前导、组里的行与组头的名字对齐、行尾的悬停图标钮(只收带图标的动作、不压标题、不误开行)、
 * 开合只记这一程(读完不合上、来了新的重新打开)、「查看更多」、键盘。
 *
 * 用法:npm run check:listsrc   (截图落 /tmp/listsrc-shots)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { createHash } = require('crypto')
const { chromium } = require('playwright-core')

let BASE = process.env.HARNESS_URL || ''
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'listsrc-shots')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE')
}

const ping = () => new Promise((res) => {
  const req = http.get(BASE, (r) => { res(r.statusCode === 200); r.resume() })
  req.on('error', () => res(false))
  req.setTimeout(1500, () => { req.destroy(); res(false) })
})

const results = []
const check = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 160) : ''}`)
}

async function main() {
  let vite = null
  if (!BASE) {
    // Own the harness server so another worktree on 5173 cannot produce a false green.
    const { createServer } = await import('vite')
    const root = path.resolve(__dirname, '../frontend')
    if (!fs.existsSync(path.join(root, 'public/excalidraw/excalidraw.js'))) throw new Error('先运行 node build/copy-excalidraw-assets.cjs 准备台架资源')
    const cacheDir = path.join(os.tmpdir(), `forsion-listsrc-vite-${createHash('sha1').update(root).digest('hex').slice(0, 12)}`)
    vite = await createServer({ root, cacheDir, configFile: path.join(root, 'vite.config.ts'), server: { host: '127.0.0.1', port: 0, strictPort: false } })
    await vite.listen()
    BASE = `http://127.0.0.1:${vite.httpServer.address().port}/harness.html`
  } else if (!(await ping())) throw new Error(`Harness is unavailable: ${BASE}`)
  fs.mkdirSync(SHOTS, { recursive: true })
  const browser = await chromium.launch({ executablePath: findChromium() })
  try {
    for (const mode of ['light', 'dark']) {
      const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 460, height: 320 } })
      page.on('pageerror', (error) => console.error('Renderer:', error.message))
      page.on('console', (message) => { if (message.type() === 'error') console.error('Console:', message.text()) })
      await page.goto(`${BASE}?listsrc${mode === 'dark' ? '&dark' : ''}`, { waitUntil: 'load' })
      await page.waitForSelector('.t2sw-plug .t2s-srow').catch(async (error) => { await page.screenshot({ path: path.join(SHOTS, 'failure.png') }); throw error })
      await page.waitForTimeout(1200) // 远程 favicon + onError 兜底都跑完
      const shot = path.join(SHOTS, `listsrc-${mode}.png`)
      await page.screenshot({ path: shot })
      console.log(`      截图 ${shot}`)

      const geo = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('.t2sw-plug .t2s-srow, [data-tag="ref-side"] .t2s-srow'))
        return rows.map((r) => {
          const lead = r.querySelector('.t2s-lead')
          const g = lead && lead.firstElementChild
          const b = g ? g.getBoundingClientRect() : null
          return { title: (r.textContent || '').slice(0, 12), tag: g ? g.tagName.toLowerCase() : null, w: b ? Math.round(b.width * 10) / 10 : 0, h: b ? Math.round(b.height * 10) / 10 : 0 }
        })
      })
      if (mode === 'light') console.log('      ' + JSON.stringify(geo))

      check(`${mode} 六行 + 基准行都在`, geo.length === 7, geo.length)
      const big = geo[0], own = geo[4], unknown = geo[5], ref = geo[6] // ref = 真 .t2s-side 里的会话/笔记行
      check(`${mode} 32px 原图被槽位压到基准尺寸`, big.tag === 'img' && big.w > 0 && Math.abs(big.w - ref.w) <= 1 && Math.abs(big.h - ref.h) <= 1, JSON.stringify([big, ref]))
      check(`${mode} 词表图标与会话/笔记行同大`, Math.abs(own.w - ref.w) <= 1 && Math.abs(own.h - ref.h) <= 1, JSON.stringify([own, ref]))
      check(`${mode} 图标不超 20px(没按 .ico 原始尺寸撑爆)`, big.w <= 20 && big.h <= 20, `${big.w}×${big.h}`)
      check(`${mode} iconUrl 取不到 → 退回词表 svg`, geo[3].tag === 'svg', JSON.stringify(geo[3]))
      check(`${mode} 无 iconUrl → 词表 svg`, own.tag === 'svg', JSON.stringify(own))
      // 词表里没有的键名:退兜底 svg。**不许**变成一段字面文本(那样 firstElementChild 会是 null)。
      check(`${mode} 未知键名 → 兜底 svg,不是字面文本`, unknown.tag === 'svg' && Math.abs(unknown.w - ref.w) <= 1, JSON.stringify(unknown))
      const active = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('.t2sw-plug .t2s-srow'))
        const selected = rows.filter((r) => r.classList.contains('active'))
        const row = selected[0]
        const mark = row ? getComputedStyle(row, '::before') : null
        return {
          count: selected.length,
          title: row ? (row.textContent || '').trim() : '',
          markWidth: mark ? mark.width : '',
          markContent: mark ? mark.content : '',
          // W-73:标题 span 的字重跟行走(DESIGN §6),不被 `.t2sw *` 的 600 命中。
          plainW: getComputedStyle(rows.find((r) => !r.classList.contains('active') && !r.classList.contains('is-unread')).querySelector('.t2s-srow-title')).fontWeight,
          activeW: row ? getComputedStyle(row.querySelector('.t2s-srow-title')).fontWeight : '',
        }
      })
      check(`${mode} activeKey → 唯一原生选中行 + 左侧色条`, active.count === 1 && active.title.includes('32px 图标') && active.markWidth === '2px' && active.markContent !== 'none', JSON.stringify(active))
      check(`${mode} W-73 普通行标题常规字重、选中行略加强`, active.plainW === '400' && active.activeW === '500', `${active.plainW} / ${active.activeW}`)
      await page.close()
    }
    const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 520, height: 420 } })
    await page.goto(`${BASE}?listsrc&controls`, { waitUntil: 'load' })
    await page.locator('.t2sw-plug-list .t2s-srow').first().waitFor()
    check('旧插件未声明 primary 也保留首个动作，其余操作收纳', await page.locator('.t2sw-plug-btn').getAttribute('aria-label') === '新建条目' && await page.getByRole('button', { name: '导出列表', exact: true }).count() === 0)
    check('工具区收纳到两行，列表直接可见', await page.locator('.t2sw-plug-list').evaluate((el) => el.getBoundingClientRect().top - el.closest('.t2sw-plug').getBoundingClientRect().top < 90))
    await page.getByRole('button', { name: '台架列表源操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '新建分类', exact: true }).click()
    check('原 groupActions 仍通过统一菜单调用', await page.evaluate(() => window.__listProbe.actions.includes('folder')))
    await page.getByRole('button', { name: '筛选分类', exact: true }).click()
    await page.getByRole('menuitemradio', { name: '第二组', exact: true }).click()
    check('分类筛选传回插件并在入口显示当前分类', await page.locator('.t2sw-plug-list .t2s-srow').count() === 3 && (await page.locator('.t2sw-plug-filter').innerText()).includes('第二组'))
    await page.getByRole('button', { name: '显示全部', exact: true }).click()
    const search = page.getByRole('textbox', { name: '搜索台架列表源', exact: true })
    await search.fill('Bilibili'); await search.press('ArrowDown'); await page.keyboard.press('Enter')
    check('搜索→方向键→Enter 实际打开条目', await page.evaluate(() => window.__listProbe.opened.at(-1) === 'b'))
    await page.getByRole('button', { name: '清空搜索', exact: true }).click()
    const menu = page.getByRole('button', { name: 'Bilibili 视频总结的操作', exact: true })
    await menu.focus(); await menu.click()
    await page.getByRole('menuitem', { name: '查看属性', exact: true }).click()
    check('条目更多操作不误触打开条目', await page.evaluate(() => window.__listProbe.actions.at(-1) === 'b' && window.__listProbe.opened.length === 1))
    await page.locator('.t2sw-plug-list .t2s-srow').first().click({ button: 'right' })
    await page.getByRole('menuitem', { name: '查看属性', exact: true }).waitFor()
    check('右键复用 Portal 原生菜单，避免窄栏裁切', await page.locator('.ctx-menu').evaluate((el) => !el.closest('.t2sw') && el.getBoundingClientRect().right <= innerWidth))
    await page.keyboard.press('Escape')
    const data = await page.evaluateHandle(() => { const dt = new DataTransfer(); dt.setData('application/x-tangu-paths', JSON.stringify(['/tmp/example.md'])); return dt })
    await page.locator('.t2sw-plug-filter').dispatchEvent('dragenter', { dataTransfer: data })
    const target = page.getByRole('menuitemradio', { name: '第二组', exact: true })
    await target.dispatchEvent('dragover', { dataTransfer: data })
    check('拖放自动展开分类并标记目标', await target.evaluate((el) => el.classList.contains('capability-menu-drop')))
    await target.dispatchEvent('drop', { dataTransfer: data })
    check('拖放保留原插件路径载荷和分类目标', await page.evaluate(() => { const drop = window.__listProbe.drops.at(-1); return drop.payload.paths[0] === '/tmp/example.md' && drop.target.group === 'second' }))
    await target.click()
    await page.evaluate(() => window.__listProbe.removeGroups())
    await page.waitForFunction(() => document.querySelectorAll('.t2sw-plug-list .t2s-srow').length === 6)
    check('分类消失后解除过期筛选，不留空列表', true)
    await page.screenshot({ path: path.join(SHOTS, 'listsrc-controls.png') })
    await page.close()

    // ── 层级 / 开合记忆 / 行在列表里拖动 / 就地改名(2026-10-10)──
    //    同一个浏览器上下文里重载,localStorage 留着 → 能验「记住开合」。
    const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 520, height: 560 } })
    const tree = await ctx.newPage()
    tree.on('pageerror', (error) => console.error('Renderer:', error.message))
    const list = tree.locator('.t2sw-plug-list')
    const load = async () => { await tree.goto(`${BASE}?listsrc&tree`, { waitUntil: 'load' }); await list.locator('.t2s-folder-row').first().waitFor() }
    const titles = () => list.locator('.t2s-srow-title').allInnerTexts()
    const folderBtn = (name) => list.locator('.t2s-folder-row', { hasText: name })
    const leaf = (name) => list.locator('.t2s-srow', { hasText: name })
    const sec = (name) => list.locator('.t2sw-plug-sec', { hasText: name })
    const probe = () => tree.evaluate(() => window.__treeProbe)
    await load()
    let seen = await titles()
    check('当前行所在的文件夹自动展开,别的文件夹收着', seen.includes('快速上手') && seen.includes('核心概念') && !seen.includes('对话基础')
      && await folderBtn('入门').getAttribute('aria-expanded') === 'true' && await folderBtn('对话').getAttribute('aria-expanded') === 'false', seen.join(','))
    const lefts = await tree.evaluate(() => {
      const x = (sel, text) => { const el = Array.from(document.querySelectorAll(sel)).find((n) => (n.textContent || '').includes(text)); return el ? Math.round(el.querySelector('.t2s-lead').getBoundingClientRect().left * 10) / 10 : null }
      const icon = document.querySelector('.t2sw-plug-list .t2s-folder-row .t2s-lead svg').getBoundingClientRect()
      const rowIcon = document.querySelector('.t2sw-plug-list .t2s-srow .t2s-lead svg').getBoundingClientRect()
      return { row: x('.t2sw-plug-list .t2s-srow', '首页'), folder: x('.t2sw-plug-list .t2s-folder-row', '入门'), child: x('.t2sw-plug-list .t2s-srow', '快速上手'), icon: Math.round(icon.width * 10) / 10, rowIcon: Math.round(rowIcon.width * 10) / 10 }
    })
    check('文件夹的图标与同级行的图标左对齐、同大,子行缩进一档(10.5px)', Math.abs(lefts.row - lefts.folder) <= 0.5 && Math.abs(lefts.child - lefts.row - 10.5) <= 0.5 && Math.abs(lefts.icon - lefts.rowIcon) <= 0.5, JSON.stringify(lefts))
    await tree.screenshot({ path: path.join(SHOTS, 'listsrc-tree.png') })
    console.log(`      截图 ${path.join(SHOTS, 'listsrc-tree.png')}`)

    await folderBtn('对话').click()
    check('点文件夹展开(不调 open)', (await titles()).includes('对话基础') && (await probe()).opened.length === 0)
    await sec('更新动态').click()
    check('点分组头收起,数量还在', !(await titles()).includes('版本 2.12') && await sec('更新动态').getAttribute('aria-expanded') === 'false' && (await sec('更新动态').innerText()).includes('1'))
    check('分组数的是行,不含文件夹', (await sec('文档').innerText()).replace(/\s+/g, '') === '文档4', await sec('文档').innerText())
    await load()
    seen = await titles()
    check('重载后开合还在(文件夹开着、分组收着)', seen.includes('对话基础') && !seen.includes('版本 2.12'), seen.join(','))
    await sec('更新动态').click()

    // 行在列表里拖动:落点 = 行内位置给出的候选里第一个被插件接受的
    const drag = async (from, to, y) => { const box = await to.boundingBox(); await from.dragTo(to, { targetPosition: { x: 60, y: Math.round(box.height * y) } }); return (await probe()).drops }
    let drops = await drag(leaf('核心概念'), leaf('快速上手'), 0.2)
    check('拖到一行的上半 → 排在它前面', JSON.stringify(drops.at(-1)) === JSON.stringify({ items: ['a2'], to: 'a1', position: 'before' }), JSON.stringify(drops.at(-1)))
    drops = await drag(leaf('快速上手'), leaf('核心概念'), 0.8)
    check('拖到一行的下半 → 排在它后面', JSON.stringify(drops.at(-1)) === JSON.stringify({ items: ['a1'], to: 'a2', position: 'after' }), JSON.stringify(drops.at(-1)))
    drops = await drag(leaf('快速上手'), folderBtn('对话'), 0.5)
    check('拖到文件夹中间 → 放进去', JSON.stringify(drops.at(-1)) === JSON.stringify({ items: ['a1'], to: 'fb', position: 'into' }), JSON.stringify(drops.at(-1)))
    drops = await drag(folderBtn('对话'), folderBtn('入门'), 0.4)
    check('插件不收「放进去」→ 宿主改问「排在前面」', JSON.stringify(drops.at(-1)) === JSON.stringify({ items: ['fb'], to: 'fa', position: 'before' }), JSON.stringify(drops.at(-1)))
    let n = drops.length
    drops = await drag(folderBtn('入门'), leaf('快速上手'), 0.5)
    check('文件夹不落进自己下面', drops.length === n, JSON.stringify(drops.at(-1)))
    await tree.evaluate(() => { window.__treeProbe.refuse = 'a2' })
    n = drops.length // 每条各取各的基数:上一条红了不连带这一条
    drops = await drag(leaf('快速上手'), leaf('核心概念'), 0.2)
    check('插件拒收的行没有落点', drops.length === n, JSON.stringify(drops.at(-1)))
    n = drops.length
    drops = await drag(leaf('版本 2.12'), leaf('快速上手'), 0.2)
    check('没标 draggable 的行拖不动', drops.length === n, JSON.stringify(drops.at(-1)))

    // 松手落位(2026-10-25,LCL land):插件写完才重渲(替身晚 60ms 真的挪),那一行从松手处滑进新位置;邻居不让位
    await tree.evaluate(() => {
      const p = window.__treeProbe
      p.refuse = ''
      p.reorder = true
      const d = (window.__land = { grabY: null, dropY: null, samples: [] })
      const find = () => document.querySelector('.t2sw-plug-list [data-row-key="a2"]')?.closest('.t2sw-plug-item')
      addEventListener('dragstart', (e) => { const it = e.target.closest?.('.t2sw-plug-item'); if (it) d.grabY = e.clientY - it.getBoundingClientRect().top }, { capture: true, once: true })
      addEventListener('drop', (e) => {
        d.dropY = e.clientY
        const t0 = performance.now()
        setTimeout(() => {
          const tick = () => {
            const it = find()
            if (it) {
              const tr = getComputedStyle(it).transform
              d.samples.push({ t: Math.round(performance.now() - t0), top: it.getBoundingClientRect().top, ty: tr === 'none' ? 0 : Number(tr.match(/-?[\d.e]+/g)[5]), prev: it.previousElementSibling?.querySelector('[data-row-key]')?.dataset.rowKey ?? null })
            }
            if (performance.now() - t0 < 600) requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        }, 0)
      }, { capture: true, once: true })
    })
    await leaf('核心概念').dragTo(leaf('快速上手'), { targetPosition: { x: 60, y: 3 } })
    await tree.waitForTimeout(800)
    const land = await tree.evaluate(() => window.__land)
    {
      const S = land.samples
      const movedAt = S.findIndex((x) => x.prev !== S[0]?.prev)
      const fly = movedAt >= 0 ? S.slice(movedAt) : []
      const release = land.dropY - land.grabY
      console.log(`      落位采样:${S.map((x) => `${x.t}:${x.ty.toFixed(1)}`).join(' ')}`)
      check('松手落位:插件挪完之前一帧都不飞;挪完那一帧看上去还在松手处,之后滑回 0',
        movedAt > 0 && S.slice(0, movedAt).every((x) => Math.abs(x.ty) < 0.5) && Math.abs(fly[0].top - release) <= 3 && Math.abs(fly[0].ty) > 5 && Math.abs(fly.at(-1).ty) < 0.5,
        fly[0] ? `第 ${movedAt} 帧挪动;top=${fly[0].top.toFixed(1)} 松手处=${release.toFixed(1)} ty=${fly[0].ty.toFixed(1)}` : `没等到挪动 ${JSON.stringify(S.slice(0, 3))}`)
    }
    await tree.evaluate(() => { window.__treeProbe.reorder = false })
    check('拖完不留落点提示', await list.locator('.drop-before, .drop-after, .amx-drop-into, .drag-over, .dragging').count() === 0)

    // 就地改名:菜单项由宿主加;回车提交、Esc 取消、失焦提交;没改或改成空不回报
    await leaf('快速上手').click({ button: 'right' })
    await tree.getByRole('menuitem', { name: '重命名', exact: true }).click()
    const box = list.locator('input.t2s-rename')
    check('右键 → 重命名:输入框拿到焦点、带着原名', await box.evaluate((el) => document.activeElement === el && el.value === '快速上手'))
    await box.fill('  三分钟上手  '); await box.press('Enter')
    check('回车提交:去掉首尾空格后交给插件,行跟着插件的数据变', JSON.stringify((await probe()).renames.at(-1)) === JSON.stringify({ key: 'a1', title: '三分钟上手' }) && (await titles()).includes('三分钟上手'))
    await tree.getByRole('button', { name: '核心概念的操作', exact: true }).click()
    await tree.getByRole('menuitem', { name: '重命名', exact: true }).click()
    await box.fill('不要这个名字'); await box.press('Escape')
    check('行尾「更多」→ 重命名 → Esc:不回报', (await probe()).renames.length === 1 && await box.count() === 0 && (await titles()).includes('核心概念'))
    await folderBtn('入门').focus(); await tree.keyboard.press('F2')
    await box.fill('上手'); await tree.locator('.t2s-search input').click()
    check('F2 给文件夹改名,失焦提交', JSON.stringify((await probe()).renames.at(-1)) === JSON.stringify({ key: 'fa', title: '上手' }) && await folderBtn('上手').count() === 1)
    await folderBtn('上手').focus(); await tree.keyboard.press('F2'); await box.fill('   '); await box.press('Enter')
    check('改成空的不回报', (await probe()).renames.length === 2)
    await folderBtn('未进目录').click({ button: 'right' })
    check('没标 renamable、插件也没给动作的行没有菜单', await tree.locator('.ctx-menu').count() === 0)

    // 文件夹行尾:primary 动作画成「+」,菜单里「重命名」排在危险动作前面
    await folderBtn('对话').hover()
    await list.locator('.t2s-group', { hasText: '对话' }).getByRole('button', { name: '在这里新建', exact: true }).click()
    check('文件夹上的「+」= 它菜单里的 primary 动作', JSON.stringify((await probe()).adds) === JSON.stringify(['fb']))
    await folderBtn('对话').click({ button: 'right' })
    const order = await tree.locator('.ctx-menu .ctx-item').allInnerTexts()
    check('文件夹菜单:插件的动作 + 重命名,危险的排最后', JSON.stringify(order) === JSON.stringify(['在这里新建', '重命名', '删除文件夹']), order.join(','))
    await tree.keyboard.press('Escape')

    // 键盘:方向键走得到文件夹行与分组头,左右键开合文件夹
    await leaf('首页').focus(); await tree.keyboard.press('ArrowDown')
    check('方向键从行走到文件夹行', await tree.evaluate(() => document.activeElement.classList.contains('t2s-folder-row')))
    await tree.keyboard.press('ArrowLeft')
    const closed = await tree.evaluate(() => document.activeElement.getAttribute('aria-expanded'))
    await tree.keyboard.press('ArrowRight')
    check('左键收起、右键展开文件夹', closed === 'false' && await tree.evaluate(() => document.activeElement.getAttribute('aria-expanded')) === 'true')

    // 搜索:不画层级,去掉文件夹,按行平铺;这时不让拖
    await tree.locator('.t2s-search input').fill('基础')
    check('搜索时平铺:只有匹配的行,没有文件夹', JSON.stringify(await titles()) === JSON.stringify(['对话基础']) && await list.locator('.t2s-folder-row').count() === 0
      && await leaf('对话基础').getAttribute('draggable') !== 'true')
    await tree.screenshot({ path: path.join(SHOTS, 'listsrc-tree-search.png') })
    await ctx.close()
    // 老列表(没有 parent / 文件夹)不变样:分组头照旧展开,行还是那一层
    const old = await browser.newPage({ locale: 'zh-CN', viewport: { width: 460, height: 320 } })
    await old.goto(`${BASE}?listsrc`, { waitUntil: 'load' })
    await old.locator('.t2sw-plug-list .t2s-srow').first().waitFor()
    check('没有层级的老列表:没有文件夹行,六行都在', await old.locator('.t2sw-plug-list .t2s-folder-row').count() === 0 && await old.locator('.t2sw-plug-list .t2s-srow').count() === 6)
    await old.close()
    // ── 组头 / 行尾的悬停图标钮 / 「查看更多」(2026-10-14,`?listsrc&groups`):收件箱按发信人的那一种列表 ──
    for (const mode of ['light', 'dark']) {
      const g = await browser.newPage({ locale: 'zh-CN', viewport: { width: 520, height: 720 } })
      g.on('pageerror', (error) => console.error('Renderer:', error.message))
      const glist = g.locator('.t2sw-plug-list')
      const gload = async () => { await g.goto(`${BASE}?listsrc&groups${mode === 'dark' ? '&dark' : ''}`, { waitUntil: 'load' }); await glist.locator('.t2sw-plug-ghead').first().waitFor() }
      await gload()
      const ghead = (name) => glist.locator('.t2sw-plug-ghead', { hasText: name })
      const grow = (name) => glist.locator('.t2sw-plug-item', { hasText: name })
      const opens = () => glist.locator('.t2sw-plug-ghead').evaluateAll((els) => els.map((el) => `${el.querySelector('.t2o-name').textContent}:${el.getAttribute('aria-expanded')}`).join(' '))
      const gprobe = () => g.evaluate(() => window.__groupProbe)
      // 探针推来的变化要等 React 画完:轮询到开合状态对上为止(最多 2 秒),返回最后一次读到的
      const opensLike = async (re) => { let last = ''; for (let i = 0; i < 40; i++) { last = await opens(); if (re.test(last)) break; await g.waitForTimeout(50) } return last }
      await g.screenshot({ path: path.join(SHOTS, `listsrc-groups-${mode}.png`) })
      console.log(`      截图 ${path.join(SHOTS, `listsrc-groups-${mode}.png`)}`)
      if (mode === 'dark') { await g.close(); continue }

      check('组头:有未读的组缺省开着,其余收着', await opens() === 'Muse:true Forsion:true 自动化:false 带头像的:false', await opens())
      const geo = await g.evaluate(() => {
        const r = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.left * 10) / 10, w: Math.round(b.width * 10) / 10, h: Math.round(b.height * 10) / 10 } }
        const heads = Array.from(document.querySelectorAll('.t2sw-plug-ghead'))
        const kid = document.querySelector('.t2sw-plug-group .t2s-srow')
        return {
          head: r(heads[0]), leads: heads.map((el) => r(el.querySelector('.t2o-lead'))), name: r(heads[0].querySelector('.t2o-name')), title: r(kid.querySelector('.t2s-srow-title')),
          lead: heads.map((el) => { const x = el.querySelector('.t2o-lead').firstElementChild; return x.tagName === 'IMG' ? `img:${getComputedStyle(x).borderRadius}` : x.tagName === 'svg' ? `svg:${r(x).w}` : `text:${x.textContent}` }),
          kidLead: Array.from(document.querySelectorAll('.t2sw-plug-group .t2s-srow')).map((el) => el.querySelector('.t2s-lead').innerHTML.includes('t2sw-plug-udot') ? 'dot' : el.querySelector('.t2s-lead').childElementCount ? 'icon' : 'empty'),
          count: getComputedStyle(heads[0].querySelector('.t2s-count')).backgroundColor,
        }
      })
      check('组头与工作区一级行同档:40 高、30 的前导槽', geo.head.h === 40 && geo.leads.every((l) => l.w === 30 && l.h === 30), JSON.stringify([geo.head, geo.leads]))
      check('前导三种:没有图标 → 首字;词表图标 → 方块里 16px 的图标;图片 → 圆头像', JSON.stringify(geo.lead) === JSON.stringify(['text:M', 'svg:16', 'svg:16', 'img:50%']), JSON.stringify(geo.lead))
      check('组里的行:标题和组头的名字对齐,前导槽里只有未读的圆点(不画自己的图标)', Math.abs(geo.name.x - geo.title.x) <= 1 && JSON.stringify(geo.kidLead) === JSON.stringify(['dot', 'empty', 'dot', 'empty']), JSON.stringify([geo.name.x, geo.title.x, geo.kidLead]))
      check('组头行尾的未读数是一颗小胶囊(有底色)', geo.count !== 'rgba(0, 0, 0, 0)', geo.count)

      // 行尾的图标钮:指针上去才有;只收带图标的动作,顺序同菜单;出现时不压标题,时间让出来
      const first = grow('请审批')
      const quickOf = (row) => row.locator('.t2sw-plug-row-act')
      check('指针不在行上:没有图标钮,时间看得见', !(await quickOf(first).first().isVisible()) && await first.locator('.t2s-count').isVisible())
      await first.hover()
      const labels = await quickOf(first).evaluateAll((els) => els.filter((el) => el.getClientRects().length).map((el) => el.getAttribute('aria-label')))
      check('指针在行上:带图标的动作成一排图标钮(同手机左滑那一份),没图标的不在', JSON.stringify(labels) === JSON.stringify(['标为已读', '归档', '删除']), JSON.stringify(labels))
      const long = grow('很长很长')
      await long.hover()
      const fit = await long.evaluate((el) => {
        const range = document.createRange(); range.selectNodeContents(el.querySelector('.t2s-srow-title'))
        const b = (x) => x.getBoundingClientRect()
        return { title: Math.round(b(el.querySelector('.t2s-srow-title')).right), sub: Math.round(b(el.querySelector('.t2sw-plug-sub')).right), quick: Math.round(b(el.querySelector('.t2sw-plug-row-quick')).left),
          more: Math.round(b(el.querySelector('.t2sw-plug-row-menu')).left), quickRight: Math.round(b(el.querySelector('.t2sw-plug-row-quick')).right), time: getComputedStyle(el.querySelector('.t2s-count')).display }
      })
      check('图标钮不压标题和第二行,排在「更多」左边;时间收起', fit.title <= fit.quick && fit.sub <= fit.quick && fit.quickRight <= fit.more && fit.time === 'none', JSON.stringify(fit))
      await g.screenshot({ path: path.join(SHOTS, 'listsrc-groups-hover.png') })
      await quickOf(long).nth(1).click()
      check('点图标钮跑的是那个动作,不误开这一行', JSON.stringify((await gprobe()).ran) === JSON.stringify(['archive:f1']) && (await gprobe()).opened.length === 0, JSON.stringify(await gprobe()))
      await grow('会员即将到期').hover()
      await grow('会员即将到期').getByRole('button', { name: '会员即将到期的操作', exact: true }).click()
      const menu = await g.getByRole('menuitem').allInnerTexts()
      check('「更多」里仍是带名字的全部动作', JSON.stringify(menu) === JSON.stringify(['标为未读', '归档', '查看属性', '删除']) || JSON.stringify(menu) === JSON.stringify(['标为未读', '归档', '删除', '查看属性']), JSON.stringify(menu))
      await g.keyboard.press('Escape')

      // 开合只记这一程:读完最后一封未读不在光标底下合上;收起后来了新的重新打开;未读还在时用户收起就收着
      await first.hover(); await quickOf(first).first().click()
      check('组里最后一封未读标成已读:组不自己合上,组头的数没了', (await opens()).startsWith('Muse:true') && await ghead('Muse').locator('.t2s-count').count() === 0, await opens())
      await ghead('Muse').click()
      check('点组头收起', (await opens()).startsWith('Muse:false'), await opens())
      await g.evaluate(() => window.__groupProbe.arrive('muse'))
      const reopened = await opensLike(/^Muse:true/)
      check('收起的组来了新的未读:重新打开', reopened.startsWith('Muse:true') && await ghead('Muse').locator('.t2s-count').innerText() === '1', reopened)
      await ghead('Muse').click()
      await g.evaluate(() => window.__groupProbe.arrive('pic'))
      const risen = await opensLike(/^带头像的:true Muse:false/)
      check('未读还在时用户收起的组,别处来信不把它翻开;来信的那一组打开、排到最上面', /^带头像的:true Muse:false/.test(risen), risen)

      // 查看更多:一组先列五条
      await ghead('自动化').click()
      const autoRows = () => glist.locator('.t2sw-plug-group', { hasText: '自动化' }).locator('.t2s-srow').count()
      const moreBtn = glist.locator('.t2s-viewmore')
      check('一组超过五条:先列五条,其余在「查看更多 · N」后面', await autoRows() === 5 && await moreBtn.innerText() === '查看更多 · 2', `${await autoRows()} / ${await moreBtn.innerText().catch(() => '')}`)
      await moreBtn.click()
      check('点「查看更多」列全', await autoRows() === 7 && await moreBtn.count() === 0, String(await autoRows()))
      await grow('每日汇总 3').locator('.t2s-srow').click()
      check('点组里的行照常打开', (await gprobe()).opened.at(-1) === 'a3', JSON.stringify((await gprobe()).opened))

      // 键盘:方向键走得到组头,左右键开合
      await ghead('Forsion').focus(); await g.keyboard.press('ArrowLeft')
      const shut = await ghead('Forsion').getAttribute('aria-expanded')
      await g.keyboard.press('ArrowRight'); await g.keyboard.press('ArrowDown')
      check('组头:左键收起、右键展开,下键走进组里的行', shut === 'false' && await ghead('Forsion').getAttribute('aria-expanded') === 'true' && await g.evaluate(() => document.activeElement.classList.contains('t2s-srow')))
      // 键盘走到行上:图标钮也出来(不用 Tab 去够它们 —— 无头的 macOS Chromium 里 Tab 不落在按钮上,量显示与否就够了)
      const quickShown = () => g.evaluate(() => getComputedStyle(document.activeElement.parentElement.querySelector('.t2sw-plug-row-quick')).display)
      check('键盘焦点走到行上:图标钮出现', await quickShown() === 'flex', await quickShown())
      // 鼠标点过的行留着焦点,但指针移开后不能一直亮着一排按钮(所以用的是 :focus-visible,不是 :focus-within)
      await grow('每日汇总 5').locator('.t2s-srow').click(); await g.mouse.move(500, 700)
      check('鼠标点过的行:指针移开后图标钮收起,时间回来', await quickShown() === 'none' && await grow('每日汇总 5').locator('.t2s-count').isVisible(), await quickShown())

      await g.locator('.t2s-search input').fill('汇总')
      check('搜索时平铺:没有组头,行自己带图标', await glist.locator('.t2sw-plug-ghead').count() === 0 && await glist.locator('.t2s-srow').count() === 7 && await glist.locator('.t2s-srow .t2s-lead svg').count() === 7)
      await gload()
      check('组头的开合不落盘:重新载入回到「有未读的开着、其余收着」', await opens() === 'Muse:true Forsion:true 自动化:false 带头像的:false', await opens())
      // 在搜索结果里点开一封收着的组里的信(排在第六):清掉搜索后那一组要打开,而且这封不能被收在「查看更多」后面
      await g.locator('.t2s-search input').fill('汇总 6'); await glist.locator('.t2s-srow').first().click()
      await g.locator('.t2s-search input').fill('')
      const back = await opensLike(/自动化:true/)
      check('搜索里点开的信:清掉搜索后它的组打开、整组列全(它不在「查看更多」后面)', /自动化:true/.test(back) && await grow('每日汇总 6').locator('.t2s-srow.active').count() === 1, back)
      // 组都收着时,搜索框按下键要落在第一个组头上(以前只找行,找不到就停在输入框里)
      for (const name of ['Muse', 'Forsion', '自动化']) await ghead(name).click()
      await g.locator('.t2s-search input').focus(); await g.keyboard.press('ArrowDown')
      check('组都收着:搜索框的下键落在第一个组头上', await opens() === 'Muse:false Forsion:false 自动化:false 带头像的:false' && await g.evaluate(() => document.activeElement.classList.contains('t2sw-plug-ghead')), await opens())
      await g.close()
    }

    // ── 数据接线的源码闸(几何管不着,但正是 2026-08-28 「明明有记录列表却是空」的那半)──
    //    插件在**启动期**激活,那时 vault 根还没恢复(宿主 vault 引导是懒的),列表源启动时那次
    //    读索引拿到的是 readTextFile 的**静默 null**;库落地后没人再喊它一声,列表就恒空。
    //    宿主这边的两道:①挂载时把库唤起来;②订阅 effect 以 vaultRoot 为键 → 库落地/切库都重订阅。
    //    「顺手把 vaultRoot 从依赖数组里清掉」看着像清理未用变量,实际是把 bug 装回去 —— 故钉在这里。
    const wv = fs.readFileSync(path.resolve(__dirname, '../frontend/src/views/WorkspaceView.tsx'), 'utf8')
    const body = wv.slice(wv.indexOf('export function PluginListBody'))
    const subEff = /useEffect\(\(\) => src\.subscribe\([^)]*\)[^,]*,\s*\[([^\]]*)\]\)/.exec(body)
    check('订阅 effect 以 vaultRoot 为键(库落地/切库都重订阅)', !!subEff && /vaultRoot/.test(subEff[1]), subEff ? subEff[1] : '没找到订阅 effect')
    check('PluginListBody 挂载时 ensureAmadeusReady(冷启进插件 Space 也把库唤起来)', /ensureAmadeusReady\(\)/.test(body.slice(0, 2000)), '')
  } finally {
    await browser.close()
    if (vite) await vite.close()
  }
  const bad = results.filter((x) => !x).length
  console.log(bad ? `\n${bad} 条不过` : `\n全过(${results.length} 条)`)
  process.exit(bad ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
