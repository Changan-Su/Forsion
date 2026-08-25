/**
 * 设置界面的「描边 / 选中态 / 中分类」契约 —— 全是改 CSS 会静默塌掉、且只在某几个主题×明暗组合下才露相的东西。
 *
 *  A 边线永远站在表面的正确一侧:浅色态比表面暗、深色态比表面亮。
 *    ⚠️ 这条是用户实报的病:`--border` 是**硬色值**,与所在卡面没有相对关系。旧的 :root.dark
 *    把它设成 #34302a(奶油暖调残留),而同块的 --bg-card 是中性 #353538 —— 边比卡还暗,
 *    胶囊/卡片在暗色下全被描了一圈黑边。逐 主题×配色×明暗 全组合扫,不是抽查。
 *  B 选中轮廓只有一层、且不是满强度 accent。旧写法 border-color:accent + box-shadow:0 0 0 1px accent
 *    = 2px 实心 accent,单色配色下深色态近白、浅色态近黑(用户:「太夸张 / 深色太亮 / 浅色太黑」)。
 *  C 选中轮廓的深浅两态**观感对称**:同一张卡在 light / dark 下,轮廓对卡面的对比度不应差出一截,
 *    否则就是又回到「一边刺眼一边发闷」。
 *  D 中分类栏目条在标题下方、可横滑不换行;选中项用 overlay 底而不是满强度 accent。
 *  E 切换动画:data-dir=+1 从右滑入、-1 从左滑入、0 纯淡入(换一级页无左右语义)。量首帧真实 transform。
 *
 * 改 base.css 的 --border / --sel-line / .seg / .switch / .theme-card / .skin-chip / .settings-sub* 后必跑。
 * 跑:node scripts/settings-ui.check.cjs   (需 playwright-core 自装的 chromium;CHROMIUM_EXE 可覆盖)
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

const SRC = path.join(__dirname, '../frontend/src')
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8')
// 真源:base.css(token 契约 + 组件类)+ skins.css(配色轴)+ 三个 bundle 语言包 + 第一方 soft 磁盘种子。
// 任意用户主题天然管不到；但 soft 是产品首次启动自动种入的默认语言，必须与 bundle 门面同级受检。
require('sucrase/register/ts')
const { SEED_THEMES } = require(path.join(__dirname, '../electron/seedThemes.ts'))
const SOFT_CSS = SEED_THEMES.find((theme) => theme.id === 'soft')?.css
if (!SOFT_CSS) throw new Error('缺少第一方 soft 磁盘种子主题')
const LANGS = ['lovable', 'genesis-glass', 'soft', 'zhi']
const CSS = [
  read('styles/base.css'),
  read('theme/skins.css'),
  ...LANGS.map((id) => id === 'soft' ? SOFT_CSS : read(`theme/themes/${id}/theme.css`)),
].join('\n')
const SKINS = ['cream', 'coral', 'teal', 'lavender', 'zhi']
// custom 配色没有 CSS 块 —— 它的 accent/bg 族由 customSkinVars(seed) 运行时内联到 :root。
// 必须一起扫:seed 直接改写 --accent-ink,而 --sel-line 就建在它上面。极端 seed(纯白/纯黑)专门
// 用来验 customSkinVars 里那两条可读性守卫(暗底提亮过深 seed、亮底压深过浅 seed)确实兜住了。
const { customSkinVars } = require(path.join(SRC, 'theme/lcl/lovableData.ts'))
const SEEDS = ['#8b7fd6', '#ffffff', '#000000', '#ff0000']

/** 设置页的静态复刻(结构照 SettingsModal.tsx 的 .settings-main;开合/切换由脚本切 class)。 */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
${CSS}
body { margin: 0; }
</style></head><body>
<div class="settings-page">
<section class="settings-mobile-home">
  <header class="settings-mobile-home-head"><button>←</button><strong>设置</strong><span></span></header>
  <div class="settings-mobile-home-scroll">
    <div class="settings-mobile-hero"><span><strong>Forsion Genesis</strong><small>设置</small></span></div>
    <section class="settings-mobile-group"><h2>外观</h2><div class="settings-mobile-group-card">
      <button class="settings-mobile-row"><span class="settings-mobile-row-icon"></span><span class="settings-mobile-row-copy"><strong>外观</strong><small>主题、配色与字体</small></span><span>›</span></button>
      <button class="settings-mobile-row"><span class="settings-mobile-row-icon"></span><span class="settings-mobile-row-copy"><strong>通知</strong><small>通知出口与事件提醒</small></span><span>›</span></button>
    </div></section>
  </div>
