/** 手机的 Dock 五格(方向 E 第 1 步,2026-11-19):主页 · 对话 · 笔记 · 应用 · 我,固定、不能改。
 *
 *  「手机」= 宿主画 Dock × 竖屏单列(SingleColumnHost 的 phoneNow;手机浏览器里的网页版也算)。平板 / 手机横过来的
 *  左侧竖条照旧列全部 Space,桌面不动。
 *  - 主页 / 对话 / 笔记 = 三个 Space(第一个 Space、tangu、amadeus);对话那格换成「对话」的名字和图标。
 *  - 应用 / 我 不是 Space,是外壳盖在第一层上的两整页:页面由平台装进来(installPhonePages,mobile/src/phonePages.tsx),
 *    没人装就退回原来的 Dock(你固定的 Space + 全部)。原来住在「全部」半屏和头像菜单里的东西分到这两页(moreSheet.ts)。
 *  - 线上协议不加字段:五格照旧走 `spaces`,五个都 pinned、不超过 DOCK_CELLS —— 不认这套的旧安装包画出来也是这五格,
 *    只是图标要宿主给(glyph 由 JS 解析成图标再发)。
 *  选中哪格:开着的那一页;否则看活动 Space —— 主页 / 对话 / 笔记各归各格,别的 Space(从「应用」进去的)算「应用」。 */
import { useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import { create } from 'zustand'
import { CircleUserRound, LayoutGrid, MessageSquare } from 'lucide-react'
import type { NativeChromeSpace, PhoneGlyph } from './nativeChrome'

export type PhonePage = 'apps' | 'me'
/** 两格的 id:不是 Space 的 id(Space 的 id 不带 @),Dock 的点按 / 长按据此分开。 */
export const PHONE_APPS = '@apps'
export const PHONE_ME = '@me'
/** 对话 / 笔记两格对应的 Space。 */
export const PHONE_CHATS_SPACE = 'tangu'
export const PHONE_NOTES_SPACE = 'amadeus'
export const phonePageOfCell = (id: string): PhonePage | null => (id === PHONE_APPS ? 'apps' : id === PHONE_ME ? 'me' : null)

export const PHONE_GLYPHS: Record<PhoneGlyph, ComponentType<{ size?: number }>> = { chats: MessageSquare, apps: LayoutGrid, me: CircleUserRound }

// ── 平台装进来的两页 ────────────────────────────────────────────────────────────
type PhonePagesRenderer = (page: PhonePage) => ReactNode
let renderer: PhonePagesRenderer | null = null
const rendererSubs = new Set<() => void>()
const subscribeRenderer = (fn: () => void): (() => void) => { rendererSubs.add(fn); return () => { rendererSubs.delete(fn) } }
/** 平台画「应用」「我」两页(只调一次,mobileEntry)。装了才有五格 Dock。返回值卸掉(测试用)。 */
export function installPhonePages(render: PhonePagesRenderer): () => void {
  renderer = render
  rendererSubs.forEach((fn) => fn())
  return () => {
    if (renderer !== render) return
    renderer = null
    usePhonePage.setState({ page: null })
    rendererSubs.forEach((fn) => fn())
  }
}
export const phonePagesInstalled = (): boolean => !!renderer
export function usePhonePagesRenderer(): PhonePagesRenderer | null {
  return useSyncExternalStore(subscribeRenderer, () => renderer, () => null)
}
export { subscribeRenderer as subscribePhonePagesInstalled }

// ── 开着哪一页 ─────────────────────────────────────────────────────────────────
/** 只在内存:冷启动照旧落在「打开应用时进入」那个 Space,不会落在「应用」「我」上。系统返回(MobileRoot planBack)、
 *  浏览器返回的订阅都读这里,所以不放组件状态。 */
export const usePhonePage = create<{ page: PhonePage | null }>(() => ({ page: null }))
export const phonePageNow = (): PhonePage | null => usePhonePage.getState().page
export function openPhonePage(page: PhonePage): void {
  if (!renderer || usePhonePage.getState().page === page) return
  usePhonePage.setState({ page })
}
export function closePhonePage(): void {
  if (usePhonePage.getState().page) usePhonePage.setState({ page: null })
}

// ── 五格 ───────────────────────────────────────────────────────────────────────
export interface PhoneDockLabels { chats: string; apps: string; me: string }
export interface PhoneDockNotices { apps?: string | null; me?: string | null }
/** 五格的数据(Space 不在就少那一格;应用、我恒在)。`spaces` = 全部 Space,列表顺序,label 已翻译。 */
export function phoneDockCells(
  spaces: ReadonlyArray<{ id: string; label: string; iconRev?: number }>, activeSpaceId: string, page: PhonePage | null,
  labels: PhoneDockLabels, notices: PhoneDockNotices = {},
): NativeChromeSpace[] {
  const home = spaces[0]
  const chats = spaces.find((s) => s.id === PHONE_CHATS_SPACE && s !== home)
  const notes = spaces.find((s) => s.id === PHONE_NOTES_SPACE && s !== home)
  const known = spaces.some((s) => s.id === activeSpaceId)
  const on = page === 'apps' ? PHONE_APPS : page === 'me' ? PHONE_ME
    : !known || activeSpaceId === home?.id ? home?.id
      : activeSpaceId === chats?.id || activeSpaceId === notes?.id ? activeSpaceId : PHONE_APPS
  const cell = (id: string, label: string, extra: Partial<NativeChromeSpace> = {}): NativeChromeSpace => ({ id, label, active: id === on, pinned: true, ...extra })
  const rev = (s: { iconRev?: number }): Partial<NativeChromeSpace> => (s.iconRev ? { iconRev: s.iconRev } : {})
  return [
    ...(home ? [cell(home.id, home.label, rev(home))] : []),
    ...(chats ? [cell(chats.id, labels.chats, { glyph: 'chats' })] : []),
    ...(notes ? [cell(notes.id, notes.label, rev(notes))] : []),
    cell(PHONE_APPS, labels.apps, { glyph: 'apps', ...(notices.apps != null ? { notice: { label: notices.apps } } : {}) }),
    cell(PHONE_ME, labels.me, { glyph: 'me', ...(notices.me != null ? { notice: { label: notices.me } } : {}) }),
  ]
}
/** 「应用」页里列的 Space = Dock 上那三格以外的全部(列表顺序)。 */
export function phoneAppsSpaceIds(ids: readonly string[]): string[] {
  return ids.filter((id, i) => i !== 0 && id !== PHONE_CHATS_SPACE && id !== PHONE_NOTES_SPACE)
}

// ── 「应用」页第一排「常用」 ─────────────────────────────────────────────────────
/** 一排四个。 */
export const FREQUENT_MAX = 4
const FREQUENT_KEY = 'lcl_apps_frequent_v1'
/** 没选过、也没有旧选择可接时的「常用」开头(其余按 Space 顺序补满一排)。 */
const FREQUENT_DEFAULT = ['calendar', 'inbox']
const frequentSubs = new Set<() => void>()
export function subscribeFrequent(fn: () => void): () => void { frequentSubs.add(fn); return () => { frequentSubs.delete(fn) } }
/** 在「选择常用」里存过的(Space id);null = 没选过。读失败也是 null:不当成「选了空的」。 */
export function storedFrequent(): string[] | null {
  try {
    const raw = JSON.parse(localStorage.getItem(FREQUENT_KEY) ?? 'null') as unknown
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : null
  } catch { return null }
}
/** 存下「选择常用」的答复(勾选清单关上时)。和现在显示的一样就不存:没选过的人继续跟着缺省 / 旧选择走。 */
export function saveFrequent(ids: readonly string[], shown: readonly string[]): void {
  if (ids.length === shown.length && ids.every((x) => shown.includes(x))) return
  try { localStorage.setItem(FREQUENT_KEY, JSON.stringify(ids.slice(0, FREQUENT_MAX))) } catch { return }
  frequentSubs.forEach((fn) => fn())
}
/** 「常用」此刻是哪几个(列表顺序;`candidates` = phoneAppsSpaceIds)。
 *  选过 → 照选的;没选过 → 接两份旧选择:Dock 上固定过的 Space(`dockPicks`,spaceDock.ts),再接主页卡片里的 Space
 *  (`homeCards`,`space:<id>` 那些;商店 / 成就这类不是 Space 的不算),去掉已在 Dock 上的、去重、最多一排;
 *  两份都没有可接的 → 日历、收件箱,再按 Space 顺序补满一排。两份旧值只读不写(横屏竖条仍按 Dock 的旧选择挑格子)。 */
export function frequentSpaceIds(candidates: readonly string[], src: { stored: string[] | null; dockPicks: string[] | null; homeCards: string[] | null }): string[] {
  const inOrder = (ids: Iterable<string>): string[] => { const set = new Set(ids); return candidates.filter((id) => set.has(id)) }
  if (src.stored) return inOrder(src.stored).slice(0, FREQUENT_MAX)
  const carried: string[] = []
  for (const id of [...(src.dockPicks ?? []), ...(src.homeCards ?? []).filter((c) => c.startsWith('space:')).map((c) => c.slice('space:'.length))]) {
    if (candidates.includes(id) && !carried.includes(id)) carried.push(id)
  }
  if (carried.length) return inOrder(carried.slice(0, FREQUENT_MAX))
  const start = FREQUENT_DEFAULT.filter((id) => candidates.includes(id))
  return inOrder([...start, ...candidates.filter((id) => !start.includes(id))].slice(0, FREQUENT_MAX))
}
