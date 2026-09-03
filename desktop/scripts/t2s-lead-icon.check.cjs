/**
 * 笔记树「前导槽」尺寸/对齐契约检查(真 Chromium 断言)。
 *
 * 为什么存在:用户的要求本身就是几何命题 ——「多维表/白板/附件的图标要和 emoji 一样大」+
 * 「没 emoji 的 md 显示文件图标」。而工作区视图是 electron-only(window.amadeus),web harness
 * 渲染不了,肉眼只能靠实机。契约靠三条 CSS 咬合:
 *   .t2s-lead{font-size:13px}          ← 槽 = 尺寸唯一旋钮
 *   .amx-page-emoji{font-size:1em}     ← emoji 跟槽
 *   .t2s-lead-icon{width/height:1em}   ← 图标跟槽(且要压过 lucide 的 width="24" 表现属性)
 *   .t2sw .amx-tree .t2s-lead{font-size:1.3em}  ← 工作区里一起放大
 * 任何一条被改回「只调 .amx-page-emoji」,两者就又不一样大了 —— 故钉住。
 *
 * 页面注入仓里**真实的** amadeus-host.css + sidebar2.css(不复制样式),故不会与源码漂移。
 *
 * 跑:node scripts/t2s-lead-icon.check.cjs [--shot]  (需 playwright-core 自装的 chromium;CHROMIUM_EXE 可覆盖)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  const dirs = fs.readdirSync(root).filter((d) => d.startsWith('chromium-')).sort()
  for (const d of dirs.reverse()) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8')
const HOST_CSS = read('../frontend/src/amadeus-host.css')
const SIDEBAR_CSS = read('../frontend/src/views/chat2/sidebar2.css')

/** lucide-react 出的就是这形状:width/height **表现属性**=24,靠 CSS 压过去。
 *  dim: 文件/多维表/白板的兜底图标带 .t2s-dim(opacity .7);文件夹图标不带 —— 与真实 JSX 一致。 */
const icon = (dim = true) => `<svg class="t2s-lead-icon${dim ? ' t2s-dim' : ''}" width="24" height="24" viewBox="0 0 24 24" stroke-width="2"><path d="M4 4h16v16H4z"/></svg>`
/** 裸 lucide(无 .t2s-lead-icon):分区槽靠 `槽 > svg` 规则压尺寸。 */
const sv = () => '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg>'

/** 可展开行的槽:图标 + 叠放的箭头(hover 互换)。 */
const chev = () => '<span class="t2s-chev t2s-lead-chev open"><svg width="12" height="12" viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg></span>'

// depth 0 的两种行:笔记行 padding-left=rowPadLeft(0)=14;文件夹行外层=folderPadLeft(0)=9.5(见 treeIndent.ts)
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  :root { --bg-card:#fff; --bg:#fff; --border:#ddd; --border-width:1px; --overlay-light:#eee;
          --text:#111; --text-muted:#666; --text-faint:#999; --accent:#6c5ce7; --accent-ink:#333;
          --font-ui:system-ui; --duration-fast:0.15s; }
  body { margin:0; }
  ${HOST_CSS}
  ${SIDEBAR_CSS}
  /* 关掉过渡:getComputedStyle 会读到动画的中间值,让 hover 断言变成时序赌博。 */
  * { transition: none !important; animation: none !important; }
