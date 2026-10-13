/**
 * What travels with the keyboard, and from where (mobile/src/keyboardRise.ts) — `npm run test:kbrise`, no build, no device.
 * The module is bundled as it is and run against a hand-made page: marked elements that record the animations they are
 * given, a window whose height the test changes. What only a device can show (that the ride keeps step with the real
 * keyboard) is the emulator suite's `keyboard: the input travels with it`.
 */
const assert = require('node:assert/strict')
const path = require('node:path')
const { buildSync } = require('esbuild')

const src = buildSync({ entryPoints: [path.resolve(__dirname, '../src/keyboardRise.ts')], bundle: true, write: false, logLevel: 'silent', platform: 'node', format: 'cjs' }).outputFiles[0].text

/** A fresh page + module. `els` in document order; each: { rise?: 'end' | '', inside?: index of its ancestor, atEnd?, off? } */
function page(spec) {
  const listeners = { resize: [], focusout: [] }
  const win = { innerHeight: 800, innerWidth: 400, addEventListener: (t, f) => listeners[t]?.push(f), clearTimeout, setTimeout: (f, ms) => setTimeout(f, ms).unref(), matchMedia: () => ({ matches: win.reducedMotion === true }) }
  class HTMLTextAreaElement {}
  class HTMLInputElement {}
  const field = new HTMLTextAreaElement()
  const els = spec.map((x, i) => {
    const el = {
      i, anims: [], dataset: { kbRise: x.rise ?? '' }, currentCSSZoom: x.zoom ?? 1,
      contains: (o) => o === el || (o.inside !== undefined && (o.inside === i || els[o.inside].inside === i)),
      inside: x.inside,
      // laid out at the page's bottom edge (so it moves when the page's height does); `off` = a parked panel, beside the screen
      getBoundingClientRect: () => ({ width: 400, height: 100, top: win.innerHeight - 200, bottom: win.innerHeight - 100, left: x.off ? 400 : 0, right: x.off ? 800 : 400 }),
      querySelector: () => (x.rise === 'end' ? { scrollHeight: 2000, clientHeight: 600, scrollTop: x.atEnd === false ? 100 : 1400 } : null),
      animate: (frames, timing) => { const a = { frames, timing, cancelled: false, cancel() { a.cancelled = true } }; el.anims.push(a); return a },
    }
    return el
  })
  const doc = { defaultView: win, activeElement: field, querySelectorAll: () => els, addEventListener: (t, f) => listeners[t]?.push(f) }
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', 'window', 'document', 'HTMLTextAreaElement', 'HTMLInputElement', 'getComputedStyle', src)(mod, mod.exports, require, win, doc, HTMLTextAreaElement, HTMLInputElement, (e) => ({ zoom: '1', translate: e.drawnAt ?? 'none' })) // `drawnAt`: where a motion under way has the element
  mod.exports.installKeyboardRise()
  return { ...mod.exports, els, win, doc, resize: (h) => { win.innerHeight = h; for (const f of listeners.resize) f() }, blur: () => { doc.activeElement = null } }
}
const moved = (el) => el.anims.map((a) => `${a.frames[0].translate} → ${a.frames[1].translate}${a.timing.fill === 'forwards' ? ' (held)' : ''}${a.cancelled ? ' (dropped)' : ''}`)
const COLUMN = [{ rise: 'end' }, { inside: 0 }] // a chat: the column, and the input inside it

