/** 图片工具条(2026-11-17「页面编辑对齐 Notion」第 4 条,方案 docs/ToBeImproved/Notion页面编辑对齐方案_2026-11-17 §4):
 *  左 / 中 / 右 · 说明 · 替换 · 打开 · 全屏 · 下载 · `</>` · ⋯(复制图片、删除)。
 *  「打开」只有 `![[…]]` 形态给,单独一颗、↗ 图标(11-18 用户定:11-07 起它常驻在图片右上角、图标是 ⤢,
 *  和「全屏」撞了图标,习惯点 ⤢ 打开的人会点成全屏 —— 所以换 ↗,也不收进 ⋯)。
 *
 *  两种摆法,同一排按钮、同一组动作:
 *   · hover —— 桌面:挂在图片包裹层(`.wiki-inline-img-wrap`)里,悬停浮在图片右上角;图比工具条窄时挪到图片上方。
 *   · sheet —— 粗指针(手机 / 平板):点图选中后贴底出一条,摆在移动端编辑胶囊 `.amx-mbar` 上面。
 *
 *  只管画按钮和 ⋯ 菜单;每个动作怎么改文档归调用方(mdImage.ts / wikilink.ts),这里不碰 ProseMirror。
 *  会改文档的按钮只读时不出(调用方执行时还会再判一次 view.editable —— dispatch 不看只读)。
 *  文案在露出时现取(refresh):切过语言,下次悬停就是新文案。 */
import type { EditorView } from '@milkdown/kit/prose/view'
import { fromAssetUrl } from '@amadeus-shared/assets'
import { edgeNudge, followAnchor } from '@lcl/engine'
import { registerMessages, subscribeLocale, translate } from '../../../i18n'
import type { TextAlignment } from './paragraphIndent'

registerMessages({
  'imgtb.label': { zh: '图片工具', en: 'Image tools' },
  'imgtb.alignLeft': { zh: '左对齐', en: 'Align left' },
  'imgtb.alignCenter': { zh: '居中', en: 'Align center' },
  'imgtb.alignRight': { zh: '右对齐', en: 'Align right' },
  'imgtb.caption': { zh: '说明', en: 'Caption' },
  'imgtb.replace': { zh: '替换', en: 'Replace' },
  'imgtb.fullscreen': { zh: '全屏查看', en: 'View full screen' },
  'imgtb.download': { zh: '下载', en: 'Download' },
  'imgtb.source': { zh: '查看源码', en: 'View source' },
  'imgtb.more': { zh: '更多', en: 'More' },
  'imgtb.open': { zh: '打开', en: 'Open' },
  'imgtb.openHint': { zh: '⌘/Ctrl+点击在新标签页打开', en: '⌘/Ctrl+click to open in a new tab' },
  'imgtb.copy': { zh: '复制图片', en: 'Copy image' },
  'imgtb.delete': { zh: '删除', en: 'Delete' },
  'imgtb.captionPlaceholder': { zh: '写个说明…', en: 'Write a caption…' },
  'imgtb.copied': { zh: '已复制图片', en: 'Image copied' },
  'imgtb.copyFailed': { zh: '复制失败', en: 'Could not copy the image' },
  'imgtb.replaceFailed': { zh: '替换失败', en: 'Could not replace the image' },
  'imgtb.downloadFailed': { zh: '下载失败', en: 'Could not download the image' },
})

