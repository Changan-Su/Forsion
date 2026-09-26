/**
 * Agent 首字兜底的取字规则(单源):选择条、Orbit 侧栏、团队组合头像、状态条、Agents 档案都走这里。
 *
 * 09-25 用户拍板:首字头像**一律中性底色**,不按 slug 上彩色 —— 同姓撞字只靠取不同的字区分:
 * 与同屏其他名字首字相同时,跳过**公共前缀**取下一个字(秦彻 → 彻、秦老大 → 老)。
 * 纯函数、按码点切(emoji / 代理对不能用 `[0]`),拉丁字母统一大写。
 */

const chars = (s: string | null | undefined): string[] => Array.from((s || '').trim())

/** 名字的第一个字(大写);空名 → '?'。 */
export function initialOf(name: string | null | undefined): string {
  const c = chars(name)[0]
  return c ? c.toUpperCase() : '?'
}

/** 一个名字的候选字(小写比较,原样大写输出):首字不与任何人撞 → 只有首字;撞了 → 最长公共前缀之后的非空白字,
 *  依次排开。名字本身就是那个前缀(「秦」vs「秦彻」)→ 无候选,只能退回首字。 */
function candidatesOf(me: string[], group: string[][]): { first: string; picks: string[]; collides: boolean } {
  const lower = me.map((c) => c.toLowerCase())
  const self = lower.join('')
  let common = 0
  for (const o of group) {
    if (!o.length || o.join('') === self || o[0] !== lower[0]) continue
    let k = 0
    while (k < lower.length && k < o.length && lower[k] === o[k]) k++
    common = Math.max(common, k)
  }
  const picks: string[] = []
  for (let i = common; common && i < me.length; i++) if (me[i].trim()) picks.push(me[i])
  return { first: me[0], picks, collides: common > 0 }
}

/**
 * 整组一起分配首字(Codex 第三轮 H1-4):逐个名字各算各的会撞 ——「Alice Adams」与「Alice Dixon」都跳过被占的 A、
 * 都落到 D。这里按**整组**算最终字形并查冲突:
 *   ① 首字不撞的、以及只能退回首字的(名字就是公共前缀),先占住各自的首字;
 *   ② 其余按名字排序后依次取第一个没人占的候选字(排序 = 与传入顺序无关,同一组在各处算出同一套字);
 *   ③ 候选都被占了才退回首字(完全同名本就分不开)。
 * 返回与 names 同序的字形数组;空名 → '?'。
 */
export function initialsFor(names: ReadonlyArray<string | null | undefined>): string[] {
  const split = names.map((n) => chars(n))
  const group = split.map((me) => me.map((c) => c.toLowerCase()))
  const out: string[] = split.map(() => '?')
  const used = new Set<string>()
  const pending: Array<{ index: number; key: string; picks: string[]; first: string }> = []
  split.forEach((me, index) => {
    if (!me.length) return
    const { first, picks, collides } = candidatesOf(me, group)
    if (!collides || !picks.length) { out[index] = first.toUpperCase(); used.add(first.toLowerCase()); return }
    pending.push({ index, key: group[index].join(''), picks, first })
  })
  pending.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index))
  const sameName = new Map<string, string>() // 完全同名的几位共用一个字(本就分不开,别让后一位白白吃掉别的字)
  for (const item of pending) {
    const shared = sameName.get(item.key)
    if (shared) { out[item.index] = shared; continue }
    const pick = item.picks.find((c) => !used.has(c.toLowerCase()))
    const glyph = (pick ?? item.first).toUpperCase()
    used.add(glyph.toLowerCase())
    sameName.set(item.key, glyph)
    out[item.index] = glyph
  }
  return out
}

/**
 * 同屏去撞字的首字。`siblings` = 同一组里的全部名字(可以含自己;不含时按「自己 + siblings」成组)。
 * 结果取自 initialsFor(整组分配),所以同一组里每个名字各自调用也拿到一套互不相撞的字。
 */
export function initialFor(name: string | null | undefined, siblings: ReadonlyArray<string | null | undefined> = []): string {
  const me = chars(name)
  if (!me.length) return '?'
  const self = me.join('').toLowerCase()
  let at = siblings.findIndex((s) => chars(s).join('').toLowerCase() === self)
  const group = at >= 0 ? siblings : [name, ...siblings]
  if (at < 0) at = 0
  return initialsFor(group)[at]
}
