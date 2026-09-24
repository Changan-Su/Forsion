/**
 * 插件列表源(ctx.registerListSource)行首图标的**真浏览器几何**。
 *
 * 为什么存在:`.t2s-lead` 一族的尺寸规则全挂在 `.t2s-side` 选择子下,而列表源的容器是
 * `.t2sw-plug` —— 生产里它嵌在侧栏的 `.t2s-side` 里才拿得到 `--t2s-icon`。哪天有人把列表源
 * 挪到没有 `.t2s-side` 的地方,favicon <img> 就按 .ico 原始尺寸(32/48px)撑爆行、lucide 退回
 * 自带 24px —— 类型、单测、tsc 全绿,只有眼睛看得见。这支就钉这一条,外加 iconUrl 取不到时
 * 必须退回词表图标(老宿主/断网/CDN 404 的兜底路径)。
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
        }
      })
      check(`${mode} activeKey → 唯一原生选中行 + 左侧色条`, active.count === 1 && active.title.includes('32px 图标') && active.markWidth === '2px' && active.markContent !== 'none', JSON.stringify(active))
      await page.close()
    }
    const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 520, height: 420 } })
    await page.goto(`${BASE}?listsrc&controls`, { waitUntil: 'load' })
    await page.locator('.t2sw-plug-list .t2s-srow').first().waitFor()
    check('旧插件未声明 primary 也保留首个动作，其余操作收纳', await page.locator('.t2sw-plug-btn').innerText() === '新建条目' && await page.getByRole('button', { name: '导出列表', exact: true }).count() === 0)
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
