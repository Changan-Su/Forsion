/**
 * enterSpace 定位逻辑的离线自检(Codex 第三轮 H2-2):不起 Electron,用 happy-dom 摆一个「…」溢出浮层,
 * 收件箱行带未读角标(aria-label =「收件箱,3 条未读」≠ 显示名)。按 data-id 与只按 .rb-label 两种情况都必须点中。
 * 旧实现(aria-label || title || .rb-label)两种都返回 false。跑:node scripts/lib/enter-space.selftest.cjs
 */
const { Window } = require('happy-dom')
const { enterSpace } = require('./uiux-electron.cjs')

async function probe(withDataId) {
  const w = new Window()
  const d = w.document
  d.body.innerHTML = `<div class="rb-top"><button class="rb-more"></button></div>
    <div class="rb-fly"><div class="rb-fly-row" ${withDataId ? 'data-id="space:inbox"' : ''}><button class="rb-btn rb-space" aria-label="收件箱,3 条未读"><span class="rb-label">收件箱</span><span class="rb-badge">3</span></button></div></div>`
  let clicked = false
  d.querySelector('.rb-space').addEventListener('click', () => { clicked = true })
  const win = {
    evaluate: async (x) => (typeof x === 'string' ? w.eval(x) : (clicked ? 'inbox' : 'tangu')), // 函数 = activeSpace
    locator: () => ({ first: () => ({ count: async () => 1, hover: async () => {} }) }),
    mouse: { click: async () => {} },
  }
  const ok = await enterSpace(win, 'inbox', { timeout: 300 })
  await w.happyDOM.close()
  return ok
}

;(async () => {
  const byId = await probe(true)
  const byLabel = await probe(false)
  console.log(`${byId ? 'PASS' : 'FAIL'}  溢出行按 data-id 定位(有未读角标)`)
  console.log(`${byLabel ? 'PASS' : 'FAIL'}  溢出行只按 .rb-label 定位(aria-label 带未读数)`)
  process.exit(byId && byLabel ? 0 : 1)
})().catch((e) => { console.error(e); process.exit(1) })
