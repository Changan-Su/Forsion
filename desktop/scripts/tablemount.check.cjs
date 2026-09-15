// 插件原生表接缝(ctx.table.mount → mountPluginTable → 只读 DbTable)的真渲染契约(harness ?tablemount)。
// 钉的是「面板里那张表既是原生多维表、又不给用户任何写入口、还不被插件皮肤吃掉」这条承诺:
//   T1  五行数据上屏(内存源:没有笔记库、没有 .db 文件)
//   T2  没有任何写入入口(加行/加列/删行/可编辑输入框)
//   T3  rowAttrs 落在行元素上(面板既有的事件委托继续生效)+ selectedId 高亮
//   T4  select 芯片与富边料(两行文案 / 头像)上屏
//   T4b 自适应列宽默认开:短枚举列收紧、主内容完整、副内容再长也只截断；关/开状态可用
//   T5  行点击 → onRowOpen 恰好一次
//   T6  点操作按钮**不**算开行,且原生 click 带着 data-act 冒泡到宿主(委托监听照常收得到)
//   T7  弹层逃出插件皮肤:挂载点套着 `container-type: inline-size; overflow:auto` 的盒子
//       (= 真面板 .fsa-adm 的两条要命属性),弹层必须整块在视口内、父级是 body 级宿主、
//       鼠标点得到(elementFromPoint 命中),点里面不关、点外面才关
//   T8  表头点击就地排序,并把新排序回调给面板(onSort)
//   T9  update(3 行)**原地**重渲染:行数变 3、根元素身份不变(没重挂)、onRender 那一发读到的是新行数
//   T10 update 之后用户的排序仍在(数据刷新不许把排序冲掉)
//   T11 dispose:表体与 body 级弹层宿主都收干净
//   T12 暗色:外层与弹层宿主都拿到 data-mode="dark"(暗色芯片色板挂在这个属性上)
//   T13 无未捕获页面错误
// ⚠️ 交互口径跟着 DatabaseEmbed 的只读分支走(readOnly 下表头**左键就地排序**、右键才开列菜单)。
//    那边若改成「左键开菜单、菜单里排序」,T7/T8 这两处的动作要跟着改,别改断言。
// 用法:npm run check:tablemount(经 e2e-editor.cjs 起停 vite;worktree 里设 HARNESS_URL 指独立端口);--shot 存截图
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const BASE = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const ROWS = '.amx-plugtable .amx-db-row:not(.amx-db-hrow):not(.amx-db-statsrow)'
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}
const SHOT_DIR = (() => {
  const a = process.argv.find((x) => x.startsWith('--shot'))
  return a ? (a.split('=')[1] || path.join(os.tmpdir(), 'tablemount-shots')) : null
})()
async function shot(page, name) {
  if (!SHOT_DIR) return
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) })
  console.log(`SHOT  ${path.join(SHOT_DIR, `${name}.png`)}`)
}

