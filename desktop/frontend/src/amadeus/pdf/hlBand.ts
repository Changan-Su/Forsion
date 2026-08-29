/**
 * 引用条临时高亮:把命中段画成 canvasWrapper 与 textLayer **之间**的 overlay 矩形,
 * `mix-blend-mode: multiply` 直接混进画布 —— 与批注(写进 PDF 的 Highlight 注释,pdf.js 按
 * Multiply 外观渲染)同一物理效果:纸变黄、**墨迹保持纯黑**(用户点名要与批注高亮同观感,08-28)。
 *
 * 为什么不能在文本层里画(上一版 .highlight::before 带子,已废):textLayer 自成隔离组
 * (z-index:0),画布不在它的 backdrop 里,multiply 恒空转 —— 只能靠半透明叠色,墨迹会被
 * 染成褐黄(实测 rgb(173,141,35)),和批注高亮一比一眼假。overlay 与画布同在 .page 的
 * 层叠上下文里(DOM 序插在 canvasWrapper 之后、textLayer 之前,不带 z-index),multiply 才是真的。
 *
 * 几何与旧版同一契约(check:hlband 钉着):纵向贴**行盒**(那条绝对定位的 textDiv;行内盒是
 * 字体 bounding box,逐字体而异,不可用 —— 三版踩坑史见 pdfAnnotator.css),横向贴命中段
 * 自己的矩形。两种命中形态都认(pdf.js _renderMatches):整段命中 → 类直接打在 textDiv 上;
 * 部分命中 → `.highlight.appended` 行内子元素,行盒是它的父。
 * 视口坐标 → overlay 局部 px 用 rect/offsetWidth 实测比例换算(祖先有 zoom/transform 时
 * rect 是缩放后的、offset 不是 —— 端级 zoom 的老坑)。
 *
 * 调用时机(PdfAnnotator 挂的):find 出结果(updatetextlayermatches)、文本层重建
 * (textlayerrendered,缩放/翻页后)。换关键词/翻走后残留的旧带子在这里顺手清。
 *
 * `pulseAge`:提醒动画的**已播毫秒数**(null = 不放)。**必须由调用方显式开** —— 每次重画都是
 * 新建 DOM,而 textlayerrendered 在滚动时页页都发,默认开 = 一滚就闪。
 * 传「年龄」而不是布尔:动画播到一半也可能重画(邻页渲染完),新节点用 `animation-delay: -age`
 * 接着原相位往下播,而不是从 0% 重来(Codex:那会看成闪两次)。
 * (check:hlband 直接调本函数不传 pulseAge,成色断言正好当这条的负对照:动画一开,取色必红。)
 * 返回本次画出的带子数 —— 调用方据此判断「落地了没有」。
 *
 * ⚠️ 动这里或动 css 里的 .pdfa-citehl 规则,跑 `npm run check:hlband`。
 */
export function paintHlBands(root: ParentNode, pulseAge: number | null = null): number {
  const byPage = new Map<HTMLElement, HTMLElement[]>()
  for (const el of root.querySelectorAll<HTMLElement>('.textLayer .highlight')) {
    const pg = el.closest<HTMLElement>('.page')
    if (!pg) continue
    const list = byPage.get(pg)
    if (list) list.push(el)
    else byPage.set(pg, [el])
  }
  // 清掉不再有命中的页上的旧层(翻页/换词后残留)
  for (const layer of root.querySelectorAll<HTMLElement>('.pdfa-citehl')) {
    const pg = layer.closest<HTMLElement>('.page')
    if (!pg || !byPage.has(pg)) layer.remove()
  }
  let painted = 0
  for (const [pg, els] of byPage) {
    const wrap = pg.querySelector<HTMLElement>(':scope > .canvasWrapper')
    if (!wrap) continue
    let layer = pg.querySelector<HTMLElement>(':scope > .pdfa-citehl')
    if (!layer) {
      layer = document.createElement('div')
      layer.className = 'pdfa-citehl'
      wrap.after(layer)
    }
    layer.textContent = ''
    const ar = layer.getBoundingClientRect()
    const s = layer.offsetWidth > 0 ? ar.width / layer.offsetWidth : 1
    for (const el of els) {
      const lineEl = getComputedStyle(el).position === 'absolute' ? el : el.parentElement
      if (!lineEl) continue
      const lr = lineEl.getBoundingClientRect()
      const r = el.getBoundingClientRect()
      if (r.width <= 0 || lr.height <= 0) continue
      const d = document.createElement('div')
      d.className = 'pdfa-citehl-band'
      if (pulseAge !== null) { d.classList.add('is-pulse'); d.style.animationDelay = `${-pulseAge}ms` }
      d.style.left = `${(r.left - ar.left) / s}px`
      d.style.top = `${(lr.top - ar.top) / s}px`
      d.style.width = `${r.width / s}px`
      d.style.height = `${lr.height / s}px`
      layer.appendChild(d)
      painted++
    }
  }
  return painted
}
