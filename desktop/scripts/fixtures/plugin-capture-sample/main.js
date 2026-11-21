// ctx.ui.capture / ctx.ui.record instrument (2026-11-19). The stage has four solid corners (red, green, blue, yellow)
// so the harness can check the PNG is the element and nothing else, and a counter + bar that change every 50 ms so
// a video has distinct frames. The "half" element starts half scrolled out of its scroller. window.__pcap hands the
// ctx to the harness (instrumentation only). Driven by scripts/plugin-capture.check.cjs.
window.__pcap = { ctx }

ctx.registerView({
  id: 'stage',
  title: { zh: '出图台', en: 'Capture stage' },
  mount(el) {
    el.innerHTML = `
<div style="padding: 24px; display: flex; gap: 24px; align-items: flex-start">
  <div data-pc="stage" style="position: relative; width: 480px; height: 300px; background: #ffffff; flex: none">
    <div style="position: absolute; left: 0; top: 0; width: 40px; height: 40px; background: #ff0000"></div>
    <div style="position: absolute; right: 0; top: 0; width: 40px; height: 40px; background: #00ff00"></div>
    <div style="position: absolute; left: 0; bottom: 0; width: 40px; height: 40px; background: #0000ff"></div>
    <div style="position: absolute; right: 0; bottom: 0; width: 40px; height: 40px; background: #ffff00"></div>
    <div data-pc="count" style="position: absolute; left: 60px; top: 90px; font: 64px/1 monospace; color: #000000">0</div>
    <div data-pc="bar" style="position: absolute; left: 0; top: 200px; height: 20px; width: 0; background: #ff00ff"></div>
  </div>
  <div data-pc="scroller" style="width: 200px; height: 120px; overflow: auto; background: #eeeeee; flex: none">
    <div style="height: 60px"></div>
    <div data-pc="half" style="height: 120px; background: #00aaaa"></div>
    <div style="height: 200px"></div>
  </div>
</div>`
    let n = 0
    const count = el.querySelector('[data-pc="count"]')
    const bar = el.querySelector('[data-pc="bar"]')
    const t = setInterval(() => { n++; count.textContent = String(n); bar.style.width = `${(n * 8) % 480}px` }, 50)
    return () => clearInterval(t)
  },
})
