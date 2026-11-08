/**
 * Ribbon 的**主位槽**(2026-08-28 用户要求):一个固定图标格,默认指向「主页」Space,右键可换成任意别的 Space。
 * 位置 = Space 区第一格,紧贴在上区之上(10-02 用户改;此前悬在两组之间的正中),见 lcl Ribbon.tsx 的 .rb-home。
 * 同时它也是「启动时进入」的一档(见 spaces.tsx 的 HOME_SLOT_SPACE)。
 *
 * ⚠️**同一个 Space 不会在条上出现两次**:被放进主位的那个 Space,它原本在上区的图标要撤走。
 * 撤法是拿 `addRibbonIcon` 的 **upsert 语义把 side 从 'top' 改成 'home'**,
 * **不是** removeRibbonIcon + 重新 add —— 后者会顺手把 id 从持久顺序与收纳夹里抹掉
 * (那是「这个 Space 真的没了」才该做的事),于是每换一次主位,用户排的序就被打乱一次:
 * 换回来的图标会掉到区末尾。改 side 则完全不碰 `order`,换来换去位置都还在。
 *
 * 谁来触发同步:`installHomeSlot()` 订阅 `useSpaceStore` —— Space 列表一变就重算一次。
 * 这样用户 Space 异步装载、内置插件启停、Space 被删,三条路都自动跟上,不必在各处补调用。
 */
import { useSpaceStore, useRibbonStore, addRibbonIcon, label, useObjectMenu } from '@lcl/engine'
import type { SpaceDefinition } from '@lcl/engine'
import { spaceRef } from './objects/space'
import { SpaceButton } from './components/SpaceButton'
import { PRODUCT } from './product'
import { registerMessages, useI18n } from './i18n'

registerMessages({
  'homeSlot.menuHead': { zh: '主位放哪个 Space', en: 'Space in the home slot' },
})

export const HOME_SLOT_KEY = 'forsion_home_slot_space'
/** 缺省主位 = 主页 Space。插件关掉 / 单品档案没有它时,由 homeSlotSpaceId 的回落链兜。 */
const DEFAULT_HOME_SLOT = 'home'

/** 用户**自己放进**主位的 Space id(可能指向一个当前没注册的 Space);没设过 = null。 */
export function homeSlotChoice(): string | null {
  try { return localStorage.getItem(HOME_SLOT_KEY) || null } catch { return null } // 隐私模式
}

/** 用户**设定**的主位 Space id:自己放的那个,没设过就是主页。 */
export function homeSlotPref(): string {
  return homeSlotChoice() ?? DEFAULT_HOME_SLOT
}

/** 主位槽**实际**指向的 Space id:设定值 → 主页 → 产品默认 → 第一个已注册的;一个都没有则 null。 */
export function homeSlotSpaceId(): string | null {
  const spaces = useSpaceStore.getState().spaces
  const has = (id: string): boolean => spaces.some((s) => s.id === id)
  for (const id of [homeSlotPref(), DEFAULT_HOME_SLOT, PRODUCT.defaultSpace]) if (id && has(id)) return id
  return spaces[0]?.id ?? null
}

export function setHomeSlotSpace(id: string): void {
  try { localStorage.setItem(HOME_SLOT_KEY, id) } catch { /* 隐私模式:本次会话生效即可 */ }
  syncHomeSlot()
}

/** 主位槽的按钮:外观复用 SpaceButton(高亮/角标/展开态全都白拿),外面套一层接右键菜单。 */
function HomeSlotButton({ space, expanded }: { space: SpaceDefinition; expanded: boolean }) {
  const { t } = useI18n()
  // 右键 = 这个 Space 的对象菜单(打开 / 在新窗口中打开 / 添加到桌面 / 删除…,和条上别的 Space 同一份,见 objects/space.tsx)
  // + 本处那一节「主位放哪个 Space」。⚠️ 必须拦下右键(useObjectMenu 有项就 preventDefault):ribbon 根节点的区菜单只在
  // `e.defaultPrevented` 时让路。菜单由共用渲染器画,不铺 scrim(ribbon 整条是拖窗区,全屏 div 会把它挡掉)。
  const menu = useObjectMenu({
    refs: [spaceRef(space.id)],
    place: { kind: 'home-slot' },
    placeSections: () => [{
      title: t('homeSlot.menuHead'),
      items: useSpaceStore.getState().spaces.map((sp) => ({
        id: `slot:${sp.id}`,
        label: label(sp.name),
        icon: sp.icon ? <sp.icon size={13} /> : <span style={{ width: 13 }} />,
        checked: sp.id === space.id,
        run: () => setHomeSlotSpace(sp.id),
      })),
    }],
  })
  return (
    <span className="rb-homeslot" onContextMenu={menu.onContextMenu}>
      <SpaceButton space={space} expanded={expanded} />
    </span>
  )
}

/** 让「主位所指的 Space」落在 home 槽、其余 Space 回上区。幂等,可随便多调。 */
export function syncHomeSlot(): void {
  const cur = homeSlotSpaceId()
  const items = useRibbonStore.getState().items
  for (const sp of useSpaceStore.getState().spaces) {
    const id = `space:${sp.id}`
    const side = sp.id === cur ? 'home' : 'top'
    const it = items.find((i) => i.id === id)
    if (!it || it.side === side) continue // 没注册过的交给注册方(registerSpaces/userSpaces);已就位的不动
    addRibbonIcon({
      ...it, // 条目自带的别的东西(右键项 menu…)跟着走:只换 side 与外壳
      side,
      component: side === 'home'
        ? ({ expanded }) => <HomeSlotButton space={sp} expanded={expanded} />
        : ({ expanded }) => <SpaceButton space={sp} expanded={expanded} />,
    })
  }
}

let installed = false

/** 装一次:先同步一遍,再订阅 Space 列表(用户 Space 异步装载 / 内置插件启停 / 删 Space 都会变)。 */
export function installHomeSlot(): void {
  syncHomeSlot()
  if (installed) return
  installed = true
  useSpaceStore.subscribe((s, p) => { if (s.spaces !== p.spaces) syncHomeSlot() })
}
