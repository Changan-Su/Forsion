/** 面板的 DOM 被摘下再挂回去时,保住里面各滚动容器的位置、掐掉误重播的入场动画。
 *
 *  Dockview(renderer = onlyWhenVisible)把不显示的标签的内容元素**从文档里摘掉**,换回来时同一批节点重新入 DOM:
 *  React 树没有重挂,但每个滚动容器的 scrollTop / scrollLeft 都归零(实测 700 → 0),CSS 入场动画从头再播。
 *  用户实报(2026-10-13):「切换 tab 回来,文档内容又到顶上去了…不止是 md,pdf 等各种文件和 view 都有,
 *  看起来像是重新把这个文件打开了一遍」。视图各自按路径记的滚动记忆(笔记那套)管的是**重挂**,这条路上不会跑。
 *
 *  摘下之后再读 scrollTop 已经是 0,所以只能**平时就记**:面板根上一个捕获期 scroll 监听(scroll 不冒泡),
 *  逐容器记最后的位置;面板重新可见时写回。停在末尾的容器(对话流、日志)回到**现在的**末尾,
 *  不回到离开时的那个偏移 —— 隐藏期间内容长高了,旧偏移会把它停在半截,还会和视图自己的贴底逻辑抢。
 *
 *  ⚠️ 写回之后要让浏览器的滚动锚定歇一小会儿(HOLD_MS):挂回来那一刻的排版不一定是离开时的排版 ——
 *  摘下期间量不到尺寸,自适应高度的控件会缩成 0(笔记标题的 textarea 就是),挂回来的下一次排版才撑开。
 *  这时视口上方长高了 40px,滚动锚定「好心」把 scrollTop 加 40 去保住眼前的内容,可眼前的内容本来就偏了 40:
 *  每来回一次往下漂一截(实测 700 → 740 → 780,check:notescroll 第 5、6 条)。记下的位置对的是撑开之后的排版,
 *  锚定歇着、位置不动,排版回来就正好落在原处。 */

interface Pos { top: number; left: number; end: boolean }

export interface ScrollKeeper {
  /** 面板重新可见时调:把记下的位置写回去(没写进去的下一帧再补一次)。 */
  restore(): void
  dispose(): void
}

const HOLD_MS = 300
/** 正歇着锚定的容器 → 它原来的内联值与复原定时器(连着换两次标签时只续时间,不把 'none' 当成原值记下)。 */
const held = new Map<HTMLElement, { prev: string; timer: ReturnType<typeof setTimeout> }>()
function holdAnchoring(el: Element): void {
  if (!(el instanceof HTMLElement)) return
  const was = held.get(el)
  if (was) clearTimeout(was.timer)
  const prev = was ? was.prev : el.style.getPropertyValue('overflow-anchor')
  el.style.setProperty('overflow-anchor', 'none')
  held.set(el, { prev, timer: setTimeout(() => {
    held.delete(el)
    if (prev) el.style.setProperty('overflow-anchor', prev)
    else el.style.removeProperty('overflow-anchor')
  }, HOLD_MS) })
}

export function keepScroll(root: HTMLElement): ScrollKeeper {
  const seen = new Map<Element, Pos>()
  const onScroll = (e: Event): void => {
    const el = e.target
    // 面板摘下期间不记:那时读到的位置恒为 0,而视图自己会派发合成的 scroll(PDF 阅读器装载完那一下),记了就把位置抹掉。
    if (!(el instanceof Element) || !root.isConnected) return
    const top = el.scrollTop
    seen.set(el, { top, left: el.scrollLeft, end: top > 0 && el.scrollHeight - el.clientHeight - top < 2 })
    // 一直显示着的面板(侧栏对话)等不到 restore 来清:滚过又被删掉的容器(代码块之类)攒多了就清一遍。
    if (seen.size > 64) for (const k of seen.keys()) if (!k.isConnected) seen.delete(k)
  }
  root.addEventListener('scroll', onScroll, { capture: true, passive: true })

  /** 写回一批;返回没落位的(内容还没铺好 → 被夹回去了)及它此刻停在哪。已经不在面板里的容器顺手清掉。 */
  const write = (targets: Array<[Element, Pos]>): Array<[Element, Pos, number]> => {
    const missed: Array<[Element, Pos, number]> = []
    for (const [el, p] of targets) {
      if (!root.contains(el)) { seen.delete(el); continue }
      const top = p.end ? el.scrollHeight - el.clientHeight : p.top
      if (top > 0) holdAnchoring(el)
      if (Math.abs(el.scrollTop - top) > 1) el.scrollTop = top
      if (Math.abs(el.scrollLeft - p.left) > 1) el.scrollLeft = p.left
      if (Math.abs(el.scrollTop - top) > 1 || Math.abs(el.scrollLeft - p.left) > 1) missed.push([el, p, el.scrollTop])
    }
    return missed
  }

  let raf = 0
  return {
    restore: () => {
      // 目标取这一刻的快照:被夹住的那次写回自己也会发 scroll,把半截位置记进 seen(还可能被认成「停在末尾」)。
      const missed = write([...seen])
      if (typeof requestAnimationFrame !== 'function') return
      cancelAnimationFrame(raf)
      // 只补没落位的,而且它得还停在被夹住的那个位置上:落了位的不再碰、这一帧里被别人滚走的(视图自己跳页、
      // 定位到标题,或者用户动了)也不碰,不拿旧位置抢回去。
      raf = requestAnimationFrame(() => {
        write(missed.filter(([el, , stuck]) => Math.abs(el.scrollTop - stuck) <= 1).map(([el, p]) => [el, p]))
        settleReplayedAnimations(root)
      })
    },
    dispose: () => {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf)
      root.removeEventListener('scroll', onScroll, { capture: true })
      seen.clear()
    },
  }
}

/** 元素重新入 DOM 会让其中的 CSS 动画从头重播(各视图自己的入场效果,枚举不完)—— 按**时机**掐:
 *  把刚起头的动画直接推到终态。⚠️无限循环动画(加载转圈)必须跳过:finish() 对它们会抛,它们本来也该继续转。 */
export function settleReplayedAnimations(root: Element): void {
  const el = root as Element & { getAnimations?: (o?: { subtree?: boolean }) => Animation[] }
  for (const a of el.getAnimations?.({ subtree: true }) ?? []) {
    if (a.effect?.getTiming().iterations === Infinity) continue // 转圈之类,别掐
    if (Number(a.currentTime ?? 0) > 80) continue               // 不是这一帧刚重播的,放过
    try { a.finish() } catch { /* 有些动画不可 finish */ }
  }
}