</section>
<!-- ⚠️ 侧栏不能省:.settings-page 是 grid(252px + 1fr),少了它 .settings-main 会落进 252px 那一列,
     正文被挤成一条,量出来的几何全是假的(截图里主题卡互相压在一起就是这个)。 -->
<aside class="settings-nav"><div class="settings-nav-top"></div><div class="settings-nav-list"></div></aside>
<section class="settings-main">
  <div class="settings-mobile-detail-head"><button>←</button><strong>外观</strong><button>×</button></div>
  <div class="settings-main-head">
    <div class="settings-main-title">主题</div>
    <div class="settings-subbar" role="tablist">
      <button class="settings-subtab active">设计语言</button>
      <button class="settings-subtab">配色</button>
      <button class="settings-subtab">显示</button>
    </div>
  </div>
  <div class="settings-body"><div class="settings-sub" data-dir="0">
    <div class="field">
      <label>设计语言</label>
      <div class="theme-grid">
        <button class="theme-card active"><div class="theme-preview"></div><div class="theme-meta"><div class="theme-name">Genesis</div></div></button>
        <button class="theme-card"><div class="theme-preview"></div><div class="theme-meta"><div class="theme-name">Glass</div></div></button>
      </div>
    </div>
    <div class="field">
      <label>配色</label>
      <div class="skin-row">
        <button class="skin-chip active"><i class="skin-dot"></i><span>经典</span></button>
        <button class="skin-chip"><i class="skin-dot"></i><span>珊瑚</span></button>
      </div>
    </div>
    <div class="field">
      <label>明暗</label>
      <div class="seg"><button class="active">亮色</button><button>暗色</button><button>跟随系统</button></div>
    </div>
    <div class="field">
      <label>开关</label>
      <button class="switch"></button>
    </div>
  </div></div>
