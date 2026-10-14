/** 两级导航里「一趟」的页内历史:从列表点进主区的那一页是这一趟的起点,返回 = 回列表。
 *
 *  2026-10-13 用户实报「侧滑返回逻辑有些诡异」:列表 → 会话甲 → 回列表 → 会话乙,按返回先翻回会话甲(这一页不是从它
 *  那儿来的),再按才是列表。页内历史(navStore)是按标签记的浏览器式栈,桌面上箭头要的就是这个;手机上列表层才是
 *  「上一页」,进这一趟之前看过的页不该排在它前面。
 *
 *  做法:列表层在屏上时,每个栈只留它现在那一页;进了主区、人还没碰屏幕之前记进来的页**顶替**留下的那一页
 *  (那是点条目开出来的页),碰过之后记进来的才往上叠(那是这一趟里自己走出来的:笔记 → 链接 → 另一篇 → 返回)。
 *  留一页而不是清空:点回刚才那一条时没有东西会重新记它(会话 id、笔记路径都没变),清空的话这一趟的第一页就不在
 *  栈里,从它点链接出去再返回会直接掉回列表(Codex 评审 P2)。
 *
 *  ⚠️ 挂在两个 store 上同步做,不放进 React effect,也不只在「回到列表」那一下做:
 *     · 人停在列表上时也有东西往栈里记 —— 进 Space 时还原出来的那条会话(bootstrapEngine 的分账)晚一拍才记
 *       (台架抓到过:重进 Tangu 后点会话甲,返回翻出了会话乙);
 *     · 点条目是「先换会话、再收列表」,会话那条记录排在微任务里,比 React 提交早。
 *  ponytail: 「碰没碰过屏幕」是猜,不是页面自己报的。一页要是等到人已经碰了屏幕才记(装载很慢的笔记),它会叠在进来之前
 *  那一页上,返回先翻出那一页 —— 就是改之前的样子。要根治得让视图在进主区时报「我现在显示的是哪一页」。
 *  桌面 / 网页 / 手机浏览器没有列表层(listFirstNow 恒 false),这里什么都不做。仪器:listTrips.test.ts、
 *  mobile `emu:nativeshell` 的「back:」那条。 */
import { useNav } from './navStore'
import { useWorkspace } from './singleColumnStore'
import { listFirstNow } from './listFirst'

/** 栈里留着的那一页是进这一趟之前的:列表层在屏上起为真,进主区后人碰了屏幕为假。 */
let inherited = false
const atList = (): boolean => useWorkspace.getState().leftVisible && listFirstNow()

function settle(): void {
  if (atList()) inherited = true
  if (!inherited) return
  const { stacks } = useNav.getState()
  let next: typeof stacks | null = null
  for (const id in stacks) {
    const st = stacks[id]
    if (st.entries.length > 1) (next ??= { ...stacks })[id] = { entries: [st.entries[st.idx]], idx: 0 }
  }
  if (next) useNav.setState({ stacks: next })
}

/** 人碰了屏幕(或按了键):不在列表层的话,从这儿往后记下的页是这一趟里走出来的。 */
export function touchedPage(): void {
  if (!atList()) inherited = false
}

/** 手机单列壳装一次(SingleColumnHost 模块作用域)。返回值卸掉监听,测试用。 */
export function installListTrips(): () => void {
  const offs = [useWorkspace.subscribe(settle), useNav.subscribe(settle)]
  if (typeof window !== 'undefined') {
    for (const ev of ['pointerdown', 'keydown'] as const) {
      window.addEventListener(ev, touchedPage, true)
      offs.push(() => window.removeEventListener(ev, touchedPage, true))
    }
  }
  return () => { offs.forEach((off) => off()); inherited = false }
}
