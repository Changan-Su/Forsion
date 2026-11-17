// 交给原生层的配色在「减少动态效果」下不能变(lcl/engine/nativeSheet.ts 的 readNativeTheme)。
//   npm run check:nativetheme    —— 裸 Chromium,不起 Electron,几秒钟
// 2026-11-15 安卓真壳:只把系统动画时长调成 0,原生顶栏 / 底部面板 / 通知横幅的字、按钮、边线全成了背景色。
// 病根:base.css 护栏层的「减少动态效果」(以及设置里「只淡入淡出」的同一套规则)给每个元素挂 color 过渡,
// 读配色的探针元素也在内 —— 探针换一次 color 就起一段过渡,getComputedStyle 读到的是过渡的起点(上一个 token 的值,
// 或继承来的黑),于是每个 token 都读成第一个读到的那个。
// 这里拿真 base.css + 真 readNativeTheme(esbuild 打包),逐一比较:不减少动态 / 系统减少动态 / 应用里「只淡入淡出」
// 三种情况下读出的配色必须完全一样,并且字色不等于背景色;连读两次(顶栏每一步导航都读)也一样。
// 负对照:NATIVE_SHEET_TS=<修之前的 nativeSheet.ts(放在 lcl/engine/ 下,好解析 ./nativeIcon)> 再跑,减少动态与「只淡入淡出」两项必须红。
const fs = require('node:fs')
const path = require('node:path')
const { buildSync } = require('esbuild')
const { chromium } = require('playwright-core')
const { findChromium } = require('./lib/find-chromium.cjs')

const ROOT = path.resolve(__dirname, '..')
const CSS = ['frontend/src/styles/layers.css', 'frontend/src/styles/base.css'].map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n')
const SHEET = process.env.NATIVE_SHEET_TS || path.resolve(ROOT, '../lcl/engine/nativeSheet.ts')
const BUNDLE = buildSync({
  stdin: { contents: `export { readNativeTheme } from ${JSON.stringify(SHEET)}`, resolveDir: path.dirname(SHEET), loader: 'ts' },
  bundle: true, write: false, format: 'iife', globalName: 'NS', platform: 'browser', logLevel: 'silent',
  nodePaths: [path.join(ROOT, 'node_modules')], define: { 'process.env.NODE_ENV': '"production"' },
}).outputFiles[0].text

const PAGE = `<!doctype html><html data-mode="light"><head><style>${CSS}</style></head><body><div class="app">x</div><script>${BUNDLE}</script></body></html>`
const read = (page) => page.evaluate(() => [window.NS.readNativeTheme(), window.NS.readNativeTheme()])

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium() })
  let fail = 0
  const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : '  ' + JSON.stringify(detail)}`); if (!ok) fail++ }
  try {
    const page = await browser.newPage()
    await page.setContent(PAGE)
    const motion = await page.evaluate(() => getComputedStyle(document.querySelector('.app')).transitionProperty)
    for (const mode of ['light', 'dark']) {
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await page.evaluate((m) => { document.documentElement.dataset.mode = m; document.documentElement.classList.toggle('dark', m === 'dark'); delete document.documentElement.dataset.motionFade }, mode)
      const [plain, plainAgain] = await read(page)
      check(`${mode}: 正常读两次一样`, JSON.stringify(plain) === JSON.stringify(plainAgain), { plain, plainAgain })
      check(`${mode}: 正常时字色 ≠ 背景色(台架本身有效)`, plain.text !== plain.background && plain.border !== plain.background, plain)

      await page.emulateMedia({ reducedMotion: 'reduce' })
      const guard = await page.evaluate(() => getComputedStyle(document.querySelector('.app')).transitionProperty)
      check(`${mode}: 护栏层在减少动态下给元素挂上了 color 过渡(否则这个台架测不到病根)`, /color/.test(guard) && guard !== motion, { motion, guard })
      const [reduce, reduceAgain] = await read(page)
      const sameReduce = JSON.stringify({ ...reduce, motionFade: 0 }) === JSON.stringify({ ...plain, motionFade: 0 })
      check(`${mode}: 系统减少动态下配色不变`, sameReduce, { plain, reduce })
      check(`${mode}: 系统减少动态下连读第二次也不变`, JSON.stringify(reduceAgain) === JSON.stringify(reduce), { reduce, reduceAgain })

      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await page.evaluate(() => { document.documentElement.dataset.motionFade = 'on' })
      const [fade] = await read(page)
      const sameFade = JSON.stringify({ ...fade, motionFade: 0 }) === JSON.stringify({ ...plain, motionFade: 0 })
      check(`${mode}: 应用里「只淡入淡出」下配色不变(motionFade 照实报 true)`, sameFade && fade.motionFade === true, { plain, fade })
    }
  } finally { await browser.close() }
  if (fail) { console.error(`\n${fail} 项失败`); process.exit(1) }
  console.log('\n全部通过')
}
main().catch((e) => { console.error(e); process.exit(1) })
