// 模板 frontmatter 并进目标笔记(G4-09,评审 2026-09-27;对标 Obsidian 插模板合并属性)。纯函数,amadeusTemplates 用。
// 此前插模板只插正文,模板自带的 fm(tags / type / 自定义属性)整段丢弃。

/** 取并集的列表型键(Obsidian 插模板时合并这两个)。 */
const UNION_KEYS = new Set(['tags', 'aliases'])
const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v])
const tagKey = (x: unknown): string => String(x).replace(/^#/, '').trim().toLowerCase()

/** 模板 frontmatter 并进目标笔记的补丁:目标**已有的键不覆盖**;
 *  tags / aliases 取并集(目标原序在前,模板新增的接在后面;`#` 与大小写不计)。没有要改的 → null。导出供单测。 */
export function templateFmPatch(template: Record<string, unknown>, target: Record<string, unknown>): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(template)) {
    if (v === undefined) continue
    if (!(k in target)) {
      patch[k] = v
      continue
    }
    if (!UNION_KEYS.has(k)) continue
    const have = asList(target[k])
    const seen = new Set(have.map(tagKey))
    const add = asList(v).filter((x) => { const key = tagKey(x); if (!key || seen.has(key)) return false; seen.add(key); return true })
    if (add.length) patch[k] = [...have, ...add]
  }
  return Object.keys(patch).length ? patch : null
}
