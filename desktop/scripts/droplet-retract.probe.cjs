/** 液滴收起曲线探针(2026-11-16 Chat Box 水滴方案):droplet.ts 原样打包进一张空页,逐帧(rAF)量液体本体的裁切面积。
 *  量四件事:① 开满再收,前一半时间收掉几成、单帧最大一步 ② 开到 0.3D 就收,收的那一帧形状不跳
 *  ③ 收到一半又开(reopen),掉头那一帧不跳 ④ 收完清场(液体层摘掉、面板 visibility hidden)。
 *  用法:node scripts/droplet-retract.probe.cjs [--base](--base = 不换曲线的旧行为,负对照应在 ① 报红)
 *  不需要构建 / Electron;退出码非 0 = 有一项红。 */
const path = require('path')
const ROOT = path.resolve(__dirname, '..')
const esbuild = require(path.join(ROOT, 'node_modules/esbuild'))
const { chromium } = require(path.join(ROOT, 'node_modules/playwright-core'))
const { findChromium } = require('./lib/find-chromium.cjs')
const BASE = process.argv.includes('--base')
;(async () => {
  const out = await esbuild.build({
    stdin: { contents: "export { emergeDroplet } from './droplet'", resolveDir: path.join(ROOT, '../lcl/engine'), loader: 'ts' },
    bundle: true, format: 'iife', globalName: 'L', write: false, target: 'es2020',
    plugins: [{ name: 'stub', setup(b) {
      b.onResolve({ filter: /^\.\/(menuAnchor|spring)$/ }, (a) => ({ path: a.path, namespace: 'stub' }))
      b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ loader: 'js', contents: a.path.includes('menuAnchor')
        ? "export const zoomOf = () => 1; export const UI_ZOOM_EVENT = 'z'" : 'export const reducedMotion = () => false' }))
    } }],
  })
  const b = await chromium.launch({ executablePath: findChromium() })
  const page = await b.newPage()
  await page.setContent(`<style>:root{--droplet-duration:420ms;${BASE ? '--droplet-retract-ease:cubic-bezier(0.22, 1, 0.36, 1);' : ''}}
    body{margin:0;background:#f4f3ef} .lcl-droplet{position:fixed;pointer-events:none;filter:url(#lcl-droplet-goo)} .lcl-droplet>i{position:absolute}
    #src{position:fixed;left:40px;top:300px;width:80px;height:28px;border-radius:14px;background:#e6e4de}
    #pan{position:fixed;left:40px;top:60px;width:224px;height:230px;border-radius:12px;background:#fff;z-index:10}</style>
    <div id="src"></div><div id="pan"><div>a</div><div>b</div></div><script>${out.outputFiles[0].text}</script>`)
  const res = await page.evaluate(async () => {
    const D = 420
    const raf = () => new Promise((r) => requestAnimationFrame(r))
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const pan = document.getElementById('pan'), src = document.getElementById('src')
    // 液体本体(液体层第二个 i)的裁切 → 面积占面板几成
    const area = () => {
      const body = document.querySelector('.lcl-droplet > i:nth-child(2)')
      if (!body || document.querySelector('.lcl-droplet').style.display === 'none') return 1
      const m = /inset\(([-\d.]+)px ([-\d.]+)px ([-\d.]+)px ([-\d.]+)px/.exec(getComputedStyle(body).clipPath)
      if (!m) return 1
      const [t, r, bo, l] = m.slice(1).map(Number), w = 224, h = 230
      return Math.max(0, (w - l - r) * (h - t - bo)) / (w * h)
    }
    const film = async (ms) => { const a = []; const t0 = performance.now(); while (performance.now() - t0 < ms) { await raf(); a.push(area()) } return a }
    const out = {}
    // ① 开满再收
    let d = L.emergeDroplet(src, pan); await wait(D + 80)
    const before = area(); d.retract(); const f1 = [before, ...(await film(D * 0.7 + 60))]
    // 液体层摘掉后 area() 读回 1:只看到最小值为止
    const n = f1.indexOf(Math.min(...f1)) + 1, half = f1[Math.floor(n / 2)]
    const steps = f1.slice(1, n).map((v, i) => f1[i] - v)
    out.full = { firstHalf: +(1 - half).toFixed(3), maxStep: +Math.max(...steps).toFixed(3), monotone: steps.every((s) => s > -0.002) }
    out.cleanup = { layer: !!document.querySelector('.lcl-droplet'), vis: pan.style.visibility }
    d.cancel(); pan.style.visibility = ''; await wait(50)
    // ② 开到 0.3D 就收:收那一帧对比前一帧
    d = L.emergeDroplet(src, pan); await wait(D * 0.3)
    const a0 = area(); d.retract(); await raf(); const a1 = area(); await raf(); const a2 = area()
    // 「跳」= 换向那一帧朝原方向多走了一步(先胀后缩),或那一步比下一步大出一截
    out.midClose = { before: +a0.toFixed(3), after: +a1.toFixed(3), next: +a2.toFixed(3), jump: a1 > a0 + 0.002 || (a0 - a1) > 1.6 * (a1 - a2) + 0.01 }
    await wait(D); d.cancel(); pan.style.visibility = ''; await wait(50)
    // ③ 开满、收到一半又开
    d = L.emergeDroplet(src, pan); await wait(D + 80); d.retract(); await wait(D * 0.7 * 0.45)
    const b0 = area(); const ok = d.reopen(); await raf(); const b1 = area(); await raf(); const b2 = area()
    out.reopen = { ok, before: +b0.toFixed(3), after: +b1.toFixed(3), next: +b2.toFixed(3), jump: b1 < b0 - 0.002 || (b1 - b0) > 1.6 * (b2 - b1) + 0.01 }
    await wait(D + 100); out.reopenEnd = { pouring: pan.classList.contains('lcl-droplet-pouring'), kids: [...pan.children].map((k) => +getComputedStyle(k).opacity) }
    d.cancel()
    return out
  })
  await b.close()
  console.log(JSON.stringify(res, null, 1))
  const checks = [
    ['开满再收:前一半时间收掉 ≥ 35%', res.full.firstHalf >= 0.35],
    ['开满再收:单帧最大一步 ≤ 11%', res.full.maxStep <= 0.11],
    ['开满再收:只缩不胀', res.full.monotone],
    ['收完清场', !res.cleanup.layer && res.cleanup.vis === 'hidden'],
    ['开到 0.3D 就收:那一帧不跳(不先胀一下、步子和下一帧相当)', !res.midClose.jump],
    ['收到一半又开:掉头那一帧不跳(不先缩一下、步子和下一帧相当)', res.reopen.ok && !res.reopen.jump],
    ['掉头后停在打开', !res.reopenEnd.pouring && res.reopenEnd.kids.every((o) => o === 1)],
  ]
  for (const [k, v] of checks) console.log(v ? 'PASS' : 'FAIL', k)
  process.exit(checks.every(([, v]) => v) ? 0 : 1)
})().catch((e) => { console.error(e); process.exit(1) })
