/** 手机主页放哪几张卡片:长按任意一张卡片改(2026-10-13 用户要「在主页编辑 Space 卡片」),记在本机 —— 和 Dock 一样,
 *  手机上摆什么不关桌面的事。没改过(null)= 架子上头两个 Space + 商店、成就。存的是卡片 id(`space:<id>` / ribbon 项 id),
 *  按勾选的先后排;对不上现有 Space 的 id(插件卸了)画的时候跳过,不替用户补位。 */
const KEY = 'forsion_home_cards_v1'
export const HOME_CARDS_MAX = 6

export function loadHomeCards(): string[] | null {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as unknown
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : null
  } catch { return null }
}
export function saveHomeCards(ids: readonly string[]): boolean {
  try { localStorage.setItem(KEY, JSON.stringify(ids)); return true } catch { return false }
}

/** 画哪几张:存的里头还对得上的。没改过、或一张都对不上(选的插件 Space 全卸了)= 缺省的那几张 ——
 *  一张卡片都没有就没处长按,改不回来了(存的不动,插件装回来还是原来那几张)。 */
export function shownHomeCards<T extends { id: string }>(picked: readonly string[] | null, all: readonly T[], defaults: readonly T[]): T[] {
  const mine = (picked ?? []).map((id) => all.find((c) => c.id === id)).filter((c): c is T => !!c).slice(0, HOME_CARDS_MAX)
  return mine.length ? mine : [...defaults]
}
