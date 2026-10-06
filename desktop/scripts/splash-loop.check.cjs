/**
 * 启动闪屏(#tangu-splash)的画面与退场契约检查(真 Chromium 断言)。
 *
 * 为什么存在:闪屏原来是「2100ms 定时器到点就撤」,启动慢(装插件/扫工作目录)时会在应用还没
 * 起来时露出半成品。改成「动画一直走 + 首帧画出来才淡出」后,风险换了个方向:
 *  ① 动画真的在走吗 —— 少个 infinite 就退化成"播完就僵住"的静止画面;
 *  ② 首帧出来后真的会撤吗 —— 撤不掉 = 整个应用被一层 fixed 盖住,灾难;
 *  ③ 首帧**永远**出不来(初始化抛错)时的天花板 —— 这是唯一的"把用户锁死"路径。
 *
 * 内置画面有两个:默认的「树影」(startupAppearance.js 现画,2026-10-05)与「经典图标」(index.html 里
 * 的树标循环动画,原来的默认)。两条都在这里钉:树影要钉的是 —— 画布真画出来了、诗句落在墙上而不是
 * 窗光里、不跟随应用图标、只让位给用户选的开屏素材、只动 transform / opacity、沙箱预览里不抛错。
 *
 * 直接喂仓里真实的 index.html 与运行时(不复制样式/脚本,故不会与源码漂移)。页面经 splash.test 路由
 * 给出(要 localStorage:暗色与「不连着出同一句」都靠它);`/src/main.tsx` 必然加载失败 → #root 恒空
 * = 天然模拟"启动很慢"。
 *
 * 跑:npm run check:splash   (需 playwright-core 自装的 chromium;CHROMIUM_EXE 可覆盖)
 * 负对照:STARTUP_RUNTIME=<改坏的运行时副本> npm run check:splash,应当红在对应那几条上。
 * 截图落在 outputs/splash/(亮 / 暗 / 竖屏 / 经典),观感改动交付前要看。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')
const { findChromium } = require('./lib/find-chromium.cjs')

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

// 负对照:STARTUP_RUNTIME 指向一份改坏的运行时副本,确认对应的检查会红(截图另放临时目录,不盖正式那套)。
const MUTANT = process.env.STARTUP_RUNTIME
const OUT = MUTANT ? fs.mkdtempSync(path.join(os.tmpdir(), 'splash-mutant-')) : path.join(__dirname, '../outputs/splash')
const RUNTIME = fs.readFileSync(MUTANT || path.join(__dirname, '../frontend/startupAppearance.js'), 'utf8')
const ENTRIES = ['../frontend/index.html', '../../web/index.html', '../../mobile/index.html']
/** 真实入口 + 真实运行时;config 给了就当作宿主已存的开屏设置(否则走各端自己的缺省读取)。函数替换:运行时文本里的 `$'` 不许被展开。 */
function html(config, entry = ENTRIES[0], version = STAMP, nativeReducedMotion = false, softwareRendering = false) {
  const host = `<script>window.FORSION_APP_VERSION=${JSON.stringify(version)};</script>` + (config || nativeReducedMotion || softwareRendering ? `<script>window.tangu={startupAppearance:{prefersReducedMotion:${nativeReducedMotion},softwareRendering:${softwareRendering},initial:${JSON.stringify({ version: 1, ...config })}}};</script>` : '')
  return fs.readFileSync(path.join(__dirname, entry), 'utf8').replace('<!-- forsion-startup-runtime -->', () => `${host}<script>${RUNTIME}</script>`)
}
const CYCLE = 1600
/** 构建时盖进页面的版本号(真应用里取自更新日志的最新正式版);这里用一个认得出来的假值。 */
const STAMP = '9.8.7'
/** 字的墨迹上下沿离树标上下沿最多差多少(单位:字标字号)。13px 字号下约 1.8px;改成按行盒居中的旧排法,下沿会差出 3px。 */
const LOCKUP = .14
const aligned = (s) => !!s.lockup && Math.abs(s.lockup[0]) <= LOCKUP && Math.abs(s.lockup[1]) <= LOCKUP
const lockupNote = (s) => s.lockup ? `字顶 ${s.lockup[0] >= 0 ? '低' : '高'} ${Math.abs(s.lockup[0]).toFixed(3)}em,字底 ${s.lockup[1] >= 0 ? '低' : '高'} ${Math.abs(s.lockup[1]).toFixed(3)}em` : ''
const VERSES = ['汤谷上有扶桑', '香风送紫蕊', '客止我且往', '万里扶桑客', '暾将出兮东方']
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII='
const svg = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="18" fill="teal"/></svg>').toString('base64')
const broken = 'data:image/png;base64,aGVsbG8='

