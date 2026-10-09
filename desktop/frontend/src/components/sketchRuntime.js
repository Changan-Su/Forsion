/* Runs only inside the opaque-origin sandbox. No host capabilities or network. */
(() => {
  let state = __SKETCH_INITIAL_STATE__
  window.forsionSketch = Object.freeze({
    get state() { return state },
    setState(value) {
      const json = JSON.stringify(value)
      if (!json || new TextEncoder().encode(json).length > 16384) throw new Error('Sketch state exceeds 16 KiB')
      state = JSON.parse(json)
      parent.postMessage({ type: 'sketch-state', state }, '*')
    },
    // 卡内按钮回头改答案:把这句话当用户的下一条消息发出去(宿主侧再限频、限长、只在对话里接)。
    // 只认用户手势之后(navigator.userActivation 是本浏览上下文自己的):模型写的卡不能一加载 / 定时就替用户发话。
    ask(text) {
      if (!navigator.userActivation?.isActive) throw new Error('forsionSketch.ask() must be called from a user gesture')
      const t = String(text ?? '').trim().slice(0, 400)
      if (!t) throw new Error('forsionSketch.ask() needs a non-empty text')
      parent.postMessage({ type: 'sketch-ask', text: t }, '*')
    },
  })

  // An href must never turn a sandbox frame into an external navigation surface.
  document.addEventListener('click', (event) => {
    if (event.target.closest?.('a[href]')) event.preventDefault()
  }, true)
  document.addEventListener('submit', (event) => event.preventDefault(), true)

  window.addEventListener('message', (event) => {
    if (event.source !== parent) return
    const data = event.data
    if (!data || data.type !== 'sketch-theme' || !data.vars) return
    for (const [key, value] of Object.entries(data.vars)) {
      if (key.startsWith('--fs-')) document.documentElement.style.setProperty(key, String(value))
      else if (key === 'color-scheme') document.documentElement.style.colorScheme = String(value)
    }
    window.dispatchEvent(new Event('forsion:themechange'))
  })

  let lastHeight = 0
  function measure() {
    const height = Math.ceil(document.body?.getBoundingClientRect().height || 0)
    if (height && height !== lastHeight) {
      lastHeight = height
      parent.postMessage({ type: 'sketch-height', height }, '*')
    }
  }

  function selectTab(tab) {
    const list = tab.closest('.fs-tabs[role="tablist"]')
    if (!list || tab.disabled || tab.getAttribute('aria-disabled') === 'true') return
    for (const peer of list.querySelectorAll('[role="tab"]')) {
      const selected = peer === tab
      peer.setAttribute('aria-selected', String(selected))
      const panel = document.getElementById(peer.getAttribute('aria-controls'))
      if (panel?.getAttribute('role') === 'tabpanel') panel.hidden = !selected
    }
  }
  document.addEventListener('click', (event) => {
    const tab = event.target.closest?.('.fs-tabs [role="tab"]')
    if (tab) selectTab(tab)
  })
  document.addEventListener('keydown', (event) => {
    const tab = event.target.closest?.('.fs-tabs [role="tab"]')
    if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const tabs = [...tab.closest('.fs-tabs').querySelectorAll('[role="tab"]')]
      .filter((node) => !node.disabled && node.getAttribute('aria-disabled') !== 'true')
    const index = tabs.indexOf(tab)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
    event.preventDefault()
    tabs[next]?.focus()
    if (tabs[next]) selectTab(tabs[next])
  })

  function ready() {
    if (window.ResizeObserver) new ResizeObserver(measure).observe(document.body)
    measure()
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready)
  else ready()
  window.addEventListener('load', measure)
})()
