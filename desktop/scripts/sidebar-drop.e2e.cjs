/**
 * 左栏笔记树的**拖放落区**端到端(真 Electron × 真 IPC × 真磁盘)。
 *
 * 为什么存在:用户实报「工作区 view 的笔记/文件子档,不能把外部文件拖到精准的位置进去」。
 * 根因是那些行**根本不是落区** —— 事件一路冒泡到根容器,于是不论悬停在哪儿,文件都落到库根。
 * 落点判定那半是纯函数(views/treeDrop.ts + treeDrop.test.ts);**这里钉的是接线**:
 * 行上到底有没有挂 dragover/drop、事件有没有被上层截走、落下去有没有真的写到那个目录。
 *
 * 覆盖:
 *   1 OS 文件拖到**文件夹行** → 落进该文件夹(不是库根)
 *   2 OS 文件拖到**笔记行**   → 进这篇笔记(附件落盘 + 正文出现引用)
 *   3 OS 文件拖到**根空白**   → 落库根(老行为不许回归)
 *   4 应用内路径拖拽(文件面板的行,PATHS_MIME)→ 复制进目标文件夹
 *   5 ⚠️ 同时带 REF_MIME 的路径拖拽(= 库里的行被拖着)**不许**当外来复制处理
 *   6/6b/7 文件档(FilesPanel):拖到**文件行** → 落进它所在的目录;库里的行=复制、自家的行=移动
 *   8/8b   PATHS 源必须声明 effectAllowed=copyMove(源码级守卫,理由见该处注释)+ 复合笔记带 .fd
 *   9      复合笔记(X.md + X.fd)复制进重名目录:两半必须同 stem,且不许动目标已有的同名笔记
 *
 * ⚠️ **文件档的 OS 文件那条覆盖不到**:FilesPanel 走 `getPathForFile(file)` 拿主机绝对路径再
 *    `copyHostFiles`,合成出来的 File 在磁盘上根本不存在 → 恒空。那半只能人工点。
 *
 * ⚠️ 合成 DragEvent + DataTransfer:HTML5 拖放没法用 mouse.down/move 驱动(浏览器不给合成 drag),
 *    与 chat-sidepanel.check.cjs 同一套路。代价:绕过了 OS→Chromium 那一段,真机上若「拖得动
 *    但没反应」,先怀疑 fileDropGuard / Dockview 那一层。
 * ⚠️ 库是**临时夹具**(预置 amadeus-config 的 lastVault),不碰本机真实库 —— 本用例会往库里写文件。
 * ⚠️ 先 npm run build:量的是 out/ 里的产物,源码改了没构建就是白测。
 *
 * 用法:npm run e2e:sidebardrop
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const PATHS_MIME = 'application/x-tangu-paths'
const REF_MIME = 'application/x-forsion-chatref'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok }) // !! —— 断言链遇 null 会短路成 null,按 ok===false 统计会漏项
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

/** 合成「拖 OS 文件」的悬停那一半:dt 挂到 window 上,drop 由 DO_DROP 补刀。
 *  ⚠️ 分两步是因为**落区高亮是 React 状态**:dragover 之后同一个 tick 里量 `.amx-drop-into`
 *  必然是 0(还没提交),会得出「没接住」的假红。 */
