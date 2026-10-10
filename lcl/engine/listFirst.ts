/** 两级导航(用户拍板 2026-10-04「和微信那样」)的唯一一道闸。
 *
 *  生效 = 宿主画原生底部导航栏(Android)× 竖屏 × 当前 Space 有左栏且没退订(SpaceDefinition.listFirst)。
 *  生效时左栏整屏是这个 Space 的**第一层**(底部导航栏只在这一层),主区是点进条目后的第二层,
 *  顶栏左钮 / 系统返回 = 回列表。没有左栏或退订了的 Space(主页 / 日历…)主区就是第一层。
 *  web / 桌面手机框 / 手机浏览器没有原生宿主 → 恒 false,抽屉行为逐像素不变。 */
import { nativeChromeDrawsSpaces, useNativeChromeSpaces } from './nativeChrome'
import { getActiveSpace } from './spaceRegistry'
import { getView } from './viewRegistry'
import { useWorkspace } from './singleColumnStore'

export function listFirstNow(): boolean {
  if (!nativeChromeDrawsSpaces()) return false
  const ws = useWorkspace.getState()
  if (ws.wideMode) return false
  // 左栏得拿得出**能画**的视图,否则「第一层」就是一张白页(主区被推在屏外,只剩底栏):
  //  · leaf 在就看 leaf;桶还空着、抽屉也没开过就看缺省(首开才按缺省填,见 toggleSidebar);
  //  · 桶空着却开着 = 视图被关光了(插件自己关的);类型没注册 = 卸掉的插件留下的 leaf / 缺省。
  // 这两种不算列表层,退回抽屉形态:点遮罩回主区,再开抽屉时按缺省重填。
  const left = ws.leftLeaves.length ? ws.leftLeaves : ws.leftVisible ? [] : ws.sidebarDefaults.left
  if (!left.some((v) => v.type === '__extend' || !!getView(v.type))) return false
  return getActiveSpace()?.listFirst !== false
}

/** React: the same gate, for a view that draws differently as a Space's full-screen first level (a phone list with
 *  its own main button instead of a desktop sidebar). Follows the host arriving and the wide layout; the Space's own
 *  `listFirst` does not change while its views are mounted. */
export function useListFirst(): boolean {
  const spaces = useNativeChromeSpaces()
  const wide = useWorkspace((s) => s.wideMode)
  return spaces && !wide && listFirstNow()
}
