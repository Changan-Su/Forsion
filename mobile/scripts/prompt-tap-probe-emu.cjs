/** Probe: does a tap on the native prompt's field land where the field is? (10-18: the 100k paste check's stray `v`.)
 *  The prompt focuses its field and raises the keyboard itself, and moves up with it. Opens it N times, taps where the
 *  first tree read put the field (what the check used to do) and prints that rect, where the field is once the keyboard
 *  is up and the field text right after the tap — a screenshot when it is not 'seed'. MODE=fixed: no tap, waits for the
 *  field to be focused with the keyboard up (the check's way now); must stay 0/N. Under load (busy loops in the
 *  emulator) a tap on the first-read spot typed Gboard's `v` 7 times in 7.
 *  Run: PKG=com.forsion.tangu.nativepreview OUT=/abs/dir N=20 node scripts/prompt-tap-probe-emu.cjs (app already set up) */
const h = require('./lib/emu-cdp.cjs')
const PKG = process.env.PKG || 'com.forsion.tangu'
const OUT = process.env.OUT || '/tmp'
const N = Number(process.env.N || 10)
const theme = { dark: false, background: '#FFF8F7F6', surface: '#FFFFFFFF', text: '#FF202124', muted: '#FF8A8D93', border: '#1F808080', accent: '#FF4D8794', onAccent: '#FFFFFFFF', danger: '#FFD04040' }
const fieldNode = (l) => h.byId(l, 'nativeSheet.prompt.field')
const ime = () => /mInputShown=true/.test(h.adb('shell', 'dumpsys', 'input_method'))
const fmt = (r) => r && `[${r.left},${r.top}][${r.right},${r.bottom}]`
;(async () => {
  h.adb('shell', 'am', 'start', '-n', `${PKG}/com.forsion.tangu.AppActivity`)
  const cdp = await h.connect(PKG)
  await h.waitPage(cdp, '!!window.Capacitor?.Plugins?.NativeSheet', 30000)
  let bad = 0
  for (let i = 1; i <= N; i++) {
    await cdp.eval(`(window.__p = null, Capacitor.Plugins.NativeSheet.present(${JSON.stringify({ requestId: `probe-${Date.now()}`, kind: 'prompt', title: 'probe', initial: 'seed', confirm: 'OK', cancel: 'Cancel', theme })}).then((r) => (window.__p = r.result ? r.result.text : 'cancel')), true)`)
    const s = await h.waitNodes((l) => (fieldNode(l) ? l : null), { timeout: 8000, out: OUT })
    if (!s.hit) { console.log(i, 'no sheet'); continue }
    await h.pause(450) // waitSheet's settle pause
    const first = fieldNode(s.hit).rect
    const kb0 = ime()
    if (process.env.MODE === 'fixed') { const r = await h.waitNodes((l) => (fieldNode(l)?.focused === 'true' && ime() ? l : null), { timeout: 8000, out: OUT }); if (!r.hit) console.log(i, 'never focused') }
    else { h.tapAt(first.cx, first.cy); await h.pause(400) }
    const l = h.nodes(OUT)
    const now = fieldNode(l)
    const text = now?.text || ''
    const odd = text !== 'seed'
    if (odd) { bad++; h.screenshot(OUT, `odd-${i}`) }
    console.log(`${i}${odd ? ' ODD' : ''} ${process.env.MODE === 'fixed' ? 'no tap; first read' : 'tapped'} (${first.cx},${first.cy}) on ${fmt(first)} · keyboard at the tap ${kb0} · field now ${fmt(now?.rect)} text ${JSON.stringify(text.slice(0, 8))}`)
    h.key(4); await h.pause(300)
    if (fieldNode(h.nodes(OUT))) h.key(4)
    await h.waitNodes((l2) => (!h.byId(l2, 'nativeSheet.sheet') ? l2 : null), { timeout: 8000, out: OUT })
    await h.pause(600)
  }
  console.log(`== ${bad}/${N} odd`)
  cdp.close()
  process.exit(bad ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
