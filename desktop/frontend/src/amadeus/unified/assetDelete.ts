// 整块删掉一个「文件引用块」(`![[某.pdf]]` / `[名](某.png)`)之后:磁盘上那个文件怎么办。
//
// 只挂在**整块删除**的入口上(块菜单「删除」/ 块选中按 Delete·Backspace)——「手动编辑删掉
// 那几个字符」和「剪切」一律不问(用户拍板 2026-08-20:剪切是搬家不是删除)。判据是结构性的:
// 逐字符编辑压根不经过这些入口,不需要任何启发式。
//
// 块先删、再问文件(不拿弹窗卡住删除)。撤销能把块拿回来,拿不回文件 —— 与删笔记那条流程
// 同一个可恢复性故事(有回收站就进回收站)。
import type { Fragment, Node as ProseNode } from '@milkdown/kit/prose/model'
import { assetKey, assetRefs, fromAssetUrl } from '@amadeus-shared/assets'
import { amadeus } from '../api'
import { askDeleteAssets } from '../components/askDeleteAssets'

/**
 * @param page  当前笔记的 vault 相对路径
 * @param removed  被删掉那段内容的**磁盘形态** markdown
 * @param textAfter  删除之后整篇的正文(同一篇里还有别处引用 → 不问)
 */
export async function askDeleteRemovedAssets(page: string, removed: string, textAfter: string): Promise<void> {
  const refs = assetRefs(removed)
  if (!refs.length) return
  const still = new Set(assetRefs(textAfter).map(assetKey))
  const gone = refs.filter((r) => !still.has(assetKey(r)))
  if (!gone.length) return
  // 独占判据借主进程那份(别的笔记也引用的一律保留);索引里还是删除前的正文,所以本块的引用
  // 仍在其中。缺这个 IPC 的端(云端/web)一律不问 —— 不问 = 不删 = 毁档防线那一侧。
  // ponytail: 索引落后于编辑器最多一个防抖窗(800ms)。「刚把引用从 A/x.png 改成 B/x.png、
  //   立刻删块」这一瞬,独占表里还是旧那条 —— 下面的 matches 因此**带路径的引用要求路径相符**,
  //   只有裸文件名引用(Obsidian 惯例,本来就是全库按名找)才按文件名认。要彻底消除这个窗口,
  //   得让主进程按「这次删掉的 ref」现场解析并回一个规范路径(新 IPC),现在不值当。
  const exclusive = await amadeus.exclusiveAssets?.(page).catch(() => [] as string[])
  const targets = (exclusive ?? []).filter((rel) => gone.some((r) => matches(r, rel)))
  if (!targets.length) return
  if ((await askDeleteAssets(page, targets, { block: true })) !== 'with') return
  for (const rel of targets) {
    try {
      if (amadeus.trashEntry) await amadeus.trashEntry(rel)
      else await amadeus.deletePage(rel)
    } catch { /* 单个文件删不掉不该冒泡成错误 */ }
  }
}

/** 这次删掉的引用 `ref` 指的是不是 vault 里的 `rel` 这个文件。
 *  带路径的引用(`子夹/x.png`、`./x.png`)必须路径相符;裸文件名才按文件名认 —— 后者本来就是
 *  「全库按名找」的语义(与主进程 assetKey 的保守口径同源)。 */
function matches(ref: string, rel: string): boolean {
  const r = ref.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
  const target = rel.replace(/\\/g, '/').toLowerCase()
  if (!r.includes('/')) return assetKey(ref) === assetKey(rel)
  return target === r || target.endsWith(`/${r}`)
}

/** 一段文档内容里的「文本 + 链接/图片目标」,拼成够 assetRefs 认的形态(不做完整 md 序列化)。
 *  `![[x.pdf]]` 本来就是段落里的字面文本;`[名](x.png)` 的目标在 link mark 上;图片 src 在编辑器里
 *  是显示用的 amadeus-asset:// URL,这里换回 vault 相对路径。 */
export function refTextOf(content: Fragment): string {
  const parts: string[] = []
  const walk = (n: ProseNode): void => {
    if (n.isText) {
      parts.push(n.text ?? '')
      for (const m of n.marks) {
        const href = String(m.attrs?.href ?? '')
        if (m.type.name === 'link' && href) parts.push(`[](${fromAssetUrl(href) ?? href})`)
      }
      return
    }
    const src = String(n.attrs?.src ?? '')
    if (src) parts.push(`![](${fromAssetUrl(src) ?? src})`)
    n.forEach(walk)
  }
  content.forEach(walk)
  return parts.join('\n')
}