/** 经典图标:四条循环动画的状态。 */
const classicState = () => {
  const s = document.getElementById('tangu-splash')
  if (!s) return { gone: true }
  const logo = s.querySelector('.tangu-splash-logo')
  const anims = [...logo.getAnimations(), ...s.querySelectorAll('#panel-stack, #tree-mark, #tree-outline')]
    .flatMap((x) => (x.getAnimations ? x.getAnimations() : [x]))
  return {
    gone: false,
    out: s.classList.contains('out'),
    names: anims.map((a) => a.animationName),
    infinite: anims.every((a) => a.effect.getComputedTiming().iterations === Infinity),
    running: anims.every((a) => a.playState === 'running'),
    // 跑过了一整轮还在跑 = 真的在循环(不是"播完僵住")
    pastFirstCycle: Math.max(0, ...anims.map((a) => a.currentTime || 0)),
  }
}

/** 树影:画面是否真画出来、落在哪、在动什么。 */
const shadowState = () => {
  const s = document.getElementById('tangu-splash')
  if (!s) return { gone: true }
  const scene = s.querySelector('.fts')
  if (!scene) return { gone: false, mounted: false, logo: !!s.querySelector('.tangu-splash-logo'), img: s.querySelectorAll('img').length, motion: s.dataset.customMotion || null }
  const [far, near, wall] = scene.querySelectorAll('canvas')
  const alphaAt = (cv, x, y) => cv.getContext('2d').getImageData(Math.round(x), Math.round(y), 1, 1).data
  const painted = (cv) => { const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++; return n / (d.length / 4) }
  // 页面坐标 → 暗墙画布像素(画布比视口四周各多 48px,且位图可能按比例缩小过)
  const wallAlpha = (px, py) => alphaAt(wall, (px + 48) * wall.width / (innerWidth + 96), (py + 48) * wall.height / (innerHeight + 96))[3]
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } }
  const onWall = (b) => [[0, 0], [1, 0], [0, 1], [1, 1], [.5, .5]].every(([fx, fy]) => wallAlpha(b.x + b.w * fx, b.y + b.h * fy) > 250)
  const verse = box(scene.querySelector('.fts-verse')), brand = box(scene.querySelector('.fts-brand'))
  const word = scene.querySelector('.fts-brand span'), ver = scene.querySelector('.fts-ver')
  const wordBox = (() => { const r = document.createRange(); r.selectNode(word.firstChild); return r.getBoundingClientRect() })()
  // 字的「墨迹」上下沿(大写字顶 / 数字底),不是行盒:行盒比字高,拿它对齐树标会差出一两个像素
  const ink = (node) => {
    const cs = getComputedStyle(node.parentElement), g = document.createElement('canvas').getContext('2d')
    g.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
    const m = g.measureText(node.textContent), r = document.createRange(); r.selectNode(node)
    const b = r.getBoundingClientRect(), base = b.top + (b.height - m.fontBoundingBoxAscent - m.fontBoundingBoxDescent) / 2 + m.fontBoundingBoxAscent
    return [base - m.actualBoundingBoxAscent, base + m.actualBoundingBoxDescent]
  }
  const mark = scene.querySelector('.fts-brand svg').getBoundingClientRect(), em = parseFloat(getComputedStyle(scene.querySelector('.fts-brand')).fontSize)
  const top = ink(word.firstChild), foot = ver ? ink(ver.firstChild) : top
  const anims = scene.getAnimations({ subtree: true })
  const loops = anims.filter((a) => a.effect.getComputedTiming().iterations === Infinity)
  const cs = getComputedStyle(scene)
  return {
    gone: false, mounted: true, out: s.classList.contains('out'), still: 'still' in s.dataset,
    logo: !!s.querySelector('.tangu-splash-logo'), img: s.querySelectorAll('img').length, motion: s.dataset.customMotion || null,
    lines: [...scene.querySelectorAll('.fts-verse p')].map((p) => p.textContent),
    far: painted(far), near: painted(near),
    wallCorner: [...alphaAt(wall, 2, 2)], paneAlpha: wallAlpha(parseFloat(cs.getPropertyValue('--fts-cx')) / 100 * innerWidth + innerWidth * .08, parseFloat(cs.getPropertyValue('--fts-cy')) / 100 * innerHeight + innerHeight * .08),
    verseOnWall: onWall(verse), brandOnWall: onWall(brand),
    word: word.firstChild.textContent, ver: ver ? ver.textContent : null, brandKids: scene.querySelector('.fts-brand').querySelectorAll('*').length,
    lockup: [(top[0] - mark.top) / em, (foot[1] - mark.bottom) / em], markTall: mark.height / em,
    verUnder: !!ver && ver.getBoundingClientRect().top >= wordBox.bottom && Math.abs(ver.getBoundingClientRect().left - wordBox.left) < 1 && ver.getBoundingClientRect().height < wordBox.height,
    inView: [verse, brand].every((b) => b.x >= 0 && b.y >= 0 && b.x + b.w <= innerWidth && b.y + b.h <= innerHeight),
    names: anims.map((a) => a.animationName),
    loopNames: loops.map((a) => a.animationName).sort(),
    loopsRunning: loops.length > 0 && loops.every((a) => a.playState === 'running'),
    loopTime: Math.min(...loops.map((a) => Math.abs(a.currentTime || 0))),
    // 合成线程能独立跑的只有 transform / opacity;混进别的属性就得回主线程
    props: [...new Set(anims.flatMap((a) => a.effect.getKeyframes().flatMap((k) => Object.keys(k))))].filter((k) => !['offset', 'easing', 'composite', 'computedOffset'].includes(k)).sort(),
    verseOpacity: getComputedStyle(scene.querySelector('.fts-verse p')).opacity,
    cloudOpacity: getComputedStyle(scene.querySelector('.fts-cloud')).opacity,
    verseColor: cs.getPropertyValue('--fts-verse').trim(),
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch({ executablePath: findChromium() })
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  // 一个真源站:要 localStorage(暗色键 / 上一句的序号)。别的请求一律掐掉 → #root 恒空。
  let body = ''
  await page.route('https://splash.test/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/') await route.fulfill({ contentType: 'text/html; charset=utf-8', body })
    else await route.abort()
  })
  const open = async (content, query = '') => { body = content; await page.goto('https://splash.test/' + query, { waitUntil: 'domcontentloaded' }) }
  const firstFrame = () => page.evaluate(() => { document.getElementById('root').appendChild(document.createElement('div')) })

  // ═══ 树影(内置默认)═══
  // ── ① 没存过任何设置 → 树影;画布画出来了,诗句是五句之一 ──
  await open(html())
  await page.waitForTimeout(2600)
  const shadow = await page.evaluate(shadowState)
  check('缺省 = 树影(不是树标)', !!shadow.mounted && !shadow.logo && shadow.img === 0)
  check('三张图层都画出来了(远影 / 近影 / 带窗格洞的暗墙)',
    shadow.far > .01 && shadow.near > .01 && shadow.wallCorner[3] === 255 && shadow.paneAlpha < 30,
    `far=${shadow.far?.toFixed(3)} near=${shadow.near?.toFixed(3)} corner=${shadow.wallCorner} pane=${shadow.paneAlpha}`)
  check('诗句是五句之一,两行加出处', shadow.lines?.length === 3 && VERSES.includes(shadow.lines[0]) && /《.+》/.test(shadow.lines[2]), (shadow.lines || []).join(' / '))
  check('诗句与字标落在墙上(不压窗光)、不出画', !!shadow.verseOnWall && !!shadow.brandOnWall && !!shadow.inView)
  check('字标下面一行是盖进页面的版本号,左边对齐、字比字标小', shadow.word === 'FORSION' && shadow.ver === STAMP && !!shadow.verUnder, `${shadow.word} / ${shadow.ver}`)
  check('两行字和树标等高:大写字顶贴树标上沿、版本号的底贴树标下沿', aligned(shadow), lockupNote(shadow))
  check('枝影 / 窗光三条循环都是 infinite,且还在走', shadow.loopNames?.join() === 'fts-drift,fts-sway,fts-sway-far' && !!shadow.loopsRunning && shadow.loopTime > 2000, `${shadow.loopNames} t=${Math.round(shadow.loopTime)}ms`)
  check('只动 transform / opacity', shadow.props?.join() === 'opacity,transform', (shadow.props || []).join())
  check('首帧未出:闪屏还在(没被定时器撤走)', !shadow.gone && !shadow.out)
  await page.screenshot({ path: path.join(OUT, 'tree-shadow-light.png') })
  await firstFrame()
  await page.waitForTimeout(900) // 已过最短展示:只剩 380ms 淡出
  check('首帧画出后闪屏被移除(没有循环接缝要等)', (await page.evaluate(shadowState)).gone)
  // 没盖版本号(老构建 / 别处拼的页面)→ 不出这一行;盖进来的不是版本号 → 一个字都不进页面
  for (const [name, value] of [['没盖版本号', ''], ['盖进来的是一段标记', '1.2.3<img src=x onerror=alert(1)>'], ['盖进来的不是字符串', ['1.2.3']]]) {
    await open(html(undefined, undefined, value))
    await page.waitForTimeout(400)
    const bare = await page.evaluate(shadowState)
    check(`${name}:只有字标,没有版本那一行`, !!bare.mounted && bare.word === 'FORSION' && bare.ver === null && bare.brandKids === 3 && !!bare.brandOnWall && Math.abs(bare.lockup[0] + bare.lockup[1]) < LOCKUP, `ver=${bare.ver} kids=${bare.brandKids} ${lockupNote(bare)}`)
  }

  // ── ② 最短展示:首帧来得再早也守到 1.3 秒 ──
  await open(html())
  await firstFrame()
  await page.waitForTimeout(800)
  const early = await page.evaluate(shadowState)
  check('首帧很早:1.3 秒之前不退场', !early.gone && !early.out)
  await page.waitForTimeout(1300)
  check('首帧很早:过了最短展示就撤走', (await page.evaluate(shadowState)).gone)

  // ── ③ 天花板:首帧永远不来也必须自己撤(10s) ──
  await open(html())
  await page.waitForTimeout(9000)
  check('天花板前不早退(9s 仍在)', !(await page.evaluate(shadowState)).gone)
  await page.waitForTimeout(2000)
  check('10s 天花板:首帧永远不来也会自己撤走', (await page.evaluate(shadowState)).gone)

  // ── ④ 不跟随应用图标;只让位给用户选的开屏素材 ──
  await open(html({ icon: { image: png } }))
  const withIcon = await page.evaluate(shadowState)
  check('换了应用图标:树影照常,画面上没有那张图标', !!withIcon.mounted && withIcon.img === 0 && withIcon.motion === null)
  await open(html({ scene: 'classic', icon: { image: png } }))
  const classicIcon = await page.evaluate(shadowState)
  check('对照:经典图标仍跟随应用图标(呼吸)', !classicIcon.mounted && classicIcon.img === 1 && classicIcon.motion === 'pulse')
  await open(html({ splash: { image: svg } }))
  const artwork = await page.evaluate(shadowState)
  check('选了开屏素材:显示素材,不挂树影', !artwork.mounted && artwork.img === 1)
  await open(html({ splash: { image: broken } }))
  await page.locator('#tangu-splash .fts').waitFor()
  check('损坏的开屏素材回落到树影', (await page.evaluate(shadowState)).img === 0)
  for (const animation of ['pulse', 'spin']) {
    await open(html({ animation }))
    const s = await page.evaluate(shadowState)
    check(`加载动画选「${animation}」:树影照常(呼吸 / 旋转只作用于图标类开屏)`, !!s.mounted && s.motion === null && s.loopNames.length === 3)
  }

  // ── ⑤ 静止 / 减少动态效果:停在一帧,画面完整 ──
  await open(html({ animation: 'none' }))
  const still = await page.evaluate(shadowState)
  check('静止:树影停在一帧(没有任何动画,云已散、诗句可见)', !!still.mounted && still.still && still.names.length === 0 && still.cloudOpacity === '0' && still.verseOpacity === '1')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await open(html())
  const reduced = await page.evaluate(shadowState)
  check('减少动态效果:树影停在一帧', !!reduced.mounted && reduced.names.length === 0 && reduced.cloudOpacity === '0')
  await firstFrame()
  await page.waitForTimeout(700)
  check('减少动态效果:首帧一到就撤(不守最短展示)', (await page.evaluate(shadowState)).gone)
  // 选了开屏素材又开着减少动态效果:经典是换成应用图标;树影这边不许拿图标顶替 —— 用素材自己的静帧,
  // 没有静帧又可能会动的(SVG / GIF / WebP)停在树影的一帧,解不开的照样回落树影。
  const iconSrc = () => page.locator('#tangu-splash img').evaluateAll((imgs) => imgs.map((i) => i.src))
  await open(html({ icon: { image: svg }, splash: { image: svg, poster: png } }))
  check('减少动态效果 + 素材有静帧:显示静帧,不是应用图标', (await iconSrc()).join() === png)
  await open(html({ icon: { image: png }, splash: { image: svg } }))
  const noPoster = await page.evaluate(shadowState)
  check('减少动态效果 + 会动的素材没有静帧:停在树影,不是应用图标', !!noPoster.mounted && noPoster.img === 0 && noPoster.names.length === 0)
  await open(html({ icon: { image: png }, splash: { image: broken } }))
  await page.locator('#tangu-splash .fts').waitFor({ timeout: 5000 }).catch(() => {})
  const brokenReduced = await page.evaluate(shadowState)
  check('减少动态效果 + 损坏的素材:回落树影,不是应用图标', !!brokenReduced.mounted && brokenReduced.img === 0)
  await open(html({ scene: 'classic', icon: { image: png }, splash: { image: svg } }))
  check('对照:经典在减少动态效果下仍换成应用图标', (await iconSrc()).join() === png)
  await page.emulateMedia({ reducedMotion: 'no-preference' })

  // ── ⑥ 暗色 = 月光;每次换一句,不连着出同一句 ──
  await open(html())
  await page.evaluate(() => localStorage.setItem('forsion_theme', 'dark'))
  const picks = []
  for (let i = 0; i < 14; i++) { await open(html()); picks.push(VERSES.indexOf((await page.evaluate(shadowState)).lines[0])) }
  check('连开 14 次:都在五句之内,且不连着出同一句', picks.every((v, i) => v >= 0 && (!i || v !== picks[i - 1])) && new Set(picks).size >= 3, picks.join(''))
  await page.waitForTimeout(2600)
  const dark = await page.evaluate(shadowState)
  check('暗色:墙是墨色、字是月光下的浅色,诗句仍在墙上', dark.wallCorner.slice(0, 3).join() === '18,20,25' && dark.verseColor === '#ccd4e2' && !!dark.verseOnWall, `${dark.wallCorner} ${dark.verseColor}`)
  await page.screenshot({ path: path.join(OUT, 'tree-shadow-dark.png') })

  // ── ⑦ 竖屏 / 窄窗 / 小窗 / 大屏:诗句仍在墙上、不出画 ──
  for (const [w, h, shot] of [[390, 844, 'portrait'], [500, 300, 'preview'], [600, 900], [800, 600], [1024, 768], [1920, 1080], [2560, 1440, 'wide']]) {
    for (const mode of shot === 'portrait' ? ['dark', 'light'] : ['light']) {
      await page.setViewportSize({ width: w, height: h })
      await page.evaluate((m) => localStorage.setItem('forsion_theme', m), mode)
      await open(html())
      await page.waitForTimeout(shot ? 2600 : 50)
      const s = await page.evaluate(shadowState)
      check(`${w}×${h} ${mode}:画出来了,诗句与字标(连同版本号)在墙上、在画内`, !!s.mounted && !!s.verseOnWall && !!s.brandOnWall && !!s.inView && s.ver === STAMP && !!s.verUnder && aligned(s) && s.paneAlpha < 30 && s.far > .005, lockupNote(s))
      if (shot) await page.screenshot({ path: path.join(OUT, `tree-shadow-${shot}-${mode}.png`) })
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 })

  // Windows fonts at raster scales corresponding to 100 / 125 / 150 percent. These are renderer DPI checks, not a change to OS settings.
  for (const scale of [1, 1.25, 1.5]) for (const mode of ['light', 'dark']) {
    const scaled = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 800 }, deviceScaleFactor: scale })
    await scaled.addInitScript((mode) => localStorage.setItem('forsion_theme', mode), mode)
    const shot = await scaled.newPage()
    await shot.route('https://splash.test/**', (route) => new URL(route.request().url()).pathname === '/'
      ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: html() }) : route.abort())
    await shot.goto('https://splash.test/', { waitUntil: 'domcontentloaded' })
    await shot.waitForTimeout(2600)
    const s = await shot.evaluate(shadowState)
    check(`${mode} ${scale * 100}% DPI:诗句和字标在画内、版本行与树标对齐`, !!s.mounted && !!s.inView && !!s.verseOnWall && !!s.brandOnWall && s.ver === STAMP && aligned(s), lockupNote(s))
    await shot.screenshot({ path: path.join(OUT, `tree-shadow-${mode}-${scale * 100}.png`) })
    await scaled.close()
  }

  // ── ⑧ 设置里的「预览开屏」:沙箱 iframe 没有同源,localStorage 一碰就抛;运行时不许因此停在半路 ──
  const framed = fs.readFileSync(path.join(__dirname, ENTRIES[0]), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace('<!-- forsion-startup-runtime -->', () => `<script>window.FORSION_APP_VERSION=${JSON.stringify(STAMP)};window.tangu={startupAppearance:{initial:{"version":1,"showSplash":true}}};</script><script>${RUNTIME}</script><script>setTimeout(function(){document.getElementById('root').textContent=' ';},600);</script>`)
  await page.setContent(`<iframe sandbox="allow-scripts" style="width:900px;height:600px;border:0"></iframe>`)
  await page.locator('iframe').evaluate((el, doc) => { el.srcdoc = doc }, framed)
  const frame = page.frameLocator('iframe')
  const framedMounted = await frame.locator('#tangu-splash .fts').waitFor({ timeout: 5000 }).then(() => true, () => false)
  const framedVersion = await frame.locator('#tangu-splash .fts-ver').textContent({ timeout: 1000 }).catch(() => null)
  const storageThrows = await page.frames()[1].evaluate(() => { try { localStorage.getItem('x'); return false } catch { return true } })
  await frame.locator('#tangu-splash').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
  check('沙箱预览:存储不可用(负对照成立)时树影照常挂上并按时退场', framedMounted && storageThrows && await frame.locator('#tangu-splash').count() === 0)
  check('沙箱预览:版本号照样在', framedVersion === STAMP, String(framedVersion))

  // ═══ 经典图标(原来的默认,可在「开屏素材」里选回)═══
  // ── ⑨ 首帧迟迟不来 → 一直循环;首帧一到 → 在循环接缝处撤走 ──
  await open(html({ scene: 'classic' }))
  await page.waitForTimeout(CYCLE * 2 + 300) // 越过两轮
  const looping = await page.evaluate(classicState)
  check('经典:首帧未出,闪屏还在', !looping.gone && !looping.out)
  check('经典:四条动画都是 infinite(含接缝遮罩 forsion-seam)',
    !!looping.infinite && looping.names.includes('forsion-seam') && looping.names.length === 4, (looping.names || []).join(','))
  check('经典:两轮之后仍在跑(真循环,不是播完僵住)', !!looping.running && looping.pastFirstCycle > CYCLE, `t=${Math.round(looping.pastFirstCycle)}ms`)
  await page.screenshot({ path: path.join(OUT, 'classic-light.png') })

  // 接缝不"眨眼":循环回卷那一帧 logo 必须已经淡到近乎透明(否则「落定 → 突然隐形」看着像故障)。
  // 直接 seek 动画时间轴,不靠等待,零抖动。
  const seam = await page.evaluate((cycle) => {
    const logo = document.querySelector('#tangu-splash .tangu-splash-logo')
    const at = (ms) => {
      logo.getAnimations().forEach((a) => { a.currentTime = ms })
      return parseFloat(getComputedStyle(logo).opacity)
    }
    return { mid: at(cycle / 2), edge: at(cycle - 20), start: at(10) }
  }, CYCLE)
  check('经典:接缝被遮住(回卷处近乎透明,中段全不透明)',
    seam.mid > 0.99 && seam.edge < 0.3 && seam.start < 0.35, `start=${seam.start} mid=${seam.mid} edge=${seam.edge}`)

  await firstFrame()
  // 落定时刻 = 下一个 (n*CYCLE - 300);最坏再等一整轮 + 380ms 淡出
  await page.waitForTimeout(CYCLE + 900)
  check('经典:首帧画出后闪屏被移除', (await page.evaluate(classicState)).gone)
  await open(html({ scene: 'classic', splash: { image: broken } }))
  await page.locator('#tangu-splash .tangu-splash-logo').waitFor()
  check('经典:损坏的开屏素材回落到树标', await page.locator('#tangu-splash img, #tangu-splash .fts').count() === 0)

  // ── ⑩ 卫星窗口由已运行的主窗口创建,不属于 Forsion 启动流程,首帧就不应挂 Splash ──
  for (const kind of ['floating', 'detached', 'mini']) {
    await open(html(), `?window=${kind}`)
    check(`${kind} 卫星窗口从未挂载启动闪屏`, await page.locator('#tangu-splash').count() === 0)
  }

  // ═══ 三个真实入口用的是同一份运行时 ═══
  for (const entry of ENTRIES) {
    const at = (config) => open(html(config, entry))
    await at(null)
    check(`${entry}: 缺省挂树影`, await page.locator('#tangu-splash .fts canvas').count() === 3 && await page.locator('#tangu-splash .tangu-splash-logo').count() === 0)
    await at({ animation: 'none' })
    check(`${entry}: 静止时树影没有任何动画`, await page.locator('#tangu-splash').evaluate((s) => !!s.querySelector('.fts') && s.getAnimations({ subtree: true }).length === 0))
    await at({ scene: 'classic', animation: 'none' })
    check(`${entry}: 经典 + 静止关闭树标的所有内部动画`, await page.locator('#tangu-splash').evaluate((s) => !!s.querySelector('.tangu-splash-logo') && s.getAnimations({ subtree: true }).length === 0))
    await at({ scene: 'classic', animation: 'spin', icon: { image: png } })
    check(`${entry}: 经典 + 自定义图标使用所选动画`, await page.locator('#tangu-splash').evaluate((s) => s.dataset.customMotion === 'spin' && s.querySelector('img')?.getAnimations()[0]?.animationName === 'forsion-spin'))
    await at({ animation: 'none', splash: { image: svg, poster: png } })
    check(`${entry}: 静止素材使用首帧`, await page.locator('.forsion-startup-image').getAttribute('src') === png)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await at({ scene: 'classic', animation: 'spin', icon: { image: png }, splash: { image: svg } })
    check(`${entry}: 经典 + 减少动态效果,开屏素材换成静态图标`, await page.locator('#tangu-splash').evaluate((s) => s.querySelector('img')?.src.startsWith('data:image/png') && s.getAnimations({ subtree: true }).length === 0))
    await at({ animation: 'spin', icon: { image: png }, splash: { image: svg } })
    check(`${entry}: 减少动态效果下树影不拿应用图标顶替素材`, await page.locator('#tangu-splash').evaluate((s) => !!s.querySelector('.fts') && !s.querySelector('img') && s.getAnimations({ subtree: true }).length === 0))
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await open(html(null, entry, STAMP, true))
    check(`${entry}: Windows 原生减少动画覆盖失真的媒体查询,树影是完整静帧`, await page.locator('#tangu-splash').evaluate((s) => !matchMedia('(prefers-reduced-motion:reduce)').matches && s.hasAttribute('data-reduced-motion') && s.getAnimations({ subtree: true }).length === 0 && getComputedStyle(s.querySelector('.fts-verse p')).opacity === '1'))
    await open(html({ scene: 'classic', animation: 'spin', icon: { image: png } }, entry, STAMP, true))
    check(`${entry}: Windows 原生减少动画同样停止经典和自定义图标`, await page.locator('#tangu-splash').evaluate((s) => s.getAnimations({ subtree: true }).length === 0))
    await open(html(null, entry, STAMP, false, true))
    check(`${entry}: 软件渲染显示完整静帧并限制位图`, await page.locator('#tangu-splash').evaluate(s => s.dataset.performanceStill === 'software' && s.getAnimations({ subtree: true }).length === 0 && getComputedStyle(s.querySelector('.fts-verse p')).opacity === '1' && s.querySelector('canvas').width <= 960))
    await firstFrame()
    await page.waitForTimeout(200)
    check(`${entry}: 软件渲染准备好后立即退场`, await page.locator('#tangu-splash').count() === 0)
    await open(html({ scene: 'classic', animation: 'spin', icon: { image: png } }, entry, STAMP, false, true))
    check(`${entry}: 软件渲染降级不覆盖用户的经典图标动画`, await page.locator('#tangu-splash').evaluate(s => !s.hasAttribute('data-performance-still') && s.querySelector('img').getAnimations()[0]?.animationName === 'forsion-spin'))
    const slowClock = '<script>var raf=requestAnimationFrame,stamp=0;requestAnimationFrame=function(cb){return raf(function(){cb(stamp+=80)})};</script>'
    await open(html(null, entry).replace('<head>', '<head>' + slowClock))
    await page.waitForTimeout(300)
    check(`${entry}: 连续慢帧降级为完整静帧`, await page.locator('#tangu-splash').evaluate(s => s.dataset.performanceStill === 'frames' && s.getAnimations({ subtree: true }).length === 0 && getComputedStyle(s.querySelector('.fts-cloud')).opacity === '0'))
    await at({ showSplash: false })
    check(`${entry}: 用户可关闭开屏`, await page.locator('#tangu-splash').count() === 0)
    await at({ scene: 'classic', icon: { image: broken } })
    await page.locator('#tangu-splash .tangu-splash-logo').waitFor()
    check(`${entry}: 经典下损坏的图标恢复树标`, await page.locator('#tangu-splash img').count() === 0)
  }

  await browser.close()
  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} 通过   截图:${path.relative(process.cwd(), OUT)}/`)
  process.exit(bad.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