const DRAG_OVER = ({ sel, name, text, rowText }) => {
  const nodes = Array.from(document.querySelectorAll(sel))
  const el = rowText ? nodes.find((n) => (n.textContent || '').includes(rowText)) : nodes[0]
  // ⚠️ 找不到目标必须**清掉暂存**:留着上一次的 __dropEl,后面那步 DO_DROP 会往旧元素上再落一次,
  //    落成了 → 报 PASS = 假绿(第一次写这脚本就踩了)。
  if (!el) { window.__dropEl = null; window.__dropDT = null; return { err: 'no target for ' + sel + ' ' + (rowText || '') } }
  const dt = new DataTransfer()
  dt.items.add(new File([text], name, { type: 'text/plain' }))
  window.__dropDT = dt
  window.__dropEl = el
  el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
  return { ok: true, types: Array.from(dt.types), target: (el.textContent || '').trim().slice(0, 24) }
}
const DO_DROP = () => {
  const el = window.__dropEl, dt = window.__dropDT
  if (!el || !dt) return { err: 'no staged drag' }
  const highlighted = document.querySelectorAll('.amx-drop-into, .amx-drop-root').length
  el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  return { ok: true, highlighted }
}
/** 文件面板的落区高亮是另一套类名(.t2sf-row.drop),落点又是「父目录行」而不是被悬停的那行。 */
const DO_DROP_FILES = () => {
  const el = window.__dropEl, dt = window.__dropDT
  if (!el || !dt) return { err: 'no staged drag' }
  const highlighted = document.querySelectorAll('.t2sf-row.drop').length
  el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  return { ok: true, highlighted }
}

/** 真派发一次 dragstart,让**应用自己**往 dataTransfer 里写载荷与 effectAllowed —— 手搓 dt 的用例
 *  绕过了 DnD 的 copy/move 协商,正是 codex 揪出来的盲区。 */
const DRAG_START = ({ sel, rowText, pathsMime }) => {
  const nodes = Array.from(document.querySelectorAll(sel))
  const el = rowText ? nodes.find((n) => (n.textContent || '').includes(rowText)) : nodes[0]
  if (!el) { window.__dragDT = null; return { err: 'no source for ' + (rowText || sel) } }
  const dt = new DataTransfer()
  el.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }))
  window.__dragDT = dt
  let paths = null
  try { paths = JSON.parse(dt.getData(pathsMime) || 'null') } catch { /* 没带就是 null */ }
  return { ok: true, effectAllowed: dt.effectAllowed, types: Array.from(dt.types), paths }
}
/** 用上一步 dragstart 得到的**同一份** dt 投放到目标,并回报协商后的 dropEffect。 */
const DROP_STAGED = ({ sel, rowText }) => {
  const nodes = Array.from(document.querySelectorAll(sel))
  const el = rowText ? nodes.find((n) => (n.textContent || '').includes(rowText)) : nodes[0]
  const dt = window.__dragDT
  if (!el || !dt) return { err: 'no target / no staged dragstart' }
  el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
  const dropEffect = dt.dropEffect
  el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  return { ok: true, dropEffect, target: (el.textContent || '').trim().slice(0, 24) }
}

