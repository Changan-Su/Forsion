/** 手机主页放哪几张卡片:长按任意一张卡片改(2026-10-13 用户要「在主页编辑 Space 卡片」),记在本机 —— 和 Dock 一样,
 *  手机上摆什么不关桌面的事。没改过(null)= 有近况可说的那几个 Space(见 defaultHomeCards)。存的是卡片 id(`space:<id>` / ribbon 项 id),
 *  按勾选的先后排;对不上现有 Space 的 id(插件卸了)画的时候跳过,不替用户补位。 */
const KEY = 'forsion_home_cards_v1'
/** 桌面主页的近况卡(摆法 C)另存一份:桌面和手机各摆各的。没改过 = 架子上头四个 Space。 */
export const DESKTOP_HOME_CARDS_KEY = 'forsion.homepage.cards.desktop.v1'
export const HOME_CARDS_MAX = 6

/** 读存的那份,只读不写:没存过、读不了、存的不是数组(解析不了)都是 null = 按缺省画,盘上那份原样留着。 */
export function loadHomeCards(key = KEY): string[] | null {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? 'null') as unknown
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : null
  } catch { return null }
}
export function saveHomeCards(ids: readonly string[], key = KEY): boolean {
  try { localStorage.setItem(key, JSON.stringify(ids)); return true } catch { return false }
}

/** 画哪几张:存的里头还对得上的。没改过、或一张都对不上(选的插件 Space 全卸了)= 缺省的那几张 ——
 *  一张卡片都没有就没处长按,改不回来了(存的不动,插件装回来还是原来那几张)。 */
export function shownHomeCards<T extends { id: string }>(picked: readonly string[] | null, all: readonly T[], defaults: readonly T[]): T[] {
  const mine = (picked ?? []).map((id) => all.find((c) => c.id === id)).filter((c): c is T => !!c).slice(0, HOME_CARDS_MAX)
  return mine.length ? mine : [...defaults]
}

/** 手机主页没改过时放的 Space:卡片上有一行近况可说的那几个,按这个先后。 */
export const HOME_DEFAULT_SPACES = ['tangu', 'amadeus', 'calendar', 'inbox'] as const

/** 没改过时放哪几张:上面那几个 Space 里架子上有的,按那个先后。商店、成就和插件加的入口不在缺省里,长按编辑时照样能勾上。
 *  一个都不在架子上(只装了别的 Space)= `fallback`:一张卡片都没有就没处长按。 */
export function defaultHomeCards<T extends { id: string }>(all: readonly T[], fallback: readonly T[]): T[] {
  const mine = HOME_DEFAULT_SPACES.map((id) => all.find((c) => c.id === `space:${id}`)).filter((c): c is T => !!c)
  return mine.length ? mine : [...fallback]
}
