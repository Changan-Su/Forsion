/* 卡内的 WebRTC 封堵,必须是文档里第一个脚本(2026-10-31 在 Electron 40 / Chromium 144 和 Chromium 149 上实证,勿凭 spec 推理改动;
 * Firefox、Safari 没测过)。
 * CSP 管不到 RTCPeerConnection:`webrtc 'block'` 无效,setWebRTCIPHandlingPolicy 也拦不住走 TCP 的 TURN(USERNAME 照样送达),
 * 还会让同窗口的通话插件连不上。所以从 realm 下手:构造器删掉,新 realm 也不给。
 * 卡内脚本能用的新 realm 只有带脚本的子帧(srcdoc / javascript:),父帧跨源读不到它们的构造器。实测子帧里的脚本要隔一个任务才跑,
 * 而 MutationObserver 在当前任务的微任务检查点就把子帧摘掉,所以轮不到它执行。
 * shadow 树 MutationObserver 看不见,window.length 也不计里面的帧,所以直接不给:attachShadow 删掉,能解析 shadowrootmode 的入口
 * 按名字默认全删(只留 KEEP 里核对过不解析它的),新出的 appendHTML / streamHTML 一族也算在内;初始 HTML 里的在 buildSketchDoc 剥。
 * 用到的原生方法先抓在闭包里,模型脚本改原型改不到这里。自导航也是新 realm,由 SketchCard 给 iframe 的 csp 属性挡。
 * ponytail: 这是卡内封堵,上限是名字里不带 html / write 的新解析入口,以及 Chrome 129 之前的旧入口(includeShadowRoots、shadowroot 属性);
 * 升 Electron 跑 check:sketchrtc。真正的隔离等第三方小组件的隔离方案。 */
(() => {
  const { apply, deleteProperty, ownKeys, getOwnPropertyDescriptor: descriptor } = Reflect
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection']) deleteProperty(window, name)
  const frameCount = descriptor(window, 'length').get
  const query = Document.prototype.querySelectorAll
  const listSize = descriptor(NodeList.prototype, 'length').get
  const remove = Element.prototype.remove
  new MutationObserver(() => {
    if (!apply(frameCount, window, [])) return
    const found = apply(query, document, ['iframe,frame'])
    for (let i = apply(listSize, found, []) - 1; i >= 0; i--) apply(remove, found[i], [])
  }).observe(document, { childList: true, subtree: true })
  deleteProperty(Element.prototype, 'attachShadow')
  const KEEP = ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'getHTML']
  for (const owner of [Element.prototype, ShadowRoot.prototype, CharacterData.prototype, Document, Document.prototype]) {
    for (const name of ownKeys(owner)) {
      if (typeof name === 'string' && /html|write/i.test(name) && !KEEP.includes(name)) deleteProperty(owner, name)
    }
  }
})()
