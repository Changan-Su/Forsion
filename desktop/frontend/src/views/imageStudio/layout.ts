import { useWorkspace } from '@lcl/engine'

/** 图像工作室的面板摆位(项目 + 详情,2026-10-04):左 = 导航(固定)+ 进项目后的「图层」;右 = 对话(固定)| 属性。
 *  只用两种工作台 store 都有的方法,桌面 Dockview 壳与单列壳同一份逻辑。 */
export const STUDIO_NAV = 'image-studio-nav'
export const STUDIO_CHAT = 'image-studio-chat'
export const STUDIO_LAYERS = 'image-studio-assets'
export const STUDIO_INSPECTOR = 'image-studio-inspector'

const has = (tabs: ReadonlyArray<{ type: string }>, type: string): boolean => tabs.some(tab => tab.type === type)

/** 把某个面板带到前面:它在的那一侧收着就先展开(暂存的整组一起回来),再点亮它。
 *  ⚠️收起的一侧不能直接 openView:那会只拿这一个面板新建组,暂存里的其余面板(含固定的对话)就此丢掉。
 *  也不用 showSideView:目标已经在前台时它会反过来把这一侧收起(双击看属性,第二次就把右栏关了)。 */
export function revealStudioPanel(type: string): void {
  const ws = useWorkspace.getState()
  if (has(ws.mainTabs, type)) { ws.openView(type, {}, 'main'); return } // 用户把它拖进了主区:就点亮那一个
  const side = has(ws.leftTabs, type) ? 'left' : has(ws.rightTabs, type) ? 'right' : type === STUDIO_LAYERS ? 'left' : 'right'
  if (!(side === 'left' ? ws.leftVisible : ws.rightVisible)) ws.toggleSidebar(side)
  useWorkspace.getState().openView(type, {}, side)
}

// 右栏的自动开合只管「进出项目」这两下,其余时候用户说了算。这几个量都只活在本次运行里:
let opened = false // 已经自动带出过右栏
let folded = false // 右栏现在收着,而且是我们回启动台时收的(不是用户)
let foldedAt = 0 // ……那一下的时刻
let inProject = false // 项目开着没有:还没做完的那次展开靠它判断该不该继续
/** 我们收起右栏之后,最多等这么久让它收完(正常 200ms;主线程忙的时候会拖长)。 */
const FOLD_WINDOW = 2000
/** 两侧是停靠的栏,还是盖在主区上的抽屉(单列壳)?抽屉不自动开合 —— 开项目时弹出来会把画布整个挡住。
 *  按 store 实判(同 pluginViews.hasBottomPanel:安卓原生构建的 UI_MODE 可能仍是 desktop)。 */
const docked = (): boolean => 'bottomVisible' in useWorkspace.getState()

/** 把右栏带出来。难处在我们自己刚收起的那一下:引擎收起一侧要补间 200ms,期间面板还在 —— 这时 toggle 会被判成
 *  「再收一次」而不是展开(dockviewStore.toggleSidebar 注明的已知局限),rightVisible 也可能已被同步回 true,
 *  两样都不能信。所以以活面板为准(syncPanelState 按它重算 rightVisible):面板撤完了再展开。
 *  等的过程中用户回了启动台就作罢,folded 留着,下次进项目再还。 */
function bringRightOut(): void {
  if (!inProject) return
  const ws = useWorkspace.getState()
  ws.syncPanelState()
  if (!useWorkspace.getState().rightVisible) ws.toggleSidebar('right') // 没有活面板 = 真收着
  else if (Date.now() - foldedAt < FOLD_WINDOW) { setTimeout(bringRightOut, 50); return } // 我们那一下还没收完
  opened = true; folded = false
}

/** 项目打开着:导航旁边要有「图层」;右栏(对话 | 属性)带出来 —— 用户在项目里亲手收起过,本次运行就不再弹。 */
export function enterProjectLayout(): void {
  const ws = useWorkspace.getState()
  inProject = true
  // 图层已经在别处(用户拖到了右栏 / 主区,或还收在暂存里)就不再开第二个。remapLeaves 全返回 undefined = 只读枚举,
  // 活面板与暂存都看得到,末尾顺带把缺了的固定项补回来(冷启动还原的布局不经 setActiveSpace)。
  let layers = false
  ws.remapLeaves(type => { if (type === STUDIO_LAYERS) layers = true; return undefined })
  if (!layers) ws.replaceViewsOfType(STUDIO_NAV, STUDIO_LAYERS) // 导航是固定的:图层开在它旁边,它留着
  if (!docked()) return
  if (opened && !folded) return // 已经带出过,而且不是我们收的:开着就开着,用户收的就收着
  bringRightOut()
}

/** 回到启动台:图层收走(收起着的左栏里暂存的那份也摘掉)。leaving = 刚从项目里出来,这时才顺手把右栏收起;
 *  挂载时就在启动台则不碰右栏 —— 用户在启动台自己展开过,重启后不该被收回去。 */
export function leaveProjectLayout(leaving: boolean): void {
  const ws = useWorkspace.getState()
  inProject = false
  ws.remapLeaves(type => (type === STUDIO_LAYERS ? null : undefined))
  if (docked() && leaving && useWorkspace.getState().rightVisible) { useWorkspace.getState().toggleSidebar('right'); folded = true; foldedAt = Date.now() }
}

/** 测试用:把本次运行的记忆清掉。 */
export function resetStudioLayoutMemory(): void { opened = false; folded = false; inProject = false; foldedAt = 0 }
