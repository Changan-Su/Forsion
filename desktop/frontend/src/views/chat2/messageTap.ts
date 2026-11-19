/**
 * 手机的对话页:点一下气泡 / 回答的正文,这条消息的时间和那排按钮出来;再点一下、或点别处,收回去
 * (写在消息根上的 `data-tapped`,样式在 chat2.css 文末「手机:对话页少写几样」;哪些平时不写见 messageQuiet.ts)。
 *
 * 整个文档只挂一组监听,翻的是被点那条消息自己的属性 —— 不经 React:一次点按不重画对话,长对话里也只重算那一条的样式。
 * 监听挂在 document 上(冒泡):React 的处理器先跑完,里面拦下来的点按(stopPropagation)根本到不了这里。
 * 没有宿主画 Dock 的地方(桌面、网页的抽屉形态)第一行就返回;有宿主但并排着的(平板横屏)什么都没收着,也不翻。
 */
import { nativeChromeDrawsSpaces } from '@lcl/engine'

/** 点哪儿算「点这条消息」:回答的正文、自己的气泡。工具卡、附件、名字、那排按钮都不算。 */
const ZONE = '.t2-content, .t2-user'
/** 正文里自己就有点按行为的东西:点它们不翻。认不出标签的(挂了点击的 div)靠下面的手型光标兜住。 */
const ACTS = 'a, button, input, textarea, select, label, summary, img, video, audio, canvas, iframe, [role="button"], [role="link"], [role="checkbox"], [contenteditable=""], [contenteditable="true"], [data-viewable]'

/** 点按只在这种形态里算数:有宿主画 Dock 的单列,和 chat2.css 那几条收起规则是同一个范围。 */
const PHONE = '.mb-shell[data-native-chrome]:not([data-wide])'

/** 这一下点按该翻的那条消息;不该翻 = null。 */
export function tapTarget(el: Element): HTMLElement | null {
  const zone = el.closest(ZONE)
  const msg = zone?.closest<HTMLElement>('.t2-asst, .t2-userwrap')
  if (!zone || !msg?.hasAttribute('data-quiet')) return null
  const act = el.closest(ACTS)
  if (act && zone.contains(act)) return null
  if (typeof getComputedStyle === 'function' && getComputedStyle(el).cursor === 'pointer') return null
  return msg
}

const selecting = (): boolean => { const s = typeof getSelection === 'function' ? getSelection() : null; return !!s && !s.isCollapsed }

/** 现在露着的那一条。 */
let shown: HTMLElement | null = null
/** 这一下按下时的情形:选着字(点一下是为了取消选择)、按出了长按菜单 —— 都不算点消息。 */
let held = { selecting: false, menu: false }

function onDown(): void { held = { selecting: selecting(), menu: false } }
function onMenu(): void { held.menu = true }
function onClick(e: MouseEvent): void {
  if (!nativeChromeDrawsSpaces()) return
  const el = e.target instanceof Element ? e.target : null
  if (shown && !shown.isConnected) shown = null
  // 不在单列里(转成了横屏并排):没有收着的东西可翻。原来露着的那条顺手放回去,转回竖屏时它不是展开的。
  if (!el?.closest(PHONE)) { shown?.removeAttribute('data-tapped'); shown = null; return }
  if (held.selecting || held.menu || selecting()) return
  const msg = e.defaultPrevented ? null : tapTarget(el)
  // 点在露着的那条里面、但不是正文(它那排按钮、它的工具卡):留着,按钮还要用
  if (!msg && shown?.contains(el)) return
  const next = msg && msg !== shown ? msg : null
  shown?.removeAttribute('data-tapped')
  next?.setAttribute('data-tapped', '')
  shown = next
}

if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', onDown, true)
  document.addEventListener('contextmenu', onMenu, true)
  document.addEventListener('click', onClick)
}