;(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() })
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  try {
    await page.goto(`${BASE}?tablemount`)
    await page.waitForSelector(ROWS, { timeout: 15000 })

    const s1 = await page.evaluate((sel) => ({
      rows: document.querySelectorAll(sel).length,
      wrapMode: document.querySelector('.amx-plugtable')?.getAttribute('data-mode'),
      popHosts: document.querySelectorAll('body > .amx-plugtable-pops').length,
      rendered: window.__tableMount.rendered,
      text: document.querySelector('.amx-plugtable')?.innerText || '',
    }), ROWS)
    check('T1 内存源(无库、无 .db 文件)渲出 5 行原生表', s1.rows === 5 && s1.wrapMode === 'light', `rows=${s1.rows} mode=${s1.wrapMode}`)
    check('T1b onRender 在提交后回调过、body 级弹层宿主已就位', s1.rendered >= 1 && s1.popHosts === 1, `rendered=${s1.rendered} popHosts=${s1.popHosts}`)

    const s2 = await page.evaluate((sel) => ({
      addRow: document.querySelectorAll('.amx-plugtable .amx-db-addrow').length,
      addCol: document.querySelectorAll('.amx-plugtable .amx-db-addcol').length,
      rowDel: document.querySelectorAll('.amx-plugtable .amx-db-rowdel').length,
      liveInputs: [...document.querySelectorAll(sel)].reduce((n, r) => n + r.querySelectorAll('input:not([disabled]):not([readonly]):not([type=checkbox]), textarea:not([disabled]):not([readonly])').length, 0),
      liveCheckbox: [...document.querySelectorAll(sel)].reduce((n, r) => n + r.querySelectorAll('input[type=checkbox]:not([disabled])').length, 0),
    }), ROWS)
    check('T2 没有任何写入入口(加行/加列/删行/可编辑格)', s2.addRow === 0 && s2.addCol === 0 && s2.rowDel === 0 && s2.liveInputs === 0 && s2.liveCheckbox === 0, JSON.stringify(s2))

    const s3 = await page.evaluate((sel) => ({
      attrRows: document.querySelectorAll(`${sel}[data-act="m-row"][data-id]`).length,
      ids: [...document.querySelectorAll(sel)].map((r) => r.getAttribute('data-id')),
      selected: document.querySelectorAll('.amx-plugtable .amx-db-row--selected').length,
    }), ROWS)
    check('T3 rowAttrs 落在行元素上(事件委托继续生效)+ selectedId 高亮一行', s3.attrRows === 5 && s3.selected === 1, `attrRows=${s3.attrRows} selected=${s3.selected} ids=${s3.ids}`)

    const s4 = await page.evaluate(() => ({
      chips: document.querySelectorAll('.amx-plugtable .amx-db-chip').length,
      avatars: document.querySelectorAll('.amx-plugtable .amx-db-avatar').length,
      subs: document.querySelectorAll('.amx-plugtable .amx-db-rosub').length,
      acts: document.querySelectorAll('.amx-plugtable .amx-db-actbtn[data-act="m-edit"]').length,
      selText: document.querySelector('.amx-plugtable .amx-db-chip')?.textContent || '',
      toneChips: document.querySelectorAll('.amx-plugtable .amx-db-chip--green, .amx-plugtable .amx-db-chip--muted').length, // option.color → 语义色芯片,不按 label 哈希
    }))
    check('T4 select 芯片(显示 option.label,按 option.color 取色)/ 头像 / 第二行 / 操作按钮都上屏', s4.chips >= 5 && s4.toneChips >= 5 && s4.avatars >= 1 && s4.subs >= 2 && s4.acts === 5, JSON.stringify(s4))

    const s4b = await page.evaluate(() => {
      const heads = [...document.querySelectorAll('.amx-plugtable .amx-db-hrow .amx-db-th')]
      const widths = heads.map((head) => Math.round(head.getBoundingClientRect().width))
      const first = document.querySelector('.amx-plugtable .amx-db-row:not(.amx-db-hrow) .amx-db-cell')
      const primary = first?.querySelector('.amx-db-roprimary')
      const secondary = first?.querySelector('.amx-db-rosub')
      const button = document.querySelector('.amx-plugtable .amx-db-autosize')
      return {
        pressed: button?.getAttribute('aria-pressed'),
        widths,
        primaryFits: !!primary && primary.scrollWidth <= primary.clientWidth + 1,
        secondaryClips: !!secondary && secondary.scrollWidth > secondary.clientWidth + 1,
      }
    })
    check('T4b 自适应默认开:主内容完整、副内容超长仍截断，短枚举列不再平分剩余宽度',
      s4b.pressed === 'true' && s4b.primaryFits && s4b.secondaryClips && s4b.widths[0] < 240 && s4b.widths[3] <= 110 && s4b.widths[4] <= 110,
      JSON.stringify(s4b))
    const autoButton = page.locator('.amx-plugtable .amx-db-autosize')
    await autoButton.click()
    const autoOff = await autoButton.getAttribute('aria-pressed')
    await autoButton.click()
    const autoOn = await autoButton.getAttribute('aria-pressed')
    check('T4c 自适应按钮可关闭并再次开启', autoOff === 'false' && autoOn === 'true', `off=${autoOff} on=${autoOn}`)

    await shot(page, 'tablemount-1-light')

    // T5:点一格非交互区(日期列)= 开行
    await page.locator(`${ROWS} >> nth=0`).locator('.amx-db-cell').nth(2).click()
    await page.waitForTimeout(120)
    const s5 = await page.evaluate(() => window.__tableMount.opened.slice())
    check('T5 行点击 → onRowOpen 恰好一次', s5.length === 1, `opened=${JSON.stringify(s5)}`)

    // T6:点操作按钮既不算开行,又要以原生 click 冒泡到宿主(面板的委托监听靠它)
    await page.locator('.amx-plugtable .amx-db-actbtn[data-act="m-edit"] >> nth=0').click()
    await page.waitForTimeout(120)
    const s6 = await page.evaluate(() => ({ opened: window.__tableMount.opened.length, acts: window.__tableMount.acts.slice() }))
    check('T6 点操作按钮:不触发 onRowOpen,且 data-act 冒泡到宿主委托', s6.opened === 1 && s6.acts.includes('m-edit'), `opened=${s6.opened} acts=${JSON.stringify(s6.acts)}`)

    // T7:弹层必须逃出插件皮肤(挂载点外面就是 container-type + overflow:auto 的盒子)
    await page.locator('.amx-plugtable .amx-db-hrow .amx-db-thbtn >> nth=0').click({ button: 'right' })
    await page.waitForSelector('.amx-db-pop', { timeout: 5000 })
    const s7 = await page.evaluate(() => {
      const pop = document.querySelector('.amx-db-pop')
      const r = pop.getBoundingClientRect()
      // ⚠️ 点位取**弹层自己的内边距**(左上 +4/+4),不能取中心:中心落在第一条菜单项上,
      //    点下去会改列配置甚至把菜单自己关掉 —— 那样 T7b 红绿都不是它想测的东西。
      const cx = Math.round(r.left + 4)
      const cy = Math.round(r.top + 4)
      const hit = document.elementFromPoint(cx, cy)
      return {
        inHost: !!pop.closest('.amx-plugtable-pops'),
        visible: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && r.width > 0 && r.height > 0,
        onTop: !!(hit && (pop === hit || pop.contains(hit))),
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
        vp: [innerWidth, innerHeight],
        cx, cy,
      }
    })
    check('T7 弹层传送到 body 级宿主、整块在视口内、点得到(没被 .fsa-adm 的 container-type/overflow 吃掉)',
      s7.inHost && s7.visible && s7.onTop, JSON.stringify(s7))
    await shot(page, 'tablemount-2-pop')
    // 点弹层内部不许关(body 级宿主对「点外面关菜单」而言必须算「里面」)
    await page.mouse.click(s7.cx, s7.cy)
    await page.waitForTimeout(150)
    const stillOpen = await page.locator('.amx-db-pop').count()
    await page.mouse.click(6, 6) // 点外面才关
    await page.waitForTimeout(200)
    const closed = await page.locator('.amx-db-pop').count()
    check('T7b 点弹层里面不关、点外面才关', stillOpen >= 1 && closed === 0, `inside=${stillOpen} outside=${closed}`)

    // T8:表头点击就地排序 + 回调面板
    const firstBefore = await page.locator(`${ROWS} >> nth=0`).innerText()
    await page.locator('.amx-plugtable .amx-db-hrow .amx-db-thbtn >> nth=1').click() // calls 列(数值 sortValue):升序后 Aeon-mini(3) 领头
    await page.waitForTimeout(200)
    const s8 = await page.evaluate(() => ({ sorts: window.__tableMount.sorts.slice() }))
    const firstAfter = await page.locator(`${ROWS} >> nth=0`).innerText()
    check('T8 表头点击就地排序,并把新排序回调给面板(onSort)',
      firstAfter !== firstBefore && s8.sorts.length >= 1 && s8.sorts[s8.sorts.length - 1] && s8.sorts[s8.sorts.length - 1].key === 'calls',
      `${JSON.stringify(firstBefore.split('\n')[0])} → ${JSON.stringify(firstAfter.split('\n')[0])} sorts=${JSON.stringify(s8.sorts)}`)

    // T9:update(3) —— 原地重渲染,不许重挂
    await page.evaluate(() => { document.querySelector('.amx-plugtable').__mark = 'keep' })
    await page.evaluate(() => window.__tableMount.update(3))
    await page.waitForFunction((sel) => document.querySelectorAll(sel).length === 3, ROWS, { timeout: 5000 })
    const s9 = await page.evaluate((sel) => ({
      rows: document.querySelectorAll(sel).length,
      same: document.querySelector('.amx-plugtable').__mark === 'keep',
      lastRendered: window.__tableMount.renderedRows[window.__tableMount.renderedRows.length - 1],
      popHosts: document.querySelectorAll('body > .amx-plugtable-pops').length,
    }), ROWS)
    check('T9 update(3):行数变 3、根元素身份不变(原地重渲染而非重挂)', s9.rows === 3 && s9.same && s9.popHosts === 1, JSON.stringify(s9))
    check('T9b onRender 那一发读到的是**新**行数(回调早于数据落地 = 面板拿到上一批 DOM)', s9.lastRendered === 3, `lastRendered=${s9.lastRendered}`)

    const firstAfterUpdate = await page.locator(`${ROWS} >> nth=0`).innerText()
    // 三行里按 calls 升序领头的是 Qwen3-Max(9);插入序领头的是 DeepSeek —— 两者可分,排序丢了就红。
    check('T10 update 之后用户的排序仍在(数据刷新不许把排序冲掉)',
      firstAfterUpdate.includes('Qwen3-Max'), `${JSON.stringify(firstAfter.split('\n')[0])} → ${JSON.stringify(firstAfterUpdate.split('\n')[0])}`)

    // T11:dispose —— React 树是微任务里卸的,等它
    await page.evaluate(() => window.__tableMount.dispose())
    await page.waitForFunction(() => !document.querySelector('.amx-plugtable') && !document.querySelector('.amx-plugtable-pops'), null, { timeout: 5000 }).catch(() => {})
    const s11 = await page.evaluate(() => ({
      table: document.querySelectorAll('.amx-plugtable').length,
      host: document.querySelectorAll('.amx-plugtable-pops').length,
    }))
    check('T11 dispose:表体与 body 级弹层宿主都收干净', s11.table === 0 && s11.host === 0, JSON.stringify(s11))

    // T12:暗色 —— 芯片色板挂在 .am-app[data-mode='dark'] 上,外层与弹层宿主都得带
    await page.goto(`${BASE}?tablemount&dark`)
    await page.waitForSelector(ROWS, { timeout: 15000 })
    const s12 = await page.evaluate(() => ({
      wrap: document.querySelector('.amx-plugtable')?.getAttribute('data-mode'),
      host: document.querySelector('.amx-plugtable-pops')?.getAttribute('data-mode'),
    }))
    check('T12 暗色:外层与 body 级弹层宿主都带 data-mode="dark"', s12.wrap === 'dark' && s12.host === 'dark', JSON.stringify(s12))
    await shot(page, 'tablemount-3-dark')

    // Group + autocomplete: use the actual native table, not the panel fixture's fallback table.
    const query = page.locator('.amx-db-search')
    check('T14 搜索显式关闭自动填充，非编辑态只读', await query.getAttribute('type') === 'search' && await query.getAttribute('autocomplete') === 'off' && await query.getAttribute('readonly') !== null)
    await query.evaluate((input) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'https://api.siliconflow.cn/v1')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    check('T14b 后台填入地址不触发筛选且被清理', await page.locator(ROWS).count() === 5 && await query.inputValue() === '')
    await query.click()
    await query.fill('Qwen')
    await page.waitForFunction((sel) => document.querySelectorAll(sel).length === 1, ROWS)
    await query.fill('')
    await page.mouse.click(6, 6)
    check('T14c 手动输入与清空正常', await page.locator(ROWS).count() === 5)

    await page.locator('.amx-db-groupbtn').click()
    const gm = page.locator('.amx-db-group-menu')
    await gm.getByLabel('按属性分组', { exact: true }).selectOption('state')
    check('T15 单选组显示名称和数量，空组可见', await page.locator('.amx-db-group').count() === 3 && (await page.locator('.amx-db-grouphead').first().innerText()).includes('启用'))
    await gm.getByLabel('隐藏空组', { exact: true }).check()
    check('T15b 隐藏空组立即生效', await page.locator('.amx-db-group').count() === 2)
    await gm.getByRole('button', { name: '上移 停用', exact: true }).click()
    check('T15c 手动调整组序', (await page.locator('.amx-db-grouphead').first().innerText()).includes('停用'))
    await gm.getByRole('button', { name: '隐藏 启用', exact: true }).click()
    check('T15d 隐藏组不删除数据', await page.locator(ROWS).count() === 2)
    await gm.getByRole('button', { name: '显示 启用', exact: true }).click()
    await gm.getByRole('button', { name: '折叠全部', exact: true }).click()
    check('T15e 折叠后保留组头与数量', await page.locator(ROWS).count() === 0 && await page.locator('.amx-db-grouphead').count() === 2)
    await gm.getByRole('button', { name: '展开全部', exact: true }).click()
    await page.evaluate(() => window.__tableMount.update(3))
    await page.waitForFunction((sel) => document.querySelectorAll(sel).length === 3, ROWS)
    check('T15f 数据刷新保留组序和隐藏空组', (await page.locator('.amx-db-grouphead').first().innerText()).includes('停用') && await gm.getByLabel('隐藏空组').isChecked())
    check('T15g 分组菜单控件没有被弹层裁切', await gm.evaluate((el) => {
      const r = el.closest('.amx-db-pop').getBoundingClientRect()
      return [...el.querySelectorAll('select,input,button')].every((c) => { const b = c.getBoundingClientRect(); return b.left >= r.left && b.right <= r.right + 1 })
    }))
    await shot(page, 'tablemount-4-group-menu-dark')
    await page.mouse.click(6, 6)
    await shot(page, 'tablemount-5-grouped-dark')

    await page.goto(`${BASE}?tablemount&tablegroup`)
    await page.waitForSelector('.amx-db-group')
    check('T16 插件初始分组规格生效', await page.locator('.amx-db-group').count() === 2 && (await page.locator('.amx-db-grouphead').first().innerText()).includes('停用'))
    await shot(page, 'tablemount-6-grouped-light')

    check('T13 无未捕获页面错误', errors.length === 0, errors.slice(0, 2).join(' | '))
  } catch (e) {
    check('跑完', false, String(e))
    try {
      const dump = await page.evaluate(() => ({ text: document.body.innerText.slice(0, 300) }))
      console.error('BODY:', JSON.stringify(dump))
      console.error('ERRORS:', errors.slice(0, 5).join('\n'))
    } catch (e2) { /* 尽力 */ }
  } finally {
    await browser.close()
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  process.exit(failed.length ? 1 : 0)
})()
