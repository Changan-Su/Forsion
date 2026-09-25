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

/**
 * 同屏去撞字的首字。`siblings` = 同一组里的全部名字(可以含自己,完全同名的会被跳过 —— 同名本就分不开)。
 * 首字与任何兄弟相同 → 取与它们**最长公共前缀**之后的第一个非空白字;名字本身就是那个前缀(「秦」vs「秦彻」)→ 退回首字。
 */
export function initialFor(name: string | null | undefined, siblings: ReadonlyArray<string | null | undefined> = []): string {
  const me = chars(name)
  if (!me.length) return '?'
  const lower = me.map((c) => c.toLowerCase())
  const self = lower.join('')
  let common = 0
  for (const other of siblings) {
    const o = chars(other).map((c) => c.toLowerCase())
    if (!o.length || o[0] !== lower[0] || o.join('') === self) continue
    let k = 0
    while (k < lower.length && k < o.length && lower[k] === o[k]) k++
    common = Math.max(common, k)
  }
  if (!common) return me[0].toUpperCase()
  for (let i = common; i < me.length; i++) if (me[i].trim()) return me[i].toUpperCase()
  return me[0].toUpperCase()
}