// ── Android 15+: the shell says the keyboard is coming; the column rides up, and the ride ends when the page shrinks
{
  const p = page(COLUMN)
  p.keyboardRise({ rise: 300, ms: 285, ease: 'linear(0, 0.5, 1)' })
  assert.deepEqual(moved(p.els[0]), ['0 0.00px → 0 -300.00px (held)'], 'at its end the column rides as one piece')
  assert.deepEqual(moved(p.els[1]), [], 'the input inside a riding column is not moved twice')
  assert.equal(p.els[0].anims[0].timing.easing, 'linear(0, 0.5, 1)', "the keyboard's own curve")
  assert.ok(p.els[0].anims[0].timing.delay < 0, 'the ride starts as far in as the keyboard already is')
  p.resize(760) // the dock's room going: not the keyboard's step
  assert.ok(!p.els[0].anims[0].cancelled, 'a small change of height must not end the ride')
  p.resize(500)
  assert.ok(p.els[0].anims[0].cancelled, 'the ride is dropped in the frame the page is made shorter')
  assert.equal(p.els[0].anims.length, 1, 'and nothing slides in after it')
}
// scrolled up: what is being read stays, the input rides alone
{
  const p = page([{ rise: 'end', atEnd: false }, { inside: 0 }])
  p.keyboardRise({ rise: 300, ms: 285 })
  assert.deepEqual([moved(p.els[0]), moved(p.els[1])], [[], ['0 0.00px → 0 -300.00px (held)']])
}
// the page's zoom: the travel is in screen dp
{
  const p = page([{ zoom: 1.15 }])
  p.keyboardRise({ rise: 230, ms: 285 })
  assert.deepEqual(moved(p.els[0]), ['0 0.00px → 0 -200.00px (held)'])
}
// animations off in the system (the keyboard is simply there), a parked list's bar, a refused easing
{
  const p = page([{}, { off: true }])
  p.keyboardRise({ rise: 300, ms: 0 })
  assert.deepEqual(moved(p.els[0]), [], 'no keyboard animation → nothing rides')
  p.keyboardRise({ rise: 300, ms: 285, ease: 'steps(2); background: red' })
  assert.equal(p.els[0].anims[0].timing.easing, 'cubic-bezier(0.2, 0, 0, 1)', 'only a sampled linear() curve is taken from the event')
  assert.deepEqual(moved(p.els[1]), [], 'an element off screen does not ride')
}
// sent away before it had arrived: the page was never made shorter, the shell says the keyboard is leaving and the
// column comes down from where the ride had it
{
  const p = page(COLUMN)
  p.keyboardRise({ rise: 300, ms: 285 })
  p.els[0].drawnAt = '0px -140px'
  p.keyboardRise({ rise: 0, ms: 285 })
  assert.deepEqual(moved(p.els[0]), ['0 0.00px → 0 -300.00px (held) (dropped)', '0 -140.00px → 0 0.00px'])
  p.els[0].drawnAt = 'none'; p.resize(500)
  assert.deepEqual(moved(p.els[1]), ['0 300.00px → 0 0.00px'], 'and nothing is left riding: the next change of height is read as usual')
  p.keyboardRise({ rise: 0, ms: 285 })
  assert.equal(p.els[0].anims.length, 2, 'a keyboard leaving with nothing riding moves nothing here (the page growing does)')
}
// the screen turned mid-ride: the ride is dropped
{
  const p = page(COLUMN)
  p.keyboardRise({ rise: 300, ms: 285 })
  p.win.innerWidth = 800; p.resize(780) // by itself too small a change of height to end a ride
  assert.ok(p.els[0].anims[0].cancelled)
}
// animations turned off in the system: nothing travels, by either road
{
  const p = page(COLUMN)
  p.win.reducedMotion = true
  p.keyboardRise({ rise: 300, ms: 285 })
  p.resize(500); p.resize(800)
  assert.deepEqual([moved(p.els[0]), moved(p.els[1])], [[], []])
}
// ── every version: the keyboard leaves, the page grows, the column slides down from where it stood
{
  const p = page(COLUMN)
  p.resize(500); p.els.forEach((e) => { e.anims = [] })
  p.resize(800)
  assert.deepEqual(moved(p.els[0]), ['0 -300.00px → 0 0.00px'])
  assert.deepEqual(moved(p.els[1]), [])
}
// ── before Android 15: the page shrinks at the keyboard's first frame; the input slides up into place, the column stays
{
  const p = page(COLUMN)
  p.resize(500)
  assert.deepEqual([moved(p.els[0]), moved(p.els[1])], [[], ['0 300.00px → 0 0.00px']])
}
// … and sent away before the input got there (scrolled up, so the input travels alone both ways): it turns round
// where it is — 120 below its old place is 180 above its new one
{
  const p = page([{ rise: 'end', atEnd: false }, { inside: 0 }])
  p.resize(500)
  p.els[1].drawnAt = '0px 120px'
  p.resize(800)
  assert.deepEqual(moved(p.els[1]), ['0 300.00px → 0 0.00px', '0 -180.00px → 0 0.00px'])
}
// not a keyboard: a small change, a turn of the screen, nothing being typed into
{
  const p = page(COLUMN)
  p.resize(740)
  p.win.innerWidth = 800; p.resize(400)
  p.blur(); p.resize(800)
  assert.deepEqual([moved(p.els[0]), moved(p.els[1])], [[], []])
}
console.log('keyboard-rise: ok')
