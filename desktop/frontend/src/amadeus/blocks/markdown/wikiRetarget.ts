// 在**已闭合**的 `[[…]]` 里改目标名时,补全候选只替换「目标名」这一段(L-02,Obsidian 同款):
// 原链接的 `#锚点` / `|别名` 与收尾 `]]` 原样保留。此前按「未闭合新链接」处理,插入 `名]]`
// 却不吃掉光标后的旧尾巴 → `[[Beta]]Alpha]]`、`[[Beta]]|al]]`、`[[Beta]]]]`。
// 纯函数、无 milkdown 依赖,单测钉在 wikiRetarget.test.ts;调用方见 MarkdownBlock.pickWiki。

/**
 * @param rest      光标到收尾 `]]` 之间的原文:旧目标名的残余 + 可能的 `#锚点` / `|别名`。
 * @param linkInner 面板给出的内文:裸名,重名消歧的 `dir/Name|Name`,或「新建链接」的查询串。
 * @returns 新的链接内文(不含方括号)。光标前的查询串整段被替换,不在此处出现。
 */
export function retargetWikiInner(rest: string, linkInner: string): string {
  const cut = rest.search(/[#|]/)
  const tail = cut < 0 ? '' : rest.slice(cut) // 旧目标名的残余丢弃,锚点/别名保留
  const bar = linkInner.indexOf('|')
  const target = bar < 0 ? linkInner : linkInner.slice(0, bar)
  const alias = bar < 0 ? '' : linkInner.slice(bar)
  // 原链接自带别名 → 用户写的别名优先;没有 → 沿用候选给的消歧别名(`dir/Name|Name` 的 `|Name`)。
  return tail.includes('|') ? target + tail : target + tail + alias
}