const SVG = (inner: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`
// lucide:align-left / align-center / align-right / captions / refresh-cw / maximize-2 / download / ellipsis / external-link / copy / trash-2
const ICON = {
  alignLeft: SVG('<path d="M21 6H3"/><path d="M15 12H3"/><path d="M17 18H3"/>'),
  alignCenter: SVG('<path d="M21 6H3"/><path d="M17 12H7"/><path d="M19 18H5"/>'),
  alignRight: SVG('<path d="M21 6H3"/><path d="M21 12H9"/><path d="M21 18H7"/>'),
  caption: SVG('<rect width="18" height="14" x="3" y="5" rx="2" ry="2"/><path d="M7 15h4M15 15h2M7 11h2M13 11h4"/>'),
  replace: SVG('<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>'),
  fullscreen: SVG('<path d="M15 3h6v6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/><path d="M9 21H3v-6"/>'),
  download: SVG('<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>'),
  more: SVG('<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>'),
  open: SVG('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
  copy: SVG('<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'),
  trash: SVG('<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>'),
}

/** 工具条要的动作。可选项不给 = 那颗按钮不出(如 `![[x.png]]` 形态没有说明的存处,不给 caption —— 见 wikiImageToolbar.ts)。 */
export interface ImageToolbarActions {
  view: EditorView
  /** 图片所在那一段的对齐(高亮当前档)。 */
  align(): TextAlignment
  setAlign(a: TextAlignment): void
  caption?: () => void
  /** 说明输入行开着(「说明」键呈按下态)。 */
  captionOpen?: () => boolean
  replace?: () => void
  fullscreen(): void
  download(): void
  source(): void
  /** 「打开」:应用内打开这张图(⌘/Ctrl+点击 = 新标签页)。只有 `![[…]]` 形态给;工具条上单独一颗,不进 ⋯。 */
  open?: (newTab: boolean) => void
  copy?: () => void
  remove(): void
}

export interface ImageToolbar {
  /** 工具条本体(`.amx-img-tb`)。 */
  el: HTMLElement
  /** 现取文案、只读态、按下态。露出前调一次。 */
  refresh(): void
  closeMenu(): void
  menuOpen(): boolean
  destroy(): void
}

type Act = 'alignLeft' | 'alignCenter' | 'alignRight' | 'caption' | 'replace' | 'open' | 'fullscreen' | 'download' | 'source' | 'more'
const ALIGN_OF: Partial<Record<Act, TextAlignment>> = { alignLeft: 'left', alignCenter: 'center', alignRight: 'right' }
/** 会改文档的键:只读时不出。 */
const EDITS = new Set<Act>(['alignLeft', 'alignCenter', 'alignRight', 'caption', 'replace', 'source'])

/** 按下吞掉:ProseMirror 会按坐标改选区、抢焦点;按钮自己的 click 照常。键盘也不往上冒(否则编辑器键位表拿去删字插段)。 */
function shield(el: HTMLElement): void {
  el.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation() })
  el.addEventListener('pointerdown', (e) => e.stopPropagation())
  el.addEventListener('keydown', (e) => e.stopPropagation())
}

/** host = 菜单的定位父级:hover 摆法是图片包裹层,sheet 摆法是贴底那一条的外壳。 */
export function buildImageToolbar(a: ImageToolbarActions, host: HTMLElement, variant: 'hover' | 'sheet'): ImageToolbar {
  const el = document.createElement('span')
  el.className = `amx-img-tb amx-img-tb--${variant}`
  el.contentEditable = 'false'
  el.setAttribute('role', 'toolbar')
  shield(el)
  const btns = new Map<Act, HTMLButtonElement>()
  const seps: HTMLElement[] = []
  const groups: Act[][] = [
    ['alignLeft', 'alignCenter', 'alignRight'],
    ['caption', 'replace', 'open', 'fullscreen', 'download'],
    ['source', 'more'],
  ]
  for (const [gi, group] of groups.entries()) {
    if (gi > 0) {
      const s = document.createElement('span')
      s.className = 'amx-img-tb-sep'
      el.appendChild(s)
      seps.push(s)
    }
    for (const act of group) {
      if (act === 'caption' && !a.caption) continue
      if (act === 'replace' && !a.replace) continue
      if (act === 'open' && !a.open) continue
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'amx-img-tb-btn'
      b.dataset.act = act
      if (act === 'source') {
        b.classList.add('amx-img-tb-src')
        b.textContent = '</>'
      } else b.innerHTML = act === 'more' ? ICON.more : ICON[act]
      b.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        if (act === 'open') {
          closeMenu()
          return a.open?.(e.metaKey || e.ctrlKey)
        }
        // 键盘 Enter / 空格激活按钮时 click 的 detail 是 0:菜单挂在 body 末尾,Tab 走不进去 —— 打开就把焦点放到第一项
        if (act === 'more') return void (menu ? closeMenu() : openMenu(e.detail === 0))
        run(act)
      })
      btns.set(act, b)
      el.appendChild(b)
    }
  }

  let menu: HTMLElement | null = null
  let stopFollow: (() => void) | null = null
  /** 工具条此刻还在用:连在文档里、没被藏起、所在编辑器没 inert。切阅读模式 = 编辑器藏起 + inert,但 view 仍是可编辑的 ——
   *  挂在 body 下的 ⋯ 菜单不会跟着藏,不判这一下,点「删除」照样改文档(Codex 评审 P1)。 */
  const live = (): boolean =>
    el.isConnected && !el.closest('[inert]') && (el as HTMLElement & { checkVisibility?: () => boolean }).checkVisibility?.() !== false
  const onOutside = (e: Event): void => {
    const t = e.target as Node | null
    if (menu && t && (menu.contains(t) || btns.get('more')?.contains(t))) return
    closeMenu()
  }
  const onEsc = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || !menu) return
    e.preventDefault()
    e.stopPropagation()
    const focused = menu.contains(document.activeElement)
    closeMenu()
    if (focused) btns.get('more')?.focus() // 键盘进去的,Esc 回到 ⋯
  }
  // 画布平移 / 缩放(触控板、滚轮、Mod+滚轮)走的是 transform,不触发 scroll:fixed 的菜单会留在原处 —— 滚轮一动就收起
  const onWheel = (e: WheelEvent): void => {
    if (menu && !menu.contains(e.target as Node | null)) closeMenu()
  }
  function closeMenu(): void {
    if (!menu) return
    stopFollow?.()
    stopFollow = null
    menu.remove()
    menu = null
    host.removeAttribute('data-tb-menu')
    btns.get('more')?.setAttribute('aria-expanded', 'false')
    document.removeEventListener('pointerdown', onOutside, true)
    document.removeEventListener('keydown', onEsc, true)
  }
  function openMenu(keyboard = false): void {
    const m = document.createElement('div')
    m.className = `ctx-menu amx-img-more amx-img-more--${variant}`
    m.setAttribute('role', 'menu')
    m.contentEditable = 'false'
    shield(m)
    const item = (key: 'copy' | 'delete', icon: string, run: () => void, danger = false): void => {
      const b = document.createElement('button')
      b.type = 'button'
      b.setAttribute('role', 'menuitem')
      b.dataset.act = key
      if (danger) b.className = 'danger'
      b.innerHTML = icon
      b.append(translate(key === 'copy' ? 'imgtb.copy' : 'imgtb.delete'))
      b.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        closeMenu()
        if (live()) run()
      })
      m.appendChild(b)
    }
    if (a.copy) item('copy', ICON.copy, () => a.copy!())
    if (a.view.editable) item('delete', ICON.trash, () => a.remove(), true)
    if (!m.childElementCount) return
    if (variant === 'hover') {
      // 挂到 body、fixed 贴在工具条下沿、右缘对齐(followAnchor:下面放不下翻到上面,恒在窗口里)。
      // 不挂在图片包裹层里:画布卡片是 overflow:auto,图矮 / 在卡片底部时菜单整个被裁掉、点不到(11-18 画布台架实测)。
      // 跟着的三件:落位(followAnchor)、工具条被藏起就收(ResizeObserver:藏起 = 尺寸归零)、滚轮收起(画布平移 / 缩放)。
      document.body.appendChild(m)
      const stop = followAnchor(m, el, { alignEnd: true })
      const ro = new ResizeObserver(() => { if (!live()) closeMenu() })
      ro.observe(el)
      document.addEventListener('wheel', onWheel, { capture: true, passive: true })
      stopFollow = () => {
        stop()
        ro.disconnect()
        document.removeEventListener('wheel', onWheel, { capture: true })
      }
    } else host.insertBefore(m, host.firstChild) // sheet:排在工具条上方
    menu = m
    host.setAttribute('data-tb-menu', '')
    btns.get('more')?.setAttribute('aria-expanded', 'true')
    document.addEventListener('pointerdown', onOutside, true)
    document.addEventListener('keydown', onEsc, true)
    if (keyboard) m.querySelector<HTMLButtonElement>('button')?.focus()
  }

  function run(act: Act): void {
    const al = ALIGN_OF[act]
    if (al) {
      if (variant === 'hover') holdToolbar(host)
      return a.setAlign(al)
    }
    if (act === 'more') return menu ? closeMenu() : openMenu()
    closeMenu()
    if (act === 'caption') a.caption?.()
    else if (act === 'replace') a.replace?.()
    else if (act === 'fullscreen') a.fullscreen()
    else if (act === 'download') a.download()
    else if (act === 'source') a.source()
  }

  const TITLES: Record<Act, string> = {
    alignLeft: 'imgtb.alignLeft', alignCenter: 'imgtb.alignCenter', alignRight: 'imgtb.alignRight', caption: 'imgtb.caption',
    replace: 'imgtb.replace', open: 'imgtb.open', fullscreen: 'imgtb.fullscreen', download: 'imgtb.download', source: 'imgtb.source', more: 'imgtb.more',
  }
  function refresh(): void {
    const editable = a.view.editable
    el.setAttribute('aria-label', translate('imgtb.label'))
    const cur = a.align()
    for (const [act, b] of btns) {
      const label = translate(TITLES[act])
      // 「打开」的悬停提示多一行 ⌘/Ctrl+点击;读屏只读「打开」
      const tip = act === 'open' ? `${label}\n${translate('imgtb.openHint')}` : label
      if (b.title !== tip) {
        b.title = tip
        b.setAttribute('aria-label', label)
      }
      b.hidden = EDITS.has(act) && !editable
      const al = ALIGN_OF[act]
      const pressed = al ? cur === al : act === 'caption' ? !!a.captionOpen?.() : null
      if (pressed != null && b.getAttribute('aria-pressed') !== String(pressed)) b.setAttribute('aria-pressed', String(pressed))
    }
    if (!btns.has('more')) return
    // ⋯ 里只剩「删除」时只读下没东西可放:整颗收起
    btns.get('more')!.hidden = !a.copy && !editable
    // 分隔线:两侧都有露出的键才画
    const vis = groups.map((g) => g.some((act) => btns.get(act) && !btns.get(act)!.hidden))
    seps.forEach((s, i) => { s.hidden = !(vis.slice(0, i + 1).some(Boolean) && vis[i + 1]) })
  }

  // 切语言:露着的这一条当场换文案(没露着的下次悬停 refresh 时也会换)。
  const unsub = subscribeLocale(() => { if (el.isConnected) refresh() })
  return {
    el,
    refresh,
    closeMenu,
    menuOpen: () => !!menu,
    destroy: () => { unsub(); closeMenu(); releaseToolbarHold(host); el.remove() },
  }
}

/** 点了对齐:悬停工具条「钉住」到下一次指针移动。段落换了 attrs,PM 会把图片挪进新的段落元素(recreateWrapper),
 *  Chromium 在指针动之前不给挪过的元素算 :hover —— 不钉住,点完一下工具条就消失了(指针明明还在它上面)。 */
const holds = new WeakMap<HTMLElement, () => void>()
export function holdToolbar(host: HTMLElement): void {
  releaseToolbarHold(host) // 同一宿主只挂一个监听
  const release = (): void => releaseToolbarHold(host)
  host.setAttribute('data-tb-hold', '')
  document.addEventListener('pointermove', release, true)
  holds.set(host, () => {
    document.removeEventListener('pointermove', release, true)
    host.removeAttribute('data-tb-hold')
  })
}
/** 解除钉住(指针动了 / 工具条销毁)。document 上的监听一并摘掉:纯键盘关笔记时不留着旧编辑器的引用。 */
export function releaseToolbarHold(host: HTMLElement): void {
  const off = holds.get(host)
  if (!off) return
  holds.delete(host)
  off()
}
/** 这个宿主此刻还钉着吗(派完事务的下一帧用:指针要是已经动过,就别再钉回去)。 */
export const toolbarHeld = (host: HTMLElement): boolean => holds.has(host)

/** 悬停工具条摆在哪(两种形态共用,露出前调):
 *   · 图够宽 → 图片右上角里面(CSS 缺省);
 *   · 图比工具条窄 → 挪到图片上方,按段落对齐靠左 / 居中 / 靠右(`data-tb-out`);
 *   · 窄,但上方没地方(被最近的裁切容器裁掉:画布卡片是 overflow:auto,图在卡顶时工具条上半截被裁、点击落到舞台上 ——
 *     11-18 台架实测)→ 叠在图片顶上,同样按对齐靠边(`data-tb-over`)。
 *  加载失败的图 `<img>` 藏着(宽 0),量包裹层(露出的是「图片无法加载」占位)。 */
export function placeHoverToolbar(wrap: HTMLElement, img: HTMLElement, tb: HTMLElement, align: TextAlignment): void {
  // 上一次收进可见区留下的推移 / 封顶先撤掉:下面按工具条的自然宽判摆法(Codex 评审 P1:封顶留着会判错摆法、再叠一次推移)
  tb.style.removeProperty('--amx-tb-dx')
  tb.style.maxWidth = ''
  const shown = img.offsetWidth ? img : wrap
  const clip = clipBox(wrap)
  let mode: 'out' | 'over' | null = null
  if (shown.offsetWidth < tb.offsetWidth + 16) {
    // 裁切层(与视口)可视区的上沿取最低的那条:卡片自己有地方、外层舞台没有,一样会被裁掉
    mode = shown.getBoundingClientRect().top - clip.top >= tb.getBoundingClientRect().height + 6 ? 'out' : 'over'
  }
  if (mode === 'out') wrap.setAttribute('data-tb-out', align)
  else wrap.removeAttribute('data-tb-out')
  if (mode === 'over') wrap.setAttribute('data-tb-over', align)
  else wrap.removeAttribute('data-tb-over')
  nudgeIntoView(tb, clip)
}

/** 真会裁到这张图的那几层与窗口求交(视口 px)。沿**包含块链**走:绝对定位的画布卡片跳过它和定位祖先之间的静态元素 ——
 *  编辑器 .ProseMirror 是 overflow:auto,可画布卡片不在它的裁切范围里(只按「和图片相交」判,主卡与别的卡重叠时会误算,Codex 评审 P2)。 */
function clipBox(wrap: HTMLElement): { left: number; top: number; right: number } {
  let left = 0
  let top = 0
  let right = document.documentElement.clientWidth
  const own = getComputedStyle(wrap).position
  // 往上找的是谁:absolute 找最近的定位祖先,fixed 找最近的 transform / filter / contain 祖先(都没有就是视口)
  let need: 'positioned' | 'fixedCb' | null = own === 'absolute' ? 'positioned' : own === 'fixed' ? 'fixedCb' : null
  for (let el = wrap.parentElement; el && el !== document.body; el = el.parentElement) {
    const cs = getComputedStyle(el)
    const on = (v: string | undefined): boolean => !!v && v !== 'none'
    const fixedCb = on(cs.transform) || on(cs.filter) || on(cs.backdropFilter) || on(cs.perspective)
      || /paint|layout|strict|content/.test(cs.contain || '') || (cs.willChange || '').includes('transform')
    if (need === 'fixedCb' && !fixedCb) continue
    if (need === 'positioned' && cs.position === 'static' && !fixedCb) continue
    need = cs.position === 'absolute' ? 'positioned' : cs.position === 'fixed' ? 'fixedCb' : null
    if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue
    const b = el.getBoundingClientRect()
    if (cs.overflowX !== 'visible') {
      left = Math.max(left, b.left)
      right = Math.min(right, b.right)
    }
    if (cs.overflowY !== 'visible') top = Math.max(top, b.top)
  }
  return { left, top, right }
}

/** 工具条横向收进看得见的地方(11-18:画布里贴窗口右缘的窄图,工具条从图片左缘往右伸、伸出窗口,右半截点不到)。
 *  看得见的地方 = clipBox(窗口 ∩ 真会裁到这张图的那几层;画布卡片是 overflow:auto,推出卡片一样被裁)。
 *  算术走 menuAnchor 的 edgeNudge(和 useEdgeNudge 同一份);推移写进 --amx-tb-dx,CSS 的 translate 读它 ——
 *  居中摆法自己就有 translate:-50%,不能直接覆盖 inline translate。
 *  放不下就先封顶 max-width(按钮跟着收窄)、**再量一次**才算推移:工具条多是按右缘定位的,收窄后左缘会右移,
 *  拿收窄前的左缘算推移会多推一截、把 ⋯ 推出卡片(Codex 评审 P1)。 */
function nudgeIntoView(tb: HTMLElement, clip: { left: number; right: number }): void {
  const room = clip.right - clip.left
  if (room <= 0) return
  let r = tb.getBoundingClientRect()
  if (!r.width || !tb.offsetWidth) return
  const scale = r.width / tb.offsetWidth // 视口 px / 局部 px:界面缩放 × 画布 scale
  const cap = edgeNudge(r.left - clip.left, r.width, room, scale).maxWidth
  if (cap !== undefined) {
    tb.style.maxWidth = `${cap}px`
    r = tb.getBoundingClientRect()
  }
  const { dx } = edgeNudge(r.left - clip.left, r.width, room, scale)
  if (dx) tb.style.setProperty('--amx-tb-dx', `${dx}px`)
}

/** 两种形态共用的几样动作(mdImage.ts / wikiImageToolbar.ts)。 */
export function imageToast(key: string, error = false): void {
  window.dispatchEvent(new CustomEvent('amadeus:toast', { detail: { text: translate(key), error } }))
}

/** 下载用的文件名:库内图取库内路径末段;外链取地址末段;都取不到给 image.png。`ref` 可以是显示 URL,也可以是 `![[…]]` 里的库内路径。 */
export function imageDownloadName(ref: string): string {
  const rel = fromAssetUrl(ref)
  let tail = (rel ?? ref).split(/[?#]/)[0].split('/').pop() ?? ''
  try { tail = decodeURIComponent(tail) } catch { /* 留原样 */ }
  return !tail || /^data:|^blob:/i.test(ref) || !/\.[a-z0-9]{2,5}$/i.test(tail) ? 'image.png' : tail
}

/** 「下载」:走全应用的下载出口 saveResponseAs(桌面 / 网页 `<a download>`,安卓原生「存到下载」)。 */
export async function downloadImage(img: HTMLImageElement, ref: string): Promise<void> {
  const src = img.currentSrc || img.src
  if (!src) return
  try {
    const r = await fetch(src)
    if (!r.ok) throw new Error(String(r.status))
    const { saveResponseAs } = await import('../../../services/nativeDownload')
    await saveResponseAs(imageDownloadName(ref || src), r)
  } catch {
    imageToast('imgtb.downloadFailed', true)
  }
}

/** 「全屏」= 双击看大图那个查看器。加载失败的图不开。 */
export function viewImageFullscreen(img: HTMLImageElement, wrap: HTMLElement): void {
  if (!(img.currentSrc || img.src) || wrap.hasAttribute('data-broken')) return
  void import('../../../components/ImageViewer').then((m) => m.openImageViewer(img)).catch(() => {})
}

/** 粗指针?(与 touch.ts 同口径;这里不 import 它,免得 blocks/markdown 再挂一条依赖)。 */
export function coarsePointer(): boolean {
  try { return window.matchMedia('(pointer: coarse)').matches } catch { return false }
}

/** 手机 / 平板:贴底那一条。只同时开一条(选中别的图 = 换一条)。 */
let openSheet: { close(): void } | null = null
export function openImageSheet(build: (host: HTMLElement) => ImageToolbar): { close(): void; refresh(): void } {
  openSheet?.close()
  const host = document.createElement('div')
  host.className = 'amx-img-sheet'
  const tb = build(host)
  host.appendChild(tb.el)
  document.body.appendChild(host)
  tb.refresh()
  // 摆位:有移动端编辑胶囊(.amx-mbar,它自己会贴着键盘上沿)就坐在它上面;没有就贴底,
  // 键盘弹起(浏览器只压 visual viewport)时顶到键盘上沿。量到的是视口 px,元素在 body zoom 里要反补偿。
  const vv = window.visualViewport
  const place = (): void => {
    const z = (document.body as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom || 1
    const bar = document.querySelector<HTMLElement>('.amx-mbar')?.getBoundingClientRect()
    if (bar && bar.height > 0) {
      host.style.bottom = `${Math.round((window.innerHeight - bar.top) / z + 8)}px`
      host.style.transform = ''
      return
    }
    host.style.bottom = ''
    const gap = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0
    host.style.transform = gap > 1 ? `translateY(-${Math.round(gap / z)}px)` : ''
  }
  const lift = (): void => { requestAnimationFrame(() => requestAnimationFrame(place)) } // 胶囊跟键盘那一下晚一两帧
  place()
  vv?.addEventListener('resize', lift)
  const handle = {
    close: (): void => {
      vv?.removeEventListener('resize', lift)
      tb.destroy()
      host.remove()
      if (openSheet === handle) openSheet = null
    },
    refresh: (): void => tb.refresh(),
  }
  openSheet = handle
  return handle
}
