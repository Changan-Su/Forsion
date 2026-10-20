/** 换 Space 的过渡(2026-10-16 用户选 C「沿 ribbon 方向推移」;方案页 docs/ToBeImproved/Space切换动效方案_2026-10-16)。
 *  工作区整块沿切换条的轴推过去:目标在条上靠后 → 新内容从后面(下 / 右)进来、旧的往前(上 / 左)走。
 *  做法是 View Transition:浏览器给新旧两份工作区各拍一张快照来动,布局代码一行不碰;ribbon 不参与(高亮立刻跳)。
 *  关键帧在 engine.css「换 Space 的过渡」。
 *
 *  ⚠️ 只给人手发起的切换用(点 ribbon、mod+数字、悬停预览点进去、手机底栏 / 抽屉)。View Transition 的回调要等到下一帧才跑,
 *     切完立刻要在新 Space 里接着开东西的调用方(sessionNav、redirectOpenFromOnePage…)继续用同步的 setActiveSpace。
 *  ⚠️ 过渡期间 Chromium 把指针命中一律落在 <html> 上(给 ::view-transition 设 pointer-events: none 也一样,台架实测),
 *     所以过渡中一按下就跳过过渡;按在切换条(ribbon / 手机抽屉底部的 Space 条)上的那一下转给底下的按钮 ——
 *     条不参与过渡,屏上看到的就是真界面,点的是哪颗没有歧义。工作区里的那一下作废:跳过后终态立刻出来,再点一次。 */
import { flushSync } from 'react-dom'
import { useSpaceStore, setActiveSpace } from './spaceRegistry'
import { IS_MINI_PANEL, WINDOW_SPACE_ID } from './uiMode'
import { reducedMotion } from './spring'

export type SpaceSwitchMotion = 'next' | 'prev' | 'fade'

/** 切换条上 Space 的排列(自上而下 / 自左而右)。桌面由 Ribbon 每次渲染报上来;没人报(手机)按注册序。 */
let barOrder: readonly string[] = []
export function setSpaceBarOrder(ids: readonly string[]): void { barOrder = ids }

/** 往哪推:to 在条上排在 from 后面 = next。条上找不到(插件刚卸、不在条上)就按注册序比;还比不出来就当 next。 */
export function spaceSwitchDirection(order: readonly string[], registry: readonly string[], from: string, to: string): 'next' | 'prev' {
  for (const list of [order, registry]) {
    const a = list.indexOf(from), b = list.indexOf(to)
    if (a >= 0 && b >= 0) return b > a ? 'next' : 'prev'
  }
  return 'next'
}

type VT = { skipTransition(): void; ready: Promise<void>; finished: Promise<void>; updateCallbackDone: Promise<void> }
/** 每次请求 +1;回调只认最新的那次 —— 被跳过的那段回调照跑,而且可能晚于新的这段(实测同一帧连点两下落在了前一个)。 */
let seq = 0
/** 正在播的那段;属性归它收。 */
let live: VT | null = null
/** 过渡中按在 ribbon 上的那颗按钮:接下来那次落在 <html> 上的 click 转给它。 */
let retarget: HTMLElement | null = null
let wired = false
function wire(): void {
  if (wired) return
  wired = true
  const barButtonAt = (x: number, y: number): HTMLElement | null =>
    document.elementFromPoint(x, y)?.closest<HTMLElement>('.rb button, .mb-drawer-foot button') ?? null
  window.addEventListener('pointerdown', (e) => {
    retarget = null
    if (!live) return
    live.skipTransition() // 同步生效:这之后 elementFromPoint 就能命中真界面
    retarget = barButtonAt(e.clientX, e.clientY)
  }, true)
  window.addEventListener('click', (e) => {
    const el = retarget
    retarget = null
    // 松手时还在同一颗上才算(按下后拖开 = 取消);修饰键原样带过去(⌘ / Ctrl + 点 Space = 开到自己的窗口)
    if (!el || e.target !== document.documentElement || barButtonAt(e.clientX, e.clientY) !== el) return
    e.stopPropagation()
    const { clientX, clientY, screenX, screenY, button, buttons, detail, metaKey, ctrlKey, shiftKey, altKey } = e
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: window, clientX, clientY, screenX, screenY, button, buttons, detail, metaKey, ctrlKey, shiftKey, altKey }))
  }, true)
}

/** 带过渡地换到 toId。run = 真正换的那一下(缺省 setActiveSpace;手机「换完留在抽屉里」要连抽屉一起交进来)。
 *  点的就是当前这个也要经过这里(run 换成「落回这个 Space 的那一页」之类):这样才会作废还在等下一帧的上一次切换。
 *  axis:切换条的走向,桌面 ribbon 竖排('y'),手机底栏横排('x')。
 *  不该播的(同一个、没注册、迷你面板、Space 窗口、不支持 View Transition、窗口不可见、手机)直接同步跑 run。
 *  ⚠️ 手机('x')先不播(10-16 用户定「等真机量过再开」):安卓模拟器上拍快照让落地晚约 170ms、出帧掉到三分之一,
 *     真手机的 GPU 要多付多少没量过。开回来 = 删掉下面那个 axis === 'x'(横推的关键帧还在 engine.css;mobile e2e:spaceswitch 的横推断言在 git 历史里)。 */
export function switchSpace(toId: string, run: () => void = () => setActiveSpace(toId), { axis = 'y' }: { axis?: 'x' | 'y' } = {}): void {
  const mine = ++seq
  const { activeSpaceId: from, spaces } = useSpaceStore.getState()
  const doc = typeof document === 'undefined' ? null : document as Document & { startViewTransition?: (cb: () => void) => VT }
  // 窗口不可见时不出帧,回调要等到下一帧 —— 直接换(看不见也就不用播)
  if (axis === 'x' || toId === from || !spaces.some((s) => s.id === toId) || IS_MINI_PANEL || WINDOW_SPACE_ID || typeof doc?.startViewTransition !== 'function' || doc.visibilityState === 'hidden') {
    live?.skipTransition() // 还挂着的上一段(比如点了别的又点回当前这个):它的回调已因 seq 作废,别让同一份内容按推移关键帧自己抖一下
    run()
    return
  }
  wire()
  const root = doc.documentElement
  // 先挂上再开:旧快照在下一帧拍,那时工作区就得已经带着名字(engine.css 按这两个属性给它起名、选关键帧)
  root.dataset.spaceSwitch = reducedMotion() ? 'fade' : spaceSwitchDirection(barOrder, spaces.map((s) => s.id), from, toId)
  root.dataset.spaceSwitchAxis = axis
  // flushSync:换布局时 Dockview 往 React 里挂的面板要在回调返回前画完,不然新快照拍到的是空面板,推完内容才弹出来。
  // 等这一帧的工夫里别处已经同步换过 Space(通知、别的窗口发来的导航)= 这次作废,不把人从刚到的地方带走
  const vt = doc.startViewTransition(() => { if (seq === mine && useSpaceStore.getState().activeSpaceId === from) flushSync(run) })
  live = vt
  // 被下一段跳过时 ready / finished 以 AbortError 落空
  vt.ready.catch(() => {})
  vt.updateCallbackDone.catch((e) => console.error('[space] switch failed', e))
  vt.finished.catch(() => {}).finally(() => {
    if (live !== vt) return
    live = null
    delete root.dataset.spaceSwitch
    delete root.dataset.spaceSwitchAxis
  })
}
