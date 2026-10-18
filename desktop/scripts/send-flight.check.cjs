// 发送动效(views/chat2/sendFlight.ts,方案 B)真 Electron × 假引擎:
// ① 打开会话、加载历史时用户消息不播动画;② 发一条:新气泡从输入框那一行升上来(起点在下方 >30px),
//    上面看得见的消息一起被托上来,输入框里留一层字的影子上移淡出;③ 播完全部归位、影子移除、输入框清空;
// ④ 系统「减少动态效果」:只剩淡入,不位移、不出影子。两次连发,各定格 0/60/160/300/420ms 拍一张到 shotDir。
// (台架里 emulateMedia 切不动应用自己的明暗,深色没拍;动画只动 transform / opacity,不碰颜色。)
// 用法:npm run check:sendflight(先 npx electron-vite build)
const path = require('path')
const U = require('./lib/uiux-electron.cjs')
const { sleep } = U

const MESSAGES = Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'model' : 'user', content: i % 2 ? `第 ${i} 条回复。`.repeat(8) : `问题 ${i}:下午的会挪到几点了?`, timestamp: i + 1 }))
const FRAMES = [0, 60, 160, 300, 420]

let pass = 0, fail = 0
const check = (name, ok, detail) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  | ${JSON.stringify(detail)}`}`) }

// 拦下页面里每一个 element.animate:记下来并立即暂停,好按时间点定格拍照
const HOOK = () => {
  window.__anims = []
  if (window.__animHooked) return
  window.__animHooked = true
  const orig = Element.prototype.animate
  Element.prototype.animate = function (k, o) {
    const a = orig.call(this, k, o)
    if (window.__holdAnims) { a.pause(); window.__anims.push({ el: this, a, k }) }
    return a
  }
}

async function send(win, text) {
  const ta = win.locator('.t2c-ta').first()
  await ta.click()
  await ta.fill(text)
  await win.keyboard.press('Enter')
  for (let i = 0; i < 50; i++) {
    if (await win.evaluate((t) => [...document.querySelectorAll('.t2-userwrap')].some((w) => w.textContent.includes(t)), text)) return true
    await sleep(100)
  }
  return false
}

const facts = (win, text) => win.evaluate((text) => {
  const wrap = [...document.querySelectorAll('.t2-userwrap')].reverse().find((w) => w.textContent.includes(text))
  const mine = window.__anims.filter((x) => x.el === wrap)
  const move = mine.find((x) => String(x.k[0]?.transform || '').includes('translateY'))
  return {
    dy: move ? parseFloat(/translateY\(([-\d.]+)px/.exec(move.k[0].transform)[1]) : 0,
    wrapAnims: mine.length,
    siblings: window.__anims.filter((x) => x.el !== wrap && x.el.parentElement === wrap?.parentElement).length,
    ghost: window.__anims.some((x) => x.el.classList?.contains('t2c-send-ghost')),
  }
}, text)

async function frames(app, win, tag) {
  const dir = U.shotDir('sendflight')
  for (const t of FRAMES) {
    await win.evaluate((t) => window.__anims.forEach(({ a }) => { a.currentTime = t }), t)
    await sleep(60)
    await U.captureWindow(app, path.join(dir, `${tag}-${String(t).padStart(3, '0')}ms.png`))
  }
  await win.evaluate(() => { window.__holdAnims = false; window.__anims.forEach(({ a }) => a.play()) })
  return dir
}

;(async () => {
  const { app, win, close } = await U.launch({ tag: 'sendflight', messages: MESSAGES })
  try {
    await U.boot(app, win, { space: 'tangu', width: 1200, height: 800 })
    await win.evaluate(HOOK)
    await win.locator('.t2s-srow, .t2o-row').filter({ hasText: 'Probe session one' }).first().click({ timeout: 10_000 })
    await sleep(3000)
    const hist = await win.evaluate(() => [...document.querySelectorAll('.t2-userwrap')].reduce((n, w) => n + w.getAnimations().length, 0))
    check('① 打开会话:历史里的用户消息不播动画', hist === 0, { hist })

    for (const scheme of ['first', 'second']) {
      const text = `好,顺便把会议纪要整理成待办(${scheme})`
      await win.evaluate(() => { window.__anims = []; window.__holdAnims = true })
      check(`② 发出去了(${scheme})`, await send(win, text))
      await sleep(80)
      const f = await facts(win, text)
      check(`② 气泡从输入框那一行升上来(${scheme})`, f.dy > 30, f)
      check(`② 上面的消息一起被托上来(${scheme})`, f.siblings > 0, f)
      check(`② 输入框里的字留影子淡出(${scheme})`, f.ghost, f)
      const dir = await frames(app, win, scheme)
      await sleep(700)
      const after = await win.evaluate((text) => {
        const wrap = [...document.querySelectorAll('.t2-userwrap')].reverse().find((w) => w.textContent.includes(text))
        return { running: wrap.getAnimations().length, transform: getComputedStyle(wrap).transform, ghost: !!document.querySelector('.t2c-send-ghost'), draft: document.querySelector('.t2c-ta')?.value || '' }
      }, text)
      check(`③ 播完归位、影子移除、输入框清空(${scheme})`, !after.running && after.transform === 'none' && !after.ghost && !after.draft, { ...after, shots: dir })
      await sleep(1500)
    }

    await win.emulateMedia({ reducedMotion: 'reduce' })
    const text = '减少动态效果时只淡入'
    await win.evaluate(() => { window.__anims = []; window.__holdAnims = true })
    await send(win, text)
    await sleep(80)
    const r = await facts(win, text)
    await win.evaluate(() => { window.__holdAnims = false; window.__anims.forEach(({ a }) => a.play()) })
    check('④ 减少动态效果:只淡入,不位移、不出影子', r.wrapAnims === 1 && r.dy === 0 && !r.ghost && r.siblings === 0, r)
  } finally { await close() }
  console.log(`\n${pass}/${pass + fail} passed`)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