/** 合成「应用内路径拖拽」(文件面板的行);withRef=同时带 REF_MIME(= 库里的行被拖着)。 */
const DROP_PATHS = ({ sel, paths, rowText, withRef, pathsMime, refMime }) => {
  const nodes = Array.from(document.querySelectorAll(sel))
  const el = rowText ? nodes.find((n) => (n.textContent || '').includes(rowText)) : nodes[0]
  if (!el) return { err: 'no target' }
  const dt = new DataTransfer()
  dt.setData(pathsMime, JSON.stringify(paths))
  if (withRef) dt.setData(refMime, JSON.stringify(paths.map((p) => ({ kind: 'note', path: p }))))
  const opt = { dataTransfer: dt, bubbles: true, cancelable: true }
  el.dispatchEvent(new DragEvent('dragover', opt))
  el.dispatchEvent(new DragEvent('drop', opt))
  return { ok: true, types: Array.from(dt.types), target: (el.textContent || '').trim().slice(0, 24) }
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }

  /** 工作区 sub list 已改为下拉菜单；按第几个工作区面板选中精确档位。 */
  const selectWorkspaceMode = async (win, index, modeId) => {
    const picker = win.locator('.t2sw-mode-picker').nth(index)
    const item = picker.locator(`[data-workspace-mode="${modeId}"]`)
    // 前序拖放可能让菜单保留在展开态；只在目标项不可见时打开，避免反手把已开的菜单关掉。
    if (!(await item.isVisible().catch(() => false))) {
      await picker.locator('.t2sw-mode-trigger').click({ timeout: 10_000 })
    }
    await item.click({ timeout: 10_000 })
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-sbdrop-'))
  const userData = path.join(home, 'userdata')
  const vault = path.join(home, 'Vault')
  const outside = path.join(home, 'Outside') // 模拟「文件面板里的主机目录」
  fs.mkdirSync(path.join(vault, '子文件夹'), { recursive: true })
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(path.join(vault, '笔记A.md'), '# 笔记A\n\n正文一行\n', 'utf8')
  fs.writeFileSync(path.join(vault, '子文件夹', '子笔记.md'), '# 子笔记\n', 'utf8')
  // 复合笔记(X.md + 同名 X.fd)+ 目标目录里**已有同名 .md**:钉「两半必须同 stem 落地」。
  fs.mkdirSync(path.join(vault, '合并.fd'), { recursive: true })
  fs.writeFileSync(path.join(vault, '合并.md'), '# 合并\n', 'utf8')
  fs.writeFileSync(path.join(vault, '合并.fd', '子笔记2.md'), '# 子笔记2\n', 'utf8')
  fs.writeFileSync(path.join(vault, '子文件夹', '合并.md'), '# 目标里本来就有一篇同名的\n', 'utf8')
  fs.writeFileSync(path.join(outside, '外来.txt'), '来自文件面板\n', 'utf8')
  // ⚠️ 未打包时主进程把 userData 目录改成 `<--user-data-dir>-dev`(electron/main.ts:61),
  //    只种 --user-data-dir 那份 = 应用照样开**本机 dev 库**(~/Forsion-Dev/Amadeus)= 往真库里写文件。
  //    dev / 正式版还分用两个配置文件名(electron/amadeus/settings.ts),四份全种最省事。
  for (const dir of [userData, `${userData}-dev`]) {
    fs.mkdirSync(dir, { recursive: true })
    for (const f of ['amadeus-config.json', 'amadeus-config.dev.json']) {
      fs.writeFileSync(path.join(dir, f), JSON.stringify({ lastVault: vault, localVault: vault }, null, 2), 'utf8')
    }
  }
  const shot = path.join(os.tmpdir(), `forsion-sbdrop-${process.pid}.png`)

  let app
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT],
      cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: 'http://127.0.0.1:1' },
    })
    const win = await app.firstWindow()
    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })

    // Amadeus Space:左栏 = 笔记树(window.amadeus 在才注册这个 Space)。
    const spaceBtn = win.locator('.rb-space[title="Amadeus"], .rb-space:has-text("Amadeus")').first()
    await spaceBtn.click({ timeout: 15_000 })
    await win.waitForTimeout(3000)
    await win.waitForSelector('.t2s-srow, .t2s-group', { timeout: 20_000 })

    const seen = await win.evaluate(`(() => ({
      rows: Array.from(document.querySelectorAll('.t2s-srow, .t2s-group')).map((e) => (e.textContent || '').trim().slice(0, 20)),
    }))()`)
    const fixtureOn = seen.rows.some((r) => r.includes('笔记A')) && seen.rows.some((r) => r.includes('子文件夹'))
    check('0 夹具库装上了(树里看得见 笔记A / 子文件夹)', fixtureOn, JSON.stringify(seen.rows.slice(0, 8)))
    // ⚠️ 认错库就**立刻停**:后面每一步都往库里写文件,开着本机真库跑 = 往用户库里丢垃圾。
    if (!fixtureOn) throw new Error('夹具库没装上(多半是 userData 目录名判错),拒绝继续 —— 详见文件头')

    // ── 1 拖到文件夹行 → 落进该文件夹 ────────────────────────────────────────
    const r1 = await win.evaluate(DRAG_OVER, { sel: '.t2s-group, .t2s-srow', name: '落到文件夹.txt', text: '文件夹内容', rowText: '子文件夹' })
    await win.waitForTimeout(400)
    const d1 = await win.evaluate(DO_DROP)
    await win.waitForTimeout(2500)
    const inFolder = fs.existsSync(path.join(vault, '子文件夹', '落到文件夹.txt'))
    const atRootWrong = fs.existsSync(path.join(vault, '落到文件夹.txt'))
    check('1 OS 文件拖到文件夹行 → 落进那个文件夹', inFolder && !atRootWrong,
      `${JSON.stringify(r1)} | 文件夹里=${inFolder} 库根里(错)=${atRootWrong}`)
    check('1b 悬停时确实点亮了落区(dragover 有接住)', (d1.highlighted || 0) > 0, `highlighted=${d1 && d1.highlighted}`)

    // ── 2 拖到笔记行 → 进这篇笔记(附件落盘 + 正文引用)──────────────────────
    const r2 = await win.evaluate(DRAG_OVER, { sel: '.t2s-srow', name: '进笔记.txt', text: '附件内容', rowText: '笔记A' })
    await win.waitForTimeout(400)
    await win.evaluate(DO_DROP)
    await win.waitForTimeout(6000) // openNote → 等页面激活 → saveAttachment → 落盘
    // 正文引用先看编辑器(落盘有防抖),再看磁盘 —— 只看磁盘会把「插进去了但还没存」误判成没插。
    const diag = await win.evaluate(`(() => ({
      tabs: Array.from(document.querySelectorAll('.dv-tab')).map((e) => (e.textContent || '').trim()).slice(0, 5),
      pm: ((document.querySelector('.ProseMirror') || {}).innerText || '').slice(0, 200),
      body: ((document.querySelector('.am-app') || {}).innerText || '').slice(0, 200),
    }))()`)
    const noteBody = fs.readFileSync(path.join(vault, '笔记A.md'), 'utf8')
    const attached = fs.readdirSync(vault, { recursive: true }).some((p) => String(p).includes('进笔记.txt'))
    check('2 OS 文件拖到笔记行 → 附件真的落进库里', attached, `目标=${r2 && r2.target}`)
    check('2b 并且正文里出现了对它的引用(嵌入或链接)', /进笔记/.test(diag.pm) || /进笔记/.test(noteBody),
      `编辑器=${JSON.stringify(diag.pm.slice(-80))} 磁盘=${JSON.stringify(noteBody.slice(-120))}`)

    // ── 3 根空白 → 库根(老行为不许回归)────────────────────────────────────
    const r3 = await win.evaluate(DRAG_OVER, { sel: '.t2s-group-sessions, .t2s-scroll', name: '落到根.txt', text: '根内容', rowText: null })
    await win.waitForTimeout(400)
    await win.evaluate(DO_DROP)
    await win.waitForTimeout(2500)
    check('3 拖到根空白仍然落库根', fs.existsSync(path.join(vault, '落到根.txt')), JSON.stringify(r3))

    // ── 4 应用内路径拖拽 → 复制进目标文件夹 ────────────────────────────────
    const r4 = await win.evaluate(DROP_PATHS, { sel: '.t2s-group, .t2s-srow', paths: [path.join(outside, '外来.txt')], rowText: '子文件夹', withRef: false, pathsMime: PATHS_MIME, refMime: REF_MIME })
    await win.waitForTimeout(3000)
    check('4 文件面板的行(PATHS_MIME)拖进笔记树 → 复制进那个文件夹',
      fs.existsSync(path.join(vault, '子文件夹', '外来.txt')),
      `${JSON.stringify(r4)} | 原件还在=${fs.existsSync(path.join(outside, '外来.txt'))}`)

    // ── 5 ⚠️ 带 REF_MIME = 库里的行被拖着,不许走外来复制这条 ──────────────
    fs.writeFileSync(path.join(outside, '不该进来.txt'), 'x\n', 'utf8')
    await win.evaluate(DROP_PATHS, { sel: '.t2s-group, .t2s-srow', paths: [path.join(outside, '不该进来.txt')], rowText: '子文件夹', withRef: true, pathsMime: PATHS_MIME, refMime: REF_MIME })
    await win.waitForTimeout(2500)
    check('5 ⚠️ 同时带 REF_MIME(库里的行)不当外来复制处理',
      !fs.existsSync(path.join(vault, '子文件夹', '不该进来.txt')),
      '带 REF_MIME 时若也复制 = 树内搬笔记会被这条分支抢走')

    // ── 6 文件档:拖到**文件行** → 落进它所在的目录(此前文件行不是落区,会一路冒泡到工作区根)──
    // 编辑器开着时,库本身就是文件面板里的一个工作区(WorkspaceView.FilesBody 的 vaultCtx 合并)。
    await selectWorkspaceMode(win, 0, 'files')
    await win.waitForTimeout(1500)
    // 逐层展开:工作区头 → 子文件夹(懒加载,各等一拍)
    // 工作区头是 .t2s-group(与笔记树同构),其下的目录行才是 .t2sf-row —— 逐层展开各等一拍(懒加载)。
    // ⚠️ 工作区头要点它**内部那个 toggle 按钮**(.t2s-group 这层 div 上没有 onClick);而且它可能
    //    **本来就是展开的**(别处「进入」过这个工作区会自动展开)—— 一次点击反而收起来,故点到出为止。
    const expandUntil = async (clickSel, wantSel) => {
      for (let i = 0; i < 3; i++) {
        if (await win.locator(wantSel).count().catch(() => 0)) return true
        const el = win.locator(clickSel).first()
        if (!(await el.count().catch(() => 0))) return false
        await el.click().catch(() => {})
        await win.waitForTimeout(1500)
      }
      return !!(await win.locator(wantSel).count().catch(() => 0))
    }
    await expandUntil('.t2s-group:has-text("Vault") .t2s-group-toggle', '.t2sf-row')
    await expandUntil('.t2sf-row:not(.t2sf-file):has-text("子文件夹")', '.t2sf-row.t2sf-file:has-text("子笔记.md")')
    fs.writeFileSync(path.join(outside, '外来2.txt'), '复制我\n', 'utf8')
    fs.writeFileSync(path.join(outside, '搬走.txt'), '搬我\n', 'utf8')
    const FILE_ROW = '.t2sf-row.t2sf-file'
    const r6 = await win.evaluate(DROP_PATHS, { sel: FILE_ROW, paths: [path.join(outside, '外来2.txt')], rowText: '子笔记.md', withRef: true, pathsMime: PATHS_MIME, refMime: REF_MIME })
    await win.waitForTimeout(3000)
    check('6 文件档:拖到**文件行** → 落进它所在的目录(此前文件行不是落区,会冒泡到工作区根)',
      fs.existsSync(path.join(vault, '子文件夹', '外来2.txt')) && !fs.existsSync(path.join(vault, '外来2.txt')),
      `${JSON.stringify(r6)} | 目录里=${fs.existsSync(path.join(vault, '子文件夹', '外来2.txt'))} 工作区根(错)=${fs.existsSync(path.join(vault, '外来2.txt'))}`)
    check('6b 库里的行(带 REF_MIME)拖进文件面板 = **复制**,原件不许被搬走',
      fs.existsSync(path.join(outside, '外来2.txt')),
      '库里的笔记还有 .fd / 反链 / 同步在依赖它,move 等于把它从库里挖走')

    // ── 7 文件面板自家的行拖(只带路径)照旧是**移动**,别被 6b 改宽了 ────────────
    await win.evaluate(DROP_PATHS, { sel: FILE_ROW, paths: [path.join(outside, '搬走.txt')], rowText: '子笔记.md', withRef: false, pathsMime: PATHS_MIME, refMime: REF_MIME })
    await win.waitForTimeout(3000)
    check('7 纯路径载荷(文件面板自家的行)仍是移动:目标有了、源没了',
      fs.existsSync(path.join(vault, '子文件夹', '搬走.txt')) && !fs.existsSync(path.join(outside, '搬走.txt')),
      `目标=${fs.existsSync(path.join(vault, '子文件夹', '搬走.txt'))} 源还在=${fs.existsSync(path.join(outside, '搬走.txt'))}`)

    // ── 8 DnD 协商:PATHS 源必须声明 copyMove ──────────────────────────────────
    // ⚠️ 只能做**源码级**守卫:合成 DragEvent 里 effectAllowed 读回来恒 'none'(Chromium 只在真
    // dragstart 的读写态里认),运行时断言在这儿必然假红。真协商只有人手拖才验得了。
    const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
    const filesPanelSrc = src('frontend/src/views/chat2/FilesPanel.tsx')
    const rightPanelSrc = src('frontend/src/components/RightPanel.tsx')
    const viewsSrc = src('frontend/src/amadeusViews.tsx')
    check("8 PATHS 拖源都声明 effectAllowed='copyMove'(只声明 move,落区声明 copy → 协商取交集 = 整个不许落)",
      filesPanelSrc.includes("effectAllowed = 'copyMove'") && !filesPanelSrc.includes("effectAllowed = 'move'")
        && rightPanelSrc.includes("effectAllowed = 'copyMove'") && !rightPanelSrc.includes("effectAllowed = 'move'")
        && viewsSrc.includes("effectAllowed = 'copyMove'"),
      'FilesPanel / RightPanel / 笔记树行拖三处')
    // 复合笔记的行拖要把自己的 .fd 一起带上,否则子笔记会被落下(9 的前置)。
    await selectWorkspaceMode(win, (await win.locator('.t2sw-mode-picker').count()) - 1, 'notes')
    await win.waitForTimeout(1500)
    const noteSrc = await win.evaluate(DRAG_START, { sel: '.t2s-srow', rowText: '合并', pathsMime: PATHS_MIME })
    check('8b 笔记树的行拖:复合笔记连自己的 .fd 一起带走',
      Array.isArray(noteSrc.paths) && noteSrc.paths.some((p) => p.endsWith('合并.md')) && noteSrc.paths.some((p) => p.endsWith('合并.fd')),
      JSON.stringify(noteSrc))

    // ── 9 复合笔记落进**已有同名 .md** 的目录:两半必须拿同一个 stem ────────────────
    await selectWorkspaceMode(win, 0, 'files')
    await win.waitForTimeout(1500)
    await expandUntil('.t2s-group:has-text("Vault") .t2s-group-toggle', '.t2sf-row')
    const d9 = await win.evaluate(DROP_STAGED, { sel: '.t2sf-row:not(.t2sf-file)', rowText: '子文件夹' })
    await win.waitForTimeout(3500)
    const sub = path.join(vault, '子文件夹')
    const pairOk = fs.existsSync(path.join(sub, '合并 (1).md')) && fs.existsSync(path.join(sub, '合并 (1).fd', '子笔记2.md'))
    check('9 ⚠️ 复合笔记复制到重名目录:.md 与 .fd 同 stem 落地(不许一个改名一个不改)',
      pairOk && !fs.existsSync(path.join(sub, '合并.fd')),
      `${JSON.stringify(d9)} | 目录里=${JSON.stringify(fs.readdirSync(sub))}`)
    // (光标的 dropEffect 同样读不回 —— 见 8 的说明;代码里已按 REF_MIME 显式置 copy/move。)
    check('9c 目标原有的同名笔记没被动过',
      fs.readFileSync(path.join(sub, '合并.md'), 'utf8').includes('目标里本来就有'),
      '被覆盖 = 用户的文件被拖拽吃掉了')

    // 交付截图顺带覆盖新的 sub list 下拉展开态：菜单应叠在列表上方，不把工作区 body 顶下去。
    await win.locator('.t2sw-mode-picker').first().locator('.t2sw-mode-trigger').click({ timeout: 10_000 })
    await win.locator('.t2sw-mode-menu').first().waitFor({ state: 'visible', timeout: 10_000 })
    await win.waitForTimeout(280) // 等 220ms 弹性展开结束；中途截图会把整张菜单连文字一起拍成半透明
    await win.screenshot({ path: shot })
    console.log(`\n截图:${shot}`)
  } finally {
    if (app) await app.close().catch(() => {})
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) { console.log('失败:', failed.map((f) => f.name).join(' / ')); process.exit(1) }
}

main().catch((e) => { console.error(e); process.exit(1) })
