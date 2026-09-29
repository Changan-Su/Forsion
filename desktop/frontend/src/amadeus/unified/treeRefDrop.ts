/** 侧栏树行拖进笔记正文 → 要插的 markdown(评审 G4-05:此前 v4 笔记出现可放置的虚线框,松手什么都没发生 ——
 *  宿主只走 v3 的 `insertBlocksAfter`,而 v4 的 activePage 恒空)。v3 / v4 两条落地路由共用这一份映射:
 *  - 树行拖源对一切叶子(含图片 / PDF / .db 附件)都打 kind:'note' —— 按真实类型分流:
 *    `.md` → `[[链接]]`;非笔记 → `![[嵌入]]`(与 OS 文件拖入 importToPage 的语义一致)。
 *  - 笔记链接一律**路径限定**形态 `[[dir/Name|Name]]`:resolvePageName 对带路径名不做同名回退,重名笔记也指向
 *    唯一目标;根目录笔记只能裸名(天花板:与当前页同夹的同名笔记会优先命中,极罕见)。
 *    (画布的 refToCardMd 是裸 `[[路径]]` 卡片正文,两者用途不同,这里不跟它。)
 *  - 会话 / 工作区文件引用与笔记语义不兼容,编辑器不收。 */
import { readChatRefs } from '../../views/chat2/chatDragRef'

const isNotePath = (p: string): boolean => /\.md$/i.test(p)

export function noteWikiInner(rel: string): string {
  const link = rel.replace(/\.md$/i, '')
  const base = link.split(/[\\/]/).pop() || link
  return link === base ? link : `${link}|${base}`
}

/** drop 阶段:这次拖入的树行各自对应的一段 markdown(一行一块);不是树行拖入 → 空数组。 */
export function treeRefBlocks(dt: Pick<DataTransfer, 'getData'> | null | undefined): string[] {
  return readChatRefs(dt)
    .filter((r): r is { kind: 'note'; path: string } => r.kind === 'note')
    .map((r) => (isNotePath(r.path) ? `[[${noteWikiInner(r.path)}]]` : `![[${r.path}]]`))
}