</style></head><body>
  <div class="t2sw" style="width:320px">
    <aside class="t2s-side t2s-side-probe">
     <!-- 真实根容器就是 .t2s-group-sessions(flex column, gap:1px);文件夹节点外面还裹一层 div。 -->
     <div class="t2s-group-sessions">
      <div><div class="t2s-group" id="folder" style="padding-left:9.5px">
        <button class="t2s-group-toggle t2s-folder-row">
          <span class="t2s-lead">${icon(false)}${chev()}</span>
          <span class="t2s-group-label">文件夹A</span>
        </button>
      </div></div>
      <div><div class="t2s-group" id="folder2" style="padding-left:9.5px">
        <button class="t2s-group-toggle t2s-folder-row">
          <span class="t2s-lead">${icon(false)}${chev()}</span>
          <span class="t2s-group-label">文件夹B</span>
        </button>
      </div></div>
      <button class="t2s-srow" id="emoji" style="padding-left:14px">
        <span class="t2s-lead"><span class="amx-page-emoji">📄</span></span>
        <span class="t2s-srow-title">有 emoji 的笔记</span>
      </button>
      <button class="t2s-srow" id="plain" style="padding-left:14px">
        <span class="t2s-lead">${icon()}</span>
        <span class="t2s-srow-title">没 emoji 的 md</span>
      </button>
      <button class="t2s-srow" id="db" style="padding-left:14px">
        <span class="t2s-lead">${icon()}</span>
        <span class="t2s-srow-title">多维表.db</span>
      </button>
      <button class="t2s-srow" id="merged" style="padding-left:14px">
        <span class="t2s-lead">${icon()}${chev()}</span>
        <span class="t2s-srow-title">有子目录的笔记</span>
      </button>
     </div>
    </aside>
  </div>

  <!-- 分区行的图标槽:各 section 自有行结构、没走 .t2s-lead,但必须吃同一个 --t2s-icon。
       用户连报四次「图标还是小的」都出在这一族 —— 每加一个 section 就漏一个。 -->
  <div class="t2sw" style="width:320px"><aside class="t2s-side amx-tree">
    <button class="t2s-special" id="special"><span class="t2s-special-ic" id="ic-special">${sv()}</span><span class="t2s-special-title">新建笔记</span></button>
    <div class="amx-cs-row"><span class="amx-cs-ic" id="ic-cs">${sv()}</span><span class="t2s-srow-title">云同步条目</span></div>
    <div class="amx-coll-row"><span class="amx-coll-ic" id="ic-coll">${sv()}</span><span class="t2s-srow-title">集合条目</span></div>
    <div><span class="amx-trash-ic" id="ic-trash">${sv()}</span><span class="t2s-srow-title">回收站条目</span></div>
  </aside></div>

  <!-- 会话 view:组头 folderPadLeft(0)=9.5;会话行 rowPadLeft(1)=24.5(缩进一级) -->
  <div class="t2sw" style="width:320px"><aside class="t2s-side">
    <div class="t2s-group" id="s-group" style="padding-left:9.5px">
      <button class="t2s-group-toggle t2s-folder-row">
        <span class="t2s-lead">${icon(false)}${chev()}</span>
        <span class="t2s-group-label">工作区</span>
      </button>
    </div>
    <div class="t2s-group-sessions">
      <button class="t2s-srow" id="s-row" style="padding-left:24.5px">
        <span class="t2s-lead">${icon()}<span class="t2s-dot running"></span></span>
        <span class="t2s-srow-title">有状态点的会话</span>
      </button>
      <button class="t2s-srow" id="s-row2" style="padding-left:24.5px">
        <span class="t2s-lead">${icon()}</span>
        <span class="t2s-srow-title">无状态点的会话</span>
      </button>
    </div>
  </aside></div>

  <!-- 文件 view:组头 9.5;文件/文件夹行 rowPadLeft(depth+1) -->
  <div class="t2sw" style="width:320px"><aside class="t2s-side">
    <div class="t2s-group" id="f-group" style="padding-left:9.5px">
      <button class="t2s-group-toggle t2s-folder-row">
        <span class="t2s-lead">${icon(false)}${chev()}</span>
        <span class="t2s-group-label">工作区</span>
      </button>
    </div>
    <div class="t2sf-row" id="f-dir" style="padding-left:24.5px">
      <span class="t2s-lead">${icon(false)}${chev()}</span>
      <span class="t2sf-name">文件夹</span>
    </div>
    <div class="t2sf-row t2sf-file" id="f-file" style="padding-left:24.5px">
      <span class="t2s-lead">${icon()}</span>
      <span class="t2sf-name">文件.txt</span>
    </div>
  </aside></div>
