/**
 * enterSpace 定位逻辑的离线自检(Codex 第三轮 H2-2):不起 Electron,用 happy-dom 摆一个收在「…」里的 Space
 * (点「…」= 展开,桩把格子插回上区),
 * 收件箱行带未读角标(aria-label =「收件箱,3 条未读」≠ 显示名)。按 data-id 与只按 .rb-label 两种情况都必须点中。
 * 旧实现(aria-label || title || .rb-label)两种都返回 false。跑:node scripts/lib/enter-space.selftest.cjs
 */
const { Window } = require('happy-dom')
const { enterSpace } = require('./uiux-electron.cjs')

async function probe(withDataId) {
  const w = new Window()
  const d = w.document
  d.body.innerHTML = `<div class="rb"><div class="rb-top"><button class="rb-more"></button></div></div>`
  let clicked = false
  const expand = async () => { // 点「…」= 上区展开:藏着的格子出现在条上
    d.querySelector('.rb').classList.add('rb-open-top')
    d.querySelector('.rb-top').insertAdjacentHTML('afterbegin', `<div class="rb-slot" ${withDataId ? 'data-id="space:inbox"' : ''}><button class="rb-btn rb-space" aria-label="收件箱,3 条未读"><span class="rb-label">收件箱</span><span class="rb-badge">3</span></button></div>`)
    d.querySelector('.rb-space').addEventListener('click', () => { clicked = true })
  }
  const win = {
    evaluate: async (x) => (typeof x === 'string' ? w.eval(x) : (clicked ? 'inbox' : 'tangu')), // 函数 = activeSpace
    locator: () => ({ first: () => ({ count: async () => 1, click: expand }) }),
    mouse: { click: async () => {} },
  }
  const ok = await enterSpace(win, 'inbox', { timeout: 300 })
  await w.happyDOM.close()
  return ok
}

;(async () => {
  const byId = await probe(true)
  const byLabel = await probe(false)
  console.log(`${byId ? 'PASS' : 'FAIL'}  「…」展开后按 data-id 定位(有未读角标)`)
  console.log(`${byLabel ? 'PASS' : 'FAIL'}  「…」展开后只按 .rb-label 定位(aria-label 带未读数)`)
  process.exit(byId && byLabel ? 0 : 1)
})().catch((e) => { console.error(e); process.exit(1) })
