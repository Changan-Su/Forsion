/**
 * 浮层菜单在触屏上的可点性守卫 —— `npm run check:menutap`。
 *
 * 起因(2026-08-04):移动端「选择工作区」下拉,条目单击没反应、长按才行。
 * 机理(下面第 1 段真跑一遍给你看):菜单是 `position:absolute; bottom:100%` 向上开的,
 * 搜索框带 autoFocus → 安卓弹软键盘 → adjustResize 压掉可用高度 → 点条目那一下键盘收回、
 * 整块菜单在手指底下位移 → click 落到菜单容器/背景上,条目永远收不到。
 *
 * 两段:
 *  1. 机理复现:同一页面,autoFocus 开/关各点一次,断言「关=条目收到 click,开=收不到」。
 *     这一段哪天两边都通过了,说明浏览器行为变了,规则可以重议 —— 那时它会红,提醒你来看。
 *  2. 源码守卫:浮层菜单里的搜索框不许写裸 autoFocus(必须 autoFocus={!isCoarsePointer()})。
 *     这一段才是防回归的。
 */
const path = require('path'), fs = require('fs'), os = require('os')
const { chromium } = require(path.resolve(__dirname, '../node_modules/playwright-core'))
const SRC = path.resolve(__dirname, '../frontend/src')

// 受管的浮层菜单搜索框(不含全屏对话框/搜索面板 —— 那些的输入框本来就是用户的目标)。
const GUARDED = ['components/ProjectSelector.tsx', 'components/ModelSelect.tsx']

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  for (const root of [path.join(os.homedir(), 'Library/Caches/ms-playwright'), path.join(os.homedir(), '.cache/ms-playwright')]) {
    if (!fs.existsSync(root)) continue
    for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse())
      for (const rel of [
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
        'chrome-linux/chrome',
        'chrome-linux64/chrome',
      ]) { const e = path.join(root, d, rel); if (fs.existsSync(e)) return e }
  }
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
}

/** 复刻 .project-menu 的真实形态:body zoom 1.15、向上开、条目在菜单里。 */
const page = (autofocus) => `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<style>
 body{zoom:1.15;margin:0;font-family:system-ui}
 #app{position:fixed;inset:0;bottom:var(--kbd,0px)}      /* 安卓 adjustResize:键盘吃掉底部高度 */
 .bar{position:absolute;bottom:60px;left:24px}
 .sel{position:relative;display:inline-flex}
 .menu{position:absolute;bottom:calc(100% + 6px);left:0;width:224px;padding:4px;border:1px solid #ccc}
 .item{display:block;width:100%;min-height:28px;padding:4px 8px;text-align:left}
</style>
<div id=app><div class=bar><div class=sel>
 <button id=pill>Tangu 默认工作区</button>
 <div class=menu id=menu hidden><input id=q><button class=item id=it>Cloud 工作区</button></div>
</div></div></div>
<script>
 window.__hit=false
 const q=document.getElementById('q'), menu=document.getElementById('menu')
 q.addEventListener('focus',()=>document.documentElement.style.setProperty('--kbd','320px'))
 document.addEventListener('touchstart',(e)=>{        // 触屏一碰非输入区 → 键盘收回(带动画)
   if(e.target===q||document.activeElement!==q)return
   q.blur(); const t0=Date.now()
   const step=()=>{const k=Math.max(0,320*(1-(Date.now()-t0)/250))
     document.documentElement.style.setProperty('--kbd',k+'px'); if(k>0)requestAnimationFrame(step)}
   step()
 },true)
 document.getElementById('pill').addEventListener('click',()=>{menu.hidden=false;${autofocus ? 'q.focus()' : ''}})
 document.getElementById('it').addEventListener('click',()=>{window.__hit=true})
</script>`

;(async () => {
  const fails = []

  // ── 1. 机理复现 ──────────────────────────────────────────────
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const got = {}
  for (const autofocus of [true, false]) {
    const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true })
    const p = await ctx.newPage()
    await p.setContent(page(autofocus))
    const cdp = await ctx.newCDPSession(p)
    const tap = async (sel) => {
      const b = await p.locator(sel).boundingBox()
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + b.width / 2, y: b.y + b.height / 2 }] })
      await new Promise((r) => setTimeout(r, 60))
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await p.waitForTimeout(200)
    }
    await tap('#pill')
    await tap('#it')
    got[autofocus] = await p.evaluate(() => window.__hit)
    await ctx.close()
  }
  await browser.close()
  console.log(`  机理:autoFocus=开 → 条目${got[true] ? '收到' : '收不到'} click;autoFocus=关 → 条目${got[false] ? '收到' : '收不到'} click`)
  if (!got[false]) fails.push('对照组也点不中 —— 探针本身坏了,先修探针再谈结论')
  if (got[true]) fails.push('autoFocus 开着也点得中了 —— 浏览器行为变了,本规则可以重议(顺手更新本文件)')

  // ── 2. 源码守卫 ──────────────────────────────────────────────
  for (const rel of GUARDED) {
    const src = fs.readFileSync(path.join(SRC, rel), 'utf8')
    for (const [i, line] of src.split('\n').entries())
      if (/<input\b[^>]*\bautoFocus(?![=\w])/.test(line))
        fails.push(`${rel}:${i + 1} 浮层菜单里的搜索框写了裸 autoFocus,须 autoFocus={!isCoarsePointer()}`)
  }

  if (fails.length) { console.error('\n❌ check:menutap\n' + fails.map((f) => '  - ' + f).join('\n')); process.exit(1) }
  console.log('✅ check:menutap')
})().catch((e) => { console.error(e); process.exit(1) })