</body></html>`

const measure = () => {
  const q = (s) => document.querySelector(s)
  /** 图标/emoji 的**实际左边缘**(不是行的 padding)—— 用户要的「所有图标开头左侧对齐」就是这条竖线。 */
  const lead = (id) => q(`#${id} .t2s-lead`).getBoundingClientRect().left
  const iconBox = (id) => q(`#${id} .t2s-lead-icon`).getBoundingClientRect()
  return {
    rowFont: parseFloat(getComputedStyle(q('#emoji')).fontSize),
    folderFont: parseFloat(getComputedStyle(q('#folder .t2s-folder-row')).fontSize),
    emojiFont: parseFloat(getComputedStyle(q('#emoji .amx-page-emoji')).fontSize),
    iconW: iconBox('plain').width,
    iconH: iconBox('plain').height,
    folderIconW: iconBox('folder').width,
    leadFolder: lead('folder'),
    leadEmoji: lead('emoji'),
    leadPlain: lead('plain'),
    leadDb: lead('db'),
    leadMerged: lead('merged'),
    chevIdle: parseFloat(getComputedStyle(q('#merged .t2s-lead-chev')).opacity),
    iconIdle: parseFloat(getComputedStyle(q('#merged .t2s-lead-icon')).opacity),
    folderChevIdle: parseFloat(getComputedStyle(q('#folder .t2s-lead-chev')).opacity),
    // 垂直节奏:行高 + 相邻两行的间距(用户报过「文件夹之间的间距没和笔记统一」)
    rowH: q('#emoji').getBoundingClientRect().height,
    folderH: q('#folder').getBoundingClientRect().height,
    gapFolderFolder: q('#folder2').getBoundingClientRect().top - q('#folder').getBoundingClientRect().bottom,
    gapFolderNote: q('#emoji').getBoundingClientRect().top - q('#folder2').getBoundingClientRect().bottom,
    gapNoteNote: q('#plain').getBoundingClientRect().top - q('#emoji').getBoundingClientRect().bottom,
    // 工作区 view 的条目留白:主行 4.5→3、顶部入口 6→4,约为改前的 0.65×。
    itemPads: {
      note: parseFloat(getComputedStyle(q('#emoji')).paddingTop),
      folder: parseFloat(getComputedStyle(q('#folder .t2s-folder-row')).paddingTop),
      session: parseFloat(getComputedStyle(q('#s-row')).paddingTop),
      file: parseFloat(getComputedStyle(q('#f-file')).paddingTop),
      special: parseFloat(getComputedStyle(q('#special')).paddingTop),
    },
    // 跨模式(用户报的「会话、文件里面的没有对齐」):三个 view 的组头 / 组内行各自的槽左边缘
    sGroup: lead('s-group'), sRow: lead('s-row'), sRow2: lead('s-row2'),
    fGroup: lead('f-group'), fDir: lead('f-dir'), fFile: lead('f-file'),
    sIconW: iconBox('s-row').width,
    fIconW: iconBox('f-file').width,
    // 分区行图标槽(用户连报四次的盲区):云同步 / 集合 / 回收站 / 顶部入口
    secIcons: ['ic-special', 'ic-cs', 'ic-coll', 'ic-trash']
      .map((id) => ({ id, w: +document.querySelector(`#${id} > svg`).getBoundingClientRect().width.toFixed(2) })),
  }
}

