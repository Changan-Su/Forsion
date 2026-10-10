/* Runs only inside the opaque-origin sandbox. No host capabilities or network. */
(() => {
  let state = __SKETCH_INITIAL_STATE__
  // 授权令牌(Codex 10-09 二轮 P1):宿主只认带这个 nonce 的 ask / copy。它只活在这个闭包里 —— 运行时跑完就把自己的 script 节点删掉
  // (模型脚本读 outerHTML 也拿不到),模型 HTML 绕过运行时直接 postMessage 就没有它。真正的手势判定因此可以放在卡内:
  // navigator.userActivation 是每个 window 各自的,父文档里敲键不会传进子帧,子帧里的真点击才会让它为真。getter 在模型脚本
  // 跑之前就抓好,模型脚本改不了。
  const NONCE = '__SKETCH_NONCE__'
  const uaGet = typeof Navigator !== 'undefined' ? Object.getOwnPropertyDescriptor(Navigator.prototype, 'userActivation')?.get : undefined
  const activeGet = typeof UserActivation !== 'undefined' ? Object.getOwnPropertyDescriptor(UserActivation.prototype, 'isActive')?.get : undefined
  const gestureActive = () => { try { const ua = uaGet && uaGet.call(navigator); return !!(ua && activeGet && activeGet.call(ua)) } catch { return false } }
  const send = (msg) => parent.postMessage({ ...msg, nonce: NONCE }, '*')
  window.forsionSketch = Object.freeze({
    get state() { return state },
    setState(value) {
      const json = JSON.stringify(value)
      if (!json || new TextEncoder().encode(json).length > 16384) throw new Error('Sketch state exceeds 16 KiB')
      state = JSON.parse(json)
      parent.postMessage({ type: 'sketch-state', state }, '*')
    },
    // 卡内按钮回头改答案:把这句话当用户的下一条消息发出去(宿主侧再核 nonce + 焦点、限频、限长,只在对话里接)。
    // 手势检查在这里是**真闸**(见上):模型写的卡不能一加载 / 定时就替用户发话。
    ask(text) {
      if (!gestureActive()) throw new Error('forsionSketch.ask() must be called from a user gesture')
      const t = String(text ?? '').trim().slice(0, 400)
      if (!t) throw new Error('forsionSketch.ask() needs a non-empty text')
      send({ type: 'sketch-ask', text: t })
    },
    // 复制到剪贴板(沙箱帧自己没有剪贴板权限,由宿主代写;同样要用户手势)。
    copy(text) {
      if (!gestureActive()) throw new Error('forsionSketch.copy() must be called from a user gesture')
      const t = String(text ?? '')
      if (!t) return
      send({ type: 'sketch-copy', text: t.slice(0, 20000) })
    },
  })
  document.currentScript?.remove()

  // An href must never turn a sandbox frame into an external navigation surface.
  document.addEventListener('click', (event) => {
    if (event.target.closest?.('a[href]')) event.preventDefault()
  }, true)
  document.addEventListener('submit', (event) => event.preventDefault(), true)

  // 直播补丁(10-09,对标 ChatGPT Intelligent UI 的流式组件):宿主把最新 html 发进来,这里**原地**打补丁 —— 不换 srcdoc、不重载。
  // 同位置同标签的元素保留(只同步属性、递归子节点),文字节点原地续写,新节点标 data-fs-new 淡入;自定义元素(fs-*)内容一变整个换掉
  // (它们从 JSON 子节点取数据,只在接入时解析)。终稿(sketch-final)再把惰性的 script 节点换成会执行的,并补发 DOMContentLoaded / load,
  // 让「等 DOM 就绪再初始化」的两种写法都能跑。
  function syncAttrs(live, next) {
    for (const a of [...live.attributes]) if (a.name !== 'data-fs-new' && !next.hasAttribute(a.name)) live.removeAttribute(a.name)
    for (const a of [...next.attributes]) if (live.getAttribute(a.name) !== a.value) live.setAttribute(a.name, a.value)
  }
  const markNew = (n) => {
    if (n.nodeType !== 1) return
    n.setAttribute('data-fs-new', '')
    n.addEventListener('animationend', () => n.removeAttribute('data-fs-new'), { once: true })
  }
  function morph(live, next) {
    if (live.nodeType === 1 && next.nodeType === 1) syncAttrs(live, next)
    const a = [...live.childNodes], b = [...next.childNodes]
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i], y = b[i]
      if (!y) { x.remove(); continue }
      if (!x) { const n = document.importNode(y, true); markNew(n); live.appendChild(n); continue }
      if (x.nodeType === 3 && y.nodeType === 3) { if (x.nodeValue !== y.nodeValue) x.nodeValue = y.nodeValue; continue }
      const sameTag = x.nodeType === 1 && y.nodeType === 1 && x.tagName === y.tagName
      // 自定义元素渲染后 innerHTML 已是画好的 DOM,比的是它接入时记下的原始源码(_fsSrc),不然每一拍都会被换掉重画。
      if (sameTag && x.tagName.includes('-')) {
        if ((x._fsSrc ?? x.innerHTML) !== y.innerHTML) { const n = document.importNode(y, true); markNew(n); x.replaceWith(n) }
        else syncAttrs(x, y)
        continue
      }
      if (sameTag) { morph(x, y); continue }
      const n = document.importNode(y, true); markNew(n); x.replaceWith(n)
    }
  }
  // 会执行的 script type(HTML 标准的 JavaScript MIME 类型表 + module);其余(application/json、importmap …)是数据,原样留着
  const JS_TYPES = /^(?:module|(?:text|application)\/(?:x-)?(?:ecma|java)script|text\/(?:javascript1\.[0-5]|jscript|livescript))$/
  function applyHtml(html, final) {
    const t = document.createElement('template')
    t.innerHTML = html
    morph(document.body, t.content)
    if (final) {
      const pending = [] // module 脚本是异步执行的,等它们跑完再发就绪事件(Codex 10-09 P2)
      for (const s of [...document.body.querySelectorAll('script')]) {
        const type = (s.getAttribute('type') || '').trim().toLowerCase()
        if (type && !JS_TYPES.test(type)) continue
        const n = document.createElement('script')
        for (const attr of [...s.attributes]) n.setAttribute(attr.name, attr.value)
        n.textContent = s.textContent
        if (type === 'module') pending.push(new Promise((r) => { n.addEventListener('load', r, { once: true }); n.addEventListener('error', r, { once: true }) }))
        s.replaceWith(n)
      }
      const ready = () => { document.dispatchEvent(new Event('DOMContentLoaded')); window.dispatchEvent(new Event('load')); measure() }
      if (pending.length) Promise.all(pending).then(ready)
      else ready()
    }
    measure()
  }

  window.addEventListener('message', (event) => {
    if (event.source !== parent) return
    const data = event.data
    if (!data) return
    if (data.type === 'sketch-draft' || data.type === 'sketch-final') { applyHtml(String(data.html ?? ''), data.type === 'sketch-final'); return }
    if (data.type !== 'sketch-theme' || !data.vars) return
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
    window.__fsLoadedAt = Date.now() // 台架用:整张卡只加载一次(草稿 → 终稿不重载)
    if (window.ResizeObserver) new ResizeObserver(measure).observe(document.body)
    measure()
  }
  // once:终稿(sketch-final)会补发一次合成的 DOMContentLoaded 给模型脚本,运行时自己的就绪只跑一次
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true })
  else ready()
  window.addEventListener('load', measure)
})()
