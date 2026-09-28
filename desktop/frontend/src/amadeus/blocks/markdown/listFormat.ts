// D-05(评审 2026-09-27):任何一次编辑都把 `- a\n- b` 写成 `* a\n\n* b` —— 两个独立的病,两侧各治一处。
//
// ① 紧凑变松散。preset 的 bullet_list / list_item 解析时把 mdast 的 `spread` 存成**字符串**
//    (`${node.spread}`,即 'false'),序列化时原样交还;而 mdast-util-to-markdown 的 join
//    (lib/join.js)只认 `typeof parent.spread === 'boolean'`,字符串一律落到缺省的「空一行」——
//    于是每个列表项之间、项内段落与子列表之间全插空行。ordered_list / gfm 任务项已自己 `=== 'true'` 收成
//    布尔,所以「有序列表不受影响」。修在 stringify 的 `list` handler 入口:进 handler 前把 list 与各项的
//    spread 收成布尔(join 读的正是这两个对象),一处兜住 bullet / ordered / 任务 / 插件来的列表。
//    项的 spread 再与所属 list 取与:编辑器里新建的列表 list 缺省 false、项缺省 **true**(preset 默认),
//    原样写出去是 `* a\n\n  * b` —— 项内空行让整只列表按 CommonMark 变松散,下次打开再编辑就整篇散开
//    (台架实测 09-28)。解析来的列表恒有「项 spread ⇒ list spread」,取与对它们是恒等。
// ② `-` 变 `*`。mdast 的 list 节点**不记**列表符,序列化只有全局 `options.bullet`(缺省 `*`)。
//    拍板 #17:先「记住原标记、写回沿用」,**不改缺省值**(直接切缺省会把存量 `*` 笔记在下次编辑时整篇改写)。
//    读侧从源串按首项起点取符号印进 `data.amadeusBullet` → bullet_list 的 `bullet` attr(structuralIndent.ts)
//    → 写侧 list handler 临时把 `state.options.bullet` 换成它。嵌套的新列表(Tab 缩进出来的,attr 为空)
//    跟随外层的符号;全新的列表仍是缺省 `*`。
// ⚠️ handler 必须挂 `remarkStringifyOptionsCtx.handlers`(同 attentionFlanking.ts 顶注:options 那份恒压过 extensions)。
// 仪器:npm run check:rtcorpus(d18.list_* / d05.*)、listFormat.test.ts。
import { config, remarkStringifyOptionsCtx } from '@milkdown/kit/core'
import { $remark } from '@milkdown/kit/utils'
import { defaultHandlers } from 'mdast-util-to-markdown'

/* eslint-disable @typescript-eslint/no-explicit-any */
type MdNode = any

const BULLET_RE = /^[-*+]$/
/** 合法的无序列表符;其余一律 null(attr / DOM 进来的外来值不许夹带)。 */
export const listBullet = (v: unknown): '-' | '*' | '+' | null =>
  typeof v === 'string' && BULLET_RE.test(v) ? (v as '-' | '*' | '+') : null

/** 就地给每只无序列表印上源文里的列表符(导出供单测)。首项的 position 起点就是标记字符本身。 */
export function stampListBullets(tree: MdNode, source: string): void {
  const walk = (n: MdNode): void => {
    if (n?.type === 'list' && !n.ordered) {
      const off = n.children?.[0]?.position?.start?.offset
      const bullet = typeof off === 'number' ? listBullet(source[off]) : null
      if (bullet) n.data = { ...n.data, amadeusBullet: bullet }
    }
    for (const c of Array.isArray(n?.children) ? n.children : []) walk(c)
  }
  walk(tree)
}

export const listBulletRemark = $remark('amadeusListBullet', () => () =>
  (tree: MdNode, file: MdNode): void => stampListBullets(tree, String(file?.value ?? '')))

const toBool = (v: unknown): boolean => v === true || v === 'true'

/** stringify 的 `list` handler:spread 收布尔 + 按节点带的原列表符写(导出供单测)。 */
export function listHandler(node: MdNode, parent: MdNode, state: MdNode, info: MdNode): string {
  const spread = toBool(node.spread)
  node.spread = spread
  for (const item of Array.isArray(node.children) ? node.children : []) {
    if (item?.type === 'listItem') item.spread = toBool(item.spread) && spread
  }
  const bullet = node.ordered ? null : listBullet(node.amadeusBullet)
  if (!bullet) return defaultHandlers.list(node, parent, state, info)
  const prev = state.options.bullet
  state.options.bullet = bullet
  try {
    return defaultHandlers.list(node, parent, state, info)
  } finally {
    state.options.bullet = prev
  }
}

const listSerializer = config((ctx) => {
  ctx.update(remarkStringifyOptionsCtx, (o: any) => ({ ...o, handlers: { ...o.handlers, list: listHandler } }))
})

/** 挂进 commonmarkWithIndent(paragraphIndent.ts),与 preset 同进同出。 */
export const listFormatPlugins = [listBulletRemark, listSerializer].flat()