;(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() })
  const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 900, height: 600 } })
  await p.setContent(PAGE)
  const m = await p.evaluate(measure)

  check('工作区里图标放大到 13 × 1.3 = 16.9px', Math.abs(m.iconW - 16.9) < 0.1, `iconW=${m.iconW}`)
  check('⚠️emoji 与兜底图标一样大(用户原话)', Math.abs(m.emojiFont - m.iconW) < 0.1,
    `emojiFont=${m.emojiFont} iconW=${m.iconW}`)
  check('⚠️文件夹图标与文件图标一样大(用户报的「小了一圈」)', Math.abs(m.folderIconW - m.iconW) < 0.1,
    `folderIcon=${m.folderIconW} fileIcon=${m.iconW}`)
  check('⚠️文件夹行字号已与笔记行统一(否则 em 基准不同 → 图标又裂)',
    Math.abs(m.folderFont - m.rowFont) < 0.1, `folder=${m.folderFont} row=${m.rowFont}`)
  check('CSS 压过了 lucide 的 width="24" 表现属性', m.iconW < 24 && Math.abs(m.iconW - m.iconH) < 0.1,
    `iconW=${m.iconW} iconH=${m.iconH}`)
  check('⚠️所有图标左边缘对齐(文件夹 / emoji 笔记 / 无 emoji md / 多维表 / 有子目录的笔记)',
    [m.leadEmoji, m.leadPlain, m.leadDb, m.leadMerged].every((x) => Math.abs(x - m.leadFolder) < 0.6),
    `folder=${m.leadFolder.toFixed(1)} emoji=${m.leadEmoji.toFixed(1)} plain=${m.leadPlain.toFixed(1)} db=${m.leadDb.toFixed(1)} merged=${m.leadMerged.toFixed(1)}`)
  // 静息态:图标可见(>0;文件类带 .t2s-dim 故是 0.7,不是 1)、箭头藏着
  check('⚠️默认显图标、箭头藏着(有子目录的笔记 —— 用户报的第 2 条)',
    m.chevIdle === 0 && m.iconIdle > 0, `chev=${m.chevIdle} icon=${m.iconIdle}`)
  check('⚠️文件夹箭头默认也藏着(用户报的第 1 条)', m.folderChevIdle === 0, `chev=${m.folderChevIdle}`)
  check('⚠️文件夹行高与笔记行一致(.t2s-group-toggle 原 padding 4px 会矮 1px)',
    Math.abs(m.folderH - m.rowH) < 0.1, `folder=${m.folderH.toFixed(2)} note=${m.rowH.toFixed(2)}`)
  check('⚠️行间距全树一致:文件夹↔文件夹 / 文件夹↔笔记 / 笔记↔笔记(用户报的「间距不统一」)',
    [m.gapFolderFolder, m.gapFolderNote].every((g) => Math.abs(g - m.gapNoteNote) < 0.1),
    `f-f=${m.gapFolderFolder} f-n=${m.gapFolderNote} n-n=${m.gapNoteNote}`)
  check('⚠️工作区普通条目纵向留白约为改前 0.65×(会话 / 文件 / 笔记 / 文件夹)',
    ['note', 'folder', 'session', 'file'].every((k) => Math.abs(m.itemPads[k] - 3) < 0.05),
    Object.entries(m.itemPads).map(([k, v]) => `${k}=${v}`).join(' '))
  check('⚠️工作区顶部入口条目纵向留白约为改前 0.65×',
    Math.abs(m.itemPads.special - 4) < 0.05, `special=${m.itemPads.special}`)

  // ══ 跨模式(用户报的「会话、文件里面的没有对齐」)══
  check('⚠️三个 view 的组头图标在同一竖线(笔记 / 会话 / 文件)',
    Math.abs(m.sGroup - m.leadFolder) < 0.6 && Math.abs(m.fGroup - m.leadFolder) < 0.6,
    `笔记=${m.leadFolder.toFixed(1)} 会话=${m.sGroup.toFixed(1)} 文件=${m.fGroup.toFixed(1)}`)
  check('⚠️三个 view 的组内行图标在同一竖线(= 组头 + 一级缩进 10.5)',
    [m.sRow, m.fDir, m.fFile].every((x) => Math.abs(x - (m.leadFolder + 10.5)) < 0.6),
    `期望=${(m.leadFolder + 10.5).toFixed(1)} 会话=${m.sRow.toFixed(1)} 文件夹=${m.fDir.toFixed(1)} 文件=${m.fFile.toFixed(1)}`)
  check('⚠️会话行有无状态点都不影响图标位置(状态点曾内联把行推右)',
    Math.abs(m.sRow - m.sRow2) < 0.1, `有点=${m.sRow.toFixed(1)} 无点=${m.sRow2.toFixed(1)}`)
  check('⚠️三个 view 的图标同尺寸', Math.abs(m.sIconW - m.iconW) < 0.1 && Math.abs(m.fIconW - m.iconW) < 0.1,
    `笔记=${m.iconW.toFixed(2)} 会话=${m.sIconW.toFixed(2)} 文件=${m.fIconW.toFixed(2)}`)

  check('⚠️分区行图标也吃同一个 --t2s-icon(云同步/集合/回收站/入口行 —— 用户连报四次的盲区)',
    m.secIcons.every((s) => Math.abs(s.w - m.iconW) < 0.1),
    m.secIcons.map((s) => `${s.id}=${s.w}`).join(' '))

  // hover 互换:图标让位、箭头现身
  for (const [sel, name] of [['#merged', '有子目录的笔记'], ['#folder .t2s-folder-row', '文件夹']]) {
    await p.hover(sel)
    const h = await p.evaluate((s) => {
      const root = document.querySelector(s)
      const g = (c) => parseFloat(getComputedStyle(root.querySelector(c)).opacity)
      return { chev: g('.t2s-lead-chev'), icon: g('.t2s-lead-icon') }
    }, sel)
    check(`⚠️hover ${name} → 图标换成箭头`, h.chev > 0.5 && h.icon === 0, `chev=${h.chev} icon=${h.icon}`)
  }
  // 不可展开的行:hover 也不该让位(槽里没箭头 → :has 不命中)
  await p.hover('#plain')
  const stay = await p.evaluate(() => parseFloat(getComputedStyle(document.querySelector('#plain .t2s-lead-icon')).opacity))
  check('hover 不可展开的行 → 图标不让位', stay > 0, `icon=${stay}`)

  if (process.argv.includes('--shot')) {
    await p.mouse.move(880, 580)
    const shot = path.join(os.tmpdir(), 'forsion-workspace-item-spacing.png')
    await p.screenshot({ path: shot, fullPage: true })
    console.log(`SHOT  ${shot}`)
  }

  await browser.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
})()
