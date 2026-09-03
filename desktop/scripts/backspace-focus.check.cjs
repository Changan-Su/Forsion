// 「块首退格」回归仪器(npm run check:bsfocus)。
//
// 钉的是 Notion 语义两步走:标题块行首退格 → 第一次把标题降成正文(**焦点必须留在原块**),
// 第二次才并入上一块。列表/引用同理,普通块一次到位。
//
// 由来(2026-08-03):第一次退格后焦点会掉到 body,于是后面按多少次都毫无反应,永远并不进上一块。
// 纯推演试了四招全错(延迟 requestSelfFocus / applyTrigger / 同步 view.focus() / 显式 setSelection)。
// 真因靠取证栈拿到:PageView 里折叠外壳原本写成「有小节才包一层 div、没有就裸渲染 Row」的三元,
// 一行从标题变正文时该位置**元素类型变了** → React commitDeletionEffects → removeChild(.amx-hfold-wrap)
// → 连里面的 ProseMirror 一起卸载 → focusout → body。修法是让外壳恒存,只在里面按条件放箭头。
const fs = require('fs'); const os = require('os'); const path = require('path')
const { chromium } = require('playwright-core')
function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse())
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app); if (fs.existsSync(p)) return p
    }
  throw new Error('no chromium')
}
const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'

const SETS = [["标题块",["甲","# 标题乙","丙"],1,2,["甲\n标题乙","丙"]],["列表块",["甲","- 项乙","丙"],1,2,["甲\n项乙","丙"]],["引用块",["甲","> 引用乙","丙"],1,2,["甲\n引用乙","丙"]],["待办块",["甲","- [ ] 待办乙","丙"],1,2,["甲\n待办乙","丙"]],["普通块",["甲","乙","丙"],1,1,["甲\n乙","丙"]]]

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const results = []
  for (const [name, contents, idx, times, want] of SETS) {
    const p = await browser.newPage({ locale: 'zh-CN' })
    const errs = []
    p.on('pageerror', (e) => errs.push(e.message))
    await p.goto(`${URL}?fold`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.md-block .ProseMirror', { timeout: 20000 })
    await p.evaluate((cs) => {
      const iso = '2026-01-01T00:00:00.000Z'
      const refs = cs.map((_, i) => `a${i + 1}`)
      window.__pageStore.setState({
        activePage: 'Probe.md', vaultRoot: '/harness', status: 'ready',
        manifest: {
          schema: 1, id: 'probe', title: 'Probe', createdAt: iso, updatedAt: iso, compiler: { version: 'p' },
          root: { type: 'stack', children: refs.map((ref, i) => ({ type: 'row', id: `r${i}`, columns: [{ id: `c${i}`, width: 1, children: [{ ref }] }] })) },
          blocks: Object.fromEntries(refs.map((r) => [r, { type: 'markdown' }])),
        },
        blocks: Object.fromEntries(refs.map((r, i) => [r, { id: r, type: 'markdown', content: cs[i] }])),
      })
    }, contents)
    await p.waitForTimeout(800)
    const before = await p.evaluate(() => Object.values(window.__pageStore.getState().blocks).map((b) => b.content))

    await p.locator('.md-block .ProseMirror').nth(idx).click()
    await p.keyboard.press('Home')
    await p.waitForTimeout(200)
    const caret = () => p.evaluate(() => {
      const st = window.__pageStore.getState()
      const sel = getSelection()
      let el = sel && sel.rangeCount ? sel.getRangeAt(0).startContainer : null
      while (el && el.nodeType !== 1) el = el.parentNode
      const pm = el && el.closest ? el.closest('.ProseMirror') : null
      const pms = [...document.querySelectorAll('.md-block .ProseMirror')]
      const order = []
      for (const row of st.manifest.root.children) for (const col of row.columns) for (const r of col.children) order.push(st.blocks[r.ref]?.content)
      const ae = document.activeElement
      const tags = [...document.querySelectorAll('.md-block .ProseMirror')].map((e) => e.dataset.probeTag || 'NEW')
      return { blk: pm ? pms.indexOf(pm) : -1, off: sel ? sel.anchorOffset : -1, active: ae ? (ae.className || ae.tagName).toString().slice(0,30) : 'none', activeInPm: pms.findIndex((x) => x.contains(ae) || x === ae), tags, blocks: order }
    })
    await p.evaluate(() => { [...document.querySelectorAll('.md-block .ProseMirror')].forEach((e, i) => { e.dataset.probeTag = 'tag' + i }) })
    const seq = [await caret()]
    for (let k = 0; k < (times || 0); k++) {
      await p.keyboard.press('Backspace'); await p.waitForTimeout(600)
      seq.push(await caret())
    }
    const after = await p.evaluate(() => {
      const st = window.__pageStore.getState()
      const order = []
      for (const row of st.manifest.root.children) for (const col of row.columns) for (const r of col.children) order.push(st.blocks[r.ref]?.content)
      return order
    })
    // ① 每一步之后焦点都必须仍在某个 ProseMirror 里(掉到 body 就是本次要防的回归)
    const lost = seq.findIndex((x) => x.activeInPm < 0)
    // ② Notion 两步走:标题/列表/引用/待办的**第一次**退格只脱壳,块数不变、内容仍是三块;
    //    合并要到第二次。只看最终结果的话,「第一次啥也没干、第二次一步到位」也会蒙混过关。
    const twoStep = (times || 1) < 2 || seq[1].blocks.length === contents.length
    // ③ 第一次退格**不许把编辑器重挂**:本轮真因就是 React 卸载重建整棵子树。
    //    若某天靠「重挂后再自聚焦」把焦点找回来,① 会绿但病根还在 —— 这条钉住 DOM 身份。
    const noRemount = (times || 1) < 2 || seq[1].tags[idx] === 'tag' + idx
    const got = after.map((c) => (c || '').replace(/\n+$/, ''))
    const okContent = JSON.stringify(got) === JSON.stringify(want)
    const ok = lost < 0 && twoStep && noRemount && okContent && errs.length === 0
    results.push(ok)
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(8)} 焦点=${seq.map((x) => (x.activeInPm < 0 ? 'BODY' : 'blk' + x.activeInPm)).join('>')}  内容=${JSON.stringify(got)}`)
    if (lost >= 0) console.log(`        ← 第 ${lost} 步之后焦点掉出编辑器(active=${seq[lost].active})`)
    if (!twoStep) console.log(`        ← 第一次退格就合并了(期望先脱壳):${JSON.stringify(seq[1].blocks)}`)
    if (!noRemount) console.log(`        ← 第一次退格把编辑器重挂了(tags=${JSON.stringify(seq[1].tags)}),焦点是被"找回来"的,病根还在`)
    if (!okContent) console.log(`        ← 期望并入上一块 ${JSON.stringify(want)}`)
    if (errs.length) console.log('        ← 页面异常: ' + errs.join(' | '))
    await p.close()
  }
  await browser.close()
  const bad = results.filter((x) => !x).length
  console.log(`\n${results.length - bad}/${results.length} passed, ${bad} failed`)
  process.exit(bad ? 1 : 0)
}
main().catch((e) => { console.error('SCRIPT ERROR:', e); process.exit(1) })