</section></div>
</body></html>`

// ── 色度工具:相对亮度 + WCAG 对比度。半透明边线要先合成到它压着的表面上再比。 ──
const COLOR_UTILS = `
// ⚠️ color-mix() 的 computed 值序列化成 \`color(srgb 0.97 0.96 0.96 / 0.45)\` —— 通道是 **0–1**,
// 不是 rgba() 的 0–255。当年按 0–255 读会把近白读成近黑,两边算出来的对比度全是废数。
function parse(c) {
  const s = String(c)
  const m = s.match(/-?[\\d.]+/g) || []
  const k = /^color\\(/.test(s) ? 255 : 1 // color() 走 0–1 通道,rgb()/rgba() 已是 0–255
  return { r: (+m[0] || 0) * k, g: (+m[1] || 0) * k, b: (+m[2] || 0) * k, a: m.length > 3 ? +m[3] : 1 }
}
function over(fg, bg) { // fg 合成到不透明 bg 上
  const f = parse(fg), b = parse(bg)
  return { r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a) }
}
function lum(c) {
  const ch = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b)
}
function ratio(a, b) { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
// 元素**自己的**填充也算表面:边是画在自己边沿上的,一张浅卡描一圈黑线,人眼比的就是线 vs 卡面。
// ⚠️ 早先从 el.parentElement 起找,于是 .field 的边被拿去和页面底比,把「边比卡还黑」整条病放过去了
//    (反向验证:把 --border 塞回 #34302a 竟然全绿)。必须从元素自己起算,并把半透明层逐层合成下去。
function surfaceUnder(el) {
  const stack = []
  for (let n = el; n; n = n.parentElement) {
    const c = parse(getComputedStyle(n).backgroundColor)
    if (c.a > 0.001) stack.push(c)
    if (c.a > 0.999) break
  }
  let acc = stack.pop() || { r: 255, g: 255, b: 255, a: 1 }
  while (stack.length) {
    const t = stack.pop()
    acc = Object.assign(over('rgba(' + t.r + ',' + t.g + ',' + t.b + ',' + t.a + ')', 'rgb(' + acc.r + ',' + acc.g + ',' + acc.b + ')'), { a: 1 })
  }
  return acc
}
`

;(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() })
  const p = await browser.newPage({ viewport: { width: 1000, height: 800 } })
  await p.setContent(PAGE)
  await p.addScriptTag({ content: COLOR_UTILS })

  // ⚠️ 换主题会触发 .theme-card / .skin-chip / .switch 上的 border-color 过渡,**紧接着量 computed 值
  //    读到的是过渡中途**(实测:切到暗色后 border 仍报亮色态的 rgba(28,28,28,0.07))。必须先把
  //    这一帧所有动画/过渡推到终态再量 —— 同 model-menu.check 里 pop 动画那条坑。
  const setTheme = (lang, skin, mode, inlineVars) => p.evaluate(({ lang, skin, mode, inlineVars }) => {
    const r = document.documentElement
    r.dataset.theme = lang
    r.dataset.skin = skin
    r.dataset.mode = mode
    r.classList.toggle('dark', mode === 'dark')
    r.style.cssText = '' // 上一轮 custom 的内联 seed 变量必须清掉,否则会漏到命名配色上
    for (const [k, v] of Object.entries(inlineVars || {})) r.style.setProperty(k, v)
    document.body.offsetHeight // 逼一次样式重算,过渡对象才存在
    document.getAnimations().forEach((a) => a.finish())
  }, { lang, skin, mode, inlineVars })

  /** 一个组合下,量各条边线合成到自己表面后落在表面的哪一侧、差多少。 */
  // 控件级(边线走 --overlay-*,与主题给的 --border 无关)—— 这几条在敌意主题下也必须站对边。
  const CONTROL_TARGETS = [
    ['seg', '.seg', 'borderTopColor'],
    ['segDivider', '.seg button + button', 'borderLeftColor'],
    ['switch', '.switch', 'borderTopColor'],
    ['themeCardIdle', '.theme-card:not(.active)', 'borderTopColor'],
    ['skinChipIdle', '.skin-chip:not(.active)', 'borderTopColor'],
  ]
  // 设置卡的边线同样改走 --overlay-*(理由见 base.css .settings-body .field 注释),故与控件同组。
  CONTROL_TARGETS.push(['card', '.settings-body .field', 'borderTopColor'])
  const BORDER_TARGETS = CONTROL_TARGETS
  const probeBorders = (targets) => p.evaluate((list) => {
    const out = {}
    for (const [key, sel, prop] of list) {
      const el = document.querySelector(sel)
      const surf = surfaceUnder(el)
      const line = over(getComputedStyle(el)[prop], `rgb(${surf.r},${surf.g},${surf.b})`)
      out[key] = { dl: lum(line) - lum(surf), ratio: ratio(line, surf) }
    }
    return out
  }, targets)

  /** 选中轮廓:颜色对卡面的对比度 + 有没有第二层 ring。
   *  ⚠️ 主题卡和配色 chip **两个都要量**:只量 .theme-card.active 的话,把 .skin-chip.active
   *  改回旧的双层满强度描边,这套检查照样全绿(Codex 评审指出)。 */
  const SEL_TARGETS = [
    ['themeCard', '.theme-card.active', '.theme-card.active .theme-meta', '.theme-card:not(.active) .theme-meta'],
    ['skinChip', '.skin-chip.active', '.skin-chip.active', '.skin-chip:not(.active)'],
  ]
  const probeSelection = () => p.evaluate((list) => {
    const out = {}
    for (const [key, selEl, selFill, selIdleFill] of list) {
      const el = document.querySelector(selEl)
      const cs = getComputedStyle(el)
      const surf = surfaceUnder(el.parentElement)
      out[key] = {
        shadow: cs.boxShadow,
        width: parseFloat(cs.borderTopWidth),
        lineRatio: ratio(over(cs.borderTopColor, `rgb(${surf.r},${surf.g},${surf.b})`), surf),
        // 淡填充:选中件的底应与未选中件的底不同(否则「细线+淡填充」只兑现了一半)
        fillDelta: Math.abs(lum(over(getComputedStyle(document.querySelector(selFill)).backgroundColor, `rgb(${surf.r},${surf.g},${surf.b})`))
          - lum(over(getComputedStyle(document.querySelector(selIdleFill)).backgroundColor, `rgb(${surf.r},${surf.g},${surf.b})`))),
      }
    }
    return out
  }, SEL_TARGETS)

  // ══ A + C:全组合扫描 ══
  const bad = []
  const selByMode = { light: [], dark: [] }
  // 命名配色走 CSS 块;custom 每个 seed 算一档,vars 内联到 :root(与 loader.ts 同款)。
  const COMBOS = [
    ...SKINS.map((s) => ({ skin: s, tag: s, vars: null })),
    ...SEEDS.map((seed) => ({ skin: 'custom', tag: `custom(${seed})`, seed })),
  ]
  for (const lang of LANGS) {
    for (const { skin, tag, seed } of COMBOS) {
      for (const mode of ['light', 'dark']) {
        await setTheme(lang, skin, mode, seed ? customSkinVars(seed, mode === 'dark') : null)
        const b = await probeBorders(BORDER_TARGETS)
        for (const [k, v] of Object.entries(b)) {
          const wantLighter = mode === 'dark'
          // 站错边 = 用户实报的病;差太小 = 看不见的边;差太大 = 「描边太夸张」
          if (wantLighter ? v.dl <= 0 : v.dl >= 0) bad.push(`${lang}/${tag}/${mode} ${k} 站错边(Δlum=${v.dl.toFixed(4)})`)
          else if (v.ratio > 2.2) bad.push(`${lang}/${tag}/${mode} ${k} 过强(对比 ${v.ratio.toFixed(2)})`)
        }
        const sel = await probeSelection()
        for (const [what, s] of Object.entries(sel)) {
          if (s.shadow !== 'none') bad.push(`${lang}/${tag}/${mode} ${what} 仍有第二层 ring: ${s.shadow}`)
          if (s.width > 1.5) bad.push(`${lang}/${tag}/${mode} ${what} 选中轮廓 ${s.width}px 太粗`)
          if (s.fillDelta < 0.002) bad.push(`${lang}/${tag}/${mode} ${what} 没有淡填充(Δlum=${s.fillDelta.toFixed(4)})`)
          selByMode[mode].push({ id: `${lang}/${tag}/${what}`, r: s.lineRatio })
        }
      }
    }
  }
  const combos = LANGS.length * COMBOS.length * 2
  check(`A/B 边线站位与选中轮廓:${combos} 个 主题×配色(含 custom 极端 seed)×明暗 组合全过`, bad.length === 0,
    bad.length ? bad.slice(0, 6).join(' ; ') + (bad.length > 6 ? ` …共 ${bad.length} 条` : '') : `${combos} 组合`)

  // C:选中轮廓的强度。
  // 真正要钉的是**绝对区间**而不是明暗对称:有彩强调色(珊瑚 #ff8a6b)本身是中亮度,对近白卡面
  // 和近黑卡面的亮度对比天然一高一低,做不到对称——强求对称只会逼出更差的颜色。
  // 满强度 accent(旧写法)在单色配色下能到 16:1,正是用户说的「太亮/太黑」;3.2 的上限一刀切掉。
  const OUT = [...selByMode.light.map((x) => ({ ...x, m: 'light' })), ...selByMode.dark.map((x) => ({ ...x, m: 'dark' }))]
    .filter((x) => x.r < 1.25 || x.r > 3.2)
  check('C 选中轮廓强度落在「看得见但不刺眼」区间 [1.25, 3.2]', OUT.length === 0,
    OUT.length ? OUT.map((x) => `${x.id}/${x.m}=${x.r.toFixed(2)}`).join(' ; ')
      : `实测 ${Math.min(...selByMode.light.concat(selByMode.dark).map((x) => x.r)).toFixed(2)}–${Math.max(...selByMode.light.concat(selByMode.dark).map((x) => x.r)).toFixed(2)}`)
  // 松一档的对称性:单色配色(cream)两边都由同一条 45% 规则得出,差得太开就说明规则又被绕过了。
  const asym = selByMode.light
    .map((l, i) => ({ id: l.id, d: Math.abs(l.r - selByMode.dark[i].r), l: l.r, d2: selByMode.dark[i].r }))
    .filter((x) => x.d > 1.6)
  check('C 同配色明/暗强度不至于一边刺眼一边发闷(差 ≤ 1.6)', asym.length === 0,
    asym.length ? asym.map((x) => `${x.id} light=${x.l.toFixed(2)} dark=${x.d2.toFixed(2)}`).join(' ; ')
      : `最大差 ${Math.max(...selByMode.light.map((l, i) => Math.abs(l.r - selByMode.dark[i].r))).toFixed(2)}`)

  // ══ A':敌意主题。第三方磁盘主题(~/.forsion/themes)可以把 --border 设成任何值,我们管不着;
  //    控件的边线之所以改走 --overlay-*,图的就是「不管主题给什么 --border,控件永远相对表面」。
  //    这里塞一个把 --border 设成纯黑的假主题:控件必须照样站对边。少了这条,把控件改回 --border
  //    在自家主题下照样全绿 —— 那这条设计规则就等于没被钉住。 ══
  await setTheme('lovable', 'cream', 'dark', null)
  await p.addStyleTag({ content: ':root { --border: #050505 !important; }' })
  const hostile = await probeBorders(CONTROL_TARGETS)
  const hostileBad = Object.entries(hostile).filter(([, v]) => v.dl <= 0).map(([k, v]) => `${k}(Δlum=${v.dl.toFixed(4)})`)
  check("A' 敌意主题(--border 被设成纯黑)下控件边线仍站对边", hostileBad.length === 0, hostileBad.join(' ; ') || '控件不吃 --border')
  await p.evaluate(() => document.head.lastElementChild.remove())

  // ══ D:中分类栏目条 ══
  const bar = await p.evaluate(() => {
    const b = document.querySelector('.settings-subbar')
    const title = document.querySelector('.settings-main-title')
    const active = document.querySelector('.settings-subtab.active')
    const body = document.querySelector('.settings-body')
    const cs = getComputedStyle(b)
    return {
      belowTitle: b.getBoundingClientRect().top >= title.getBoundingClientRect().bottom - 1,
      aboveBody: b.getBoundingClientRect().bottom <= body.getBoundingClientRect().top + 1,
      overflowX: cs.overflowX,
      wrap: cs.flexWrap,
      activeBg: getComputedStyle(active).backgroundColor,
      // ⚠️ 不能拿 computed 的 `rgb(28, 28, 28)` 去和 token 原始串 `#1c1c1c` 做 !== —— 那永远不等,
      //    等于假绿(Codex 评审指出)。先把 token 塞进一个探针元素让浏览器归一化成同一种序列化形式。
      accentInk: (() => {
        const probe = document.createElement('span')
        probe.style.color = 'var(--accent-ink)'
        document.body.appendChild(probe)
        const v = getComputedStyle(probe).color
        probe.remove()
        return v
      })(),
      appRegion: cs.webkitAppRegion || cs.getPropertyValue('-webkit-app-region'),
      leftAligned: Math.abs(b.getBoundingClientRect().left - title.getBoundingClientRect().left) < 1,
    }
  })
  check('D 栏目条在标题下方、正文上方', bar.belowTitle && bar.aboveBody, `belowTitle=${bar.belowTitle} aboveBody=${bar.aboveBody}`)
  check('D 栏目条与标题左对齐(同一内容栏)', bar.leftAligned)
  check('D 栏目条横向滚动、不换行(窄窗不会撑成两行顶掉正文)', bar.overflowX === 'auto' && bar.wrap === 'nowrap', `overflow-x=${bar.overflowX} wrap=${bar.wrap}`)
  check('D 选中栏目用 overlay 底,不是满强度 accent', bar.activeBg !== bar.accentInk, `bg=${bar.activeBg}`)
  // ⚠️ .settings-main-head 是拖窗区,整条栏目条(不止按钮)必须抠成 no-drag,否则横滑拖不动。
  check('D 栏目条整条 no-drag(拖窗区会吞掉横滑)', bar.appRegion === 'no-drag', `app-region=${bar.appRegion}`)
  // 多包一层 .settings-sub 之后,`.settings-body > *` 的 840 上限落到了包装层上,里面的 .field
  // 不再直接吃到那条规则 —— 得确认列宽没塌:正文与标题同一列、.field 撑满包装层。
  // ⚠️ 别把 840 写死:窄窗下列宽由可用宽度决定(本页 1000px 视口下是 672),写死会误报。
  const colAt = (w) => p.setViewportSize({ width: w, height: 800 }).then(() => p.evaluate(() => {
    const r = (s) => document.querySelector(s).getBoundingClientRect()
    const sub = r('.settings-sub'), field = r('.settings-body .field'), title = r('.settings-main-title')
    return { sub: sub.width, field: field.width, title: title.width, dx: Math.abs(field.left - title.left) }
  }))
  const narrow = await colAt(1000)
  const wide = await colAt(1600)
  check('D 正文与标题同一列、.field 撑满(多包一层没把列宽吃掉)',
    Math.abs(narrow.sub - narrow.title) < 1 && Math.abs(narrow.field - narrow.sub) < 1 && narrow.dx < 1,
    `窄窗 sub=${narrow.sub.toFixed(1)} field=${narrow.field.toFixed(1)} title=${narrow.title.toFixed(1)}`)
  check('D 宽窗下 840 上限仍然生效(外观页可并排、其他页不会拉成大通栏)', Math.abs(wide.field - 840) < 1,
    `宽窗 field=${wide.field.toFixed(1)}`)
  await p.setViewportSize({ width: 1000, height: 800 })

  // ══ E:切换动画方向。首帧的 transform 才作数(声明字符串证明不了动画真的跑)。 ══
  const firstFrameX = (dir) => p.evaluate((d) => new Promise((res) => {
    const old = document.querySelector('.settings-sub')
    const el = old.cloneNode(true)     // 重挂 = React 换 key 的等价物
    el.dataset.dir = d
    old.replaceWith(el)
    requestAnimationFrame(() => {
      const m = new DOMMatrixReadOnly(getComputedStyle(el).transform)
      res(m.m41)
    })
  }), dir)
  const [xR, xL, x0] = [await firstFrameX('1'), await firstFrameX('-1'), await firstFrameX('0')]
  check('E 点右边的栏目 → 新内容从右侧滑入', xR > 4, `首帧 translateX=${xR.toFixed(1)}px`)
  check('E 点左边的栏目 → 新内容从左侧滑入', xL < -4, `首帧 translateX=${xL.toFixed(1)}px`)
  check('E 换一级页(dir=0)→ 纯淡入不左右跳', Math.abs(x0) < 1, `首帧 translateX=${x0.toFixed(1)}px`)

  // ══ M:移动端全局分类必须是一级列表 → 二级详情,不准回退成顶部横滑 chips。 ══
  await p.setViewportSize({ width: 390, height: 844 })
  const mobileMenu = await p.evaluate(() => {
    const page = document.querySelector('.settings-page')
    page.classList.add('settings-page--mobile', 'settings-page--mobile-menu')
    const style = (s) => getComputedStyle(document.querySelector(s))
    const row = document.querySelector('.settings-mobile-row')
    return {
      home: style('.settings-mobile-home').display,
      nav: style('.settings-nav').display,
      main: style('.settings-main').display,
      rowH: row.getBoundingClientRect().height,
      overflow: document.body.scrollWidth - document.body.clientWidth,
    }
  })
  check('M 移动端打开设置先显示分组列表,旧侧栏与正文隐藏',
    mobileMenu.home === 'flex' && mobileMenu.nav === 'none' && mobileMenu.main === 'none',
    `home=${mobileMenu.home} nav=${mobileMenu.nav} main=${mobileMenu.main}`)
  check('M 一级入口满足触控行高且页面无横向溢出', mobileMenu.rowH >= 64 && mobileMenu.overflow === 0,
    `row=${mobileMenu.rowH.toFixed(1)}px overflow=${mobileMenu.overflow}px`)

  const mobileDetail = await p.evaluate(() => {
    const page = document.querySelector('.settings-page')
    page.classList.remove('settings-page--mobile-menu')
    const style = (s) => getComputedStyle(document.querySelector(s))
    return {
      home: style('.settings-mobile-home').display,
      nav: style('.settings-nav').display,
      main: style('.settings-main').display,
      head: style('.settings-mobile-detail-head').display,
      subWrap: style('.settings-subbar').flexWrap,
      subOverflow: style('.settings-subbar').overflowX,
      overflow: document.body.scrollWidth - document.body.clientWidth,
    }
  })
  check('M 点一级项进入独立二级页(页头返回,不复活全局 chips)',
    mobileDetail.home === 'none' && mobileDetail.nav === 'none' && mobileDetail.main === 'flex' && mobileDetail.head === 'grid',
    `home=${mobileDetail.home} nav=${mobileDetail.nav} main=${mobileDetail.main} head=${mobileDetail.head}`)
  check('M 二级页天然子栏目折行而非横滑',
    mobileDetail.subWrap === 'wrap' && mobileDetail.subOverflow === 'visible' && mobileDetail.overflow === 0,
    `wrap=${mobileDetail.subWrap} overflow-x=${mobileDetail.subOverflow} page-overflow=${mobileDetail.overflow}px`)

  await browser.close()

  // ══ F:栏目条上声明的每个 key,正文里都得有**同一个 tab 下的**渲染块 —— 少一个 / 挂错 tab
  //    就是「点得到栏目却一片空白」。纯源码层判定(浏览器里跑不了真组件:SettingsModal 要几十个
  //    props 和 window.tangu)。
  //    ⚠️ 能力边界(Codex 评审指出,别高估这条):它只看得见**静态**条件。栏目正文若整块藏在
  //    `window.xxx` 能力闸或异步 state(如 noteSync)后面,这里照样判过 —— 那类白板得人工核。 ══
  const TSX = fs.readFileSync(path.join(SRC, 'components/SettingsModal.tsx'), 'utf8')
  const subMap = TSX.slice(TSX.indexOf('const subItems'), TSX.indexOf('const activeSub'))
  // 从 subItems 表里按所属一级页收集 key:`general: [ ... ['g-conn', …] … ]`
  const declared = []
  for (const m of subMap.matchAll(/^\s{4}'?([\w-]+)'?: \[([\s\S]*?)^\s{4}\],$/gm)) {
    for (const k of m[2].matchAll(/'([a-z]+-[a-z]+)'/g)) declared.push([m[1], k[1]])
  }
  const guarded = new Set([...TSX.matchAll(/tab === '([\w-]+)'[^\n]*activeSub === '([a-z]+-[a-z]+)'/g)].map((m) => `${m[1]}/${m[2]}`))
  const orphan = declared.filter(([tb, k]) => !guarded.has(`${tb}/${k}`)).map(([tb, k]) => `${tb}/${k}`)
  const stray = [...guarded].filter((g) => !declared.some(([tb, k]) => `${tb}/${k}` === g))
  check('F 每个中分类都有**同 tab 下**的正文块(不会点出空白页 / 挂错页)',
    declared.length > 0 && orphan.length === 0 && stray.length === 0,
    orphan.length || stray.length ? `声明了没正文: ${orphan.join(',') || '无'} / 有正文没声明: ${stray.join(',') || '无'}`
      : `${declared.length} 个栏目按 tab 一一对应`)

  // ══ G:D/E 全跑在硬编码的 PAGE 复刻上 —— 真 JSX 若把栏目条挪出标题区、丢了 wrapper 的 key 或
  //    漏传 data-dir,那些断言不会红(Codex 评审指出)。这里静态钉住真组件的这几处接线。 ══
  const wiring = [
    ['栏目条渲染在 .settings-main-head 内', /settings-main-head[\s\S]{0,900}?className="settings-subbar"/],
    ['包装层带 key(靠重挂触发入场动画)', /key=\{`\$\{tab\}:\$\{activeSub\}`\}[\s\S]{0,160}?className=\{`settings-sub settings-sub--\$\{tab\}`\}/],
    ['包装层传了 data-dir(方向)', /className=\{`settings-sub settings-sub--\$\{tab\}`\} data-dir=\{subDir\}/],
    ['切页/切分类后正文回顶部', /\.settings-body'\)[\s\S]{0,120}?scrollTop = 0/],
    ['移动一级行进入二级页', /onClick=\{\(\) => \{ goTab\(id\); setMobileMenuOpen\(false\) \}\}/],
    ['移动二级页头返回一级列表', /settings-mobile-detail-head[\s\S]{0,180}?setMobileMenuOpen\(true\)/],
    ['Android 系统返回先退一级列表', /addEventListener\('forsion:mobile-back', backToMenu\)/],
  ]
  const brokenWiring = wiring.filter(([, re]) => !re.test(TSX)).map(([n]) => n)
  check('G 真组件的接线仍在(栏目动画 / 两层移动导航 / Android 返回)', brokenWiring.length === 0,
    brokenWiring.join(' ; ') || `${wiring.length} 处接线`)

  // ══ H:--sel-line/--sel-fill 必须**先**有不含 color-mix 的值,再在 @supports 里升级。
  //    浏览器里模拟不了「不支持 color-mix」,只能静态钉:少了这层兜底,老浏览器(npm run web 面)
  //    下 border-color 会 IACVT → currentColor = 正文色,比没修之前还刺眼(理由见 base.css 长注释)。 ══
  const BASE = read('styles/base.css')
  const plainAt = BASE.indexOf('--sel-line: var(')
  const mixAt = BASE.indexOf('--sel-line: color-mix(')
  const supAt = BASE.indexOf('@supports (color: color-mix(')
  check('H color-mix 之前有非 color-mix 兜底,且升级版包在 @supports 里',
    plainAt > -1 && supAt > -1 && plainAt < supAt && supAt < mixAt && BASE.includes('--sel-fill: var('),
    plainAt < 0 ? '缺兜底值' : supAt < 0 ? '缺 @supports' : `兜底@${plainAt} < @supports@${supAt} < color-mix@${mixAt}`)

  // ══ I:其余设置页的收敛不能退回「主标题 + 正文重复标题 / 一项一卡」。静态钉住共用面板、
  //    无障碍 switch 与高频页的关键结构；具体间距和主题表现仍由 Electron 截图人工点验。 ══
  const PRIMITIVES = fs.readFileSync(path.join(SRC, 'components/SettingsPrimitives.tsx'), 'utf8')
  const SHORTCUTS = fs.readFileSync(path.join(SRC, 'components/ShortcutsTab.tsx'), 'utf8')
  const NOTIFICATIONS = fs.readFileSync(path.join(SRC, 'components/NotificationsTab.tsx'), 'utf8')
  const SPACES = fs.readFileSync(path.join(SRC, 'components/SpacesTab.tsx'), 'utf8')
  const duplicateHeadings = [
    /tab === 'hooks'[\s\S]{0,100}?settings-sec/,
    /tab === 'spaces'[\s\S]{0,100}?settings-sec/,
    /tab === 'notifications'[\s\S]{0,100}?settings-sec/,
    /tab === 'statusbar'[\s\S]{0,100}?settings-sec/,
    /tab === 'channels'[\s\S]{0,100}?settings-sec/,
  ].some((re) => re.test(TSX))
  const compactWiring = [
    PRIMITIVES.includes('role="switch"'),
    SHORTCUTS.includes('settings-filter-input') && SHORTCUTS.includes('visibleRows'),
    NOTIFICATIONS.includes('SettingsSwitch') && NOTIFICATIONS.includes('settings-drag-list'),
    SPACES.includes('settings-collection-list') && !SPACES.includes('const zh ='),
    TSX.includes("settings.page.notesDescription") && TSX.includes("settings.page.browserDescription"),
  ]
  check('I 其余设置页共用面板/开关/紧凑列表，且不再重复主标题', !duplicateHeadings && compactWiring.every(Boolean),
    duplicateHeadings ? '仍有正文重复标题' : `${compactWiring.filter(Boolean).length}/${compactWiring.length} 处结构接线`)

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
})()
