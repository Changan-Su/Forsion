// 一个块是否渲染成【只读控件】(无文本光标):整块内容是 ![[...]] 嵌入(跨笔记/图片/db/画板/插件/文件)
// 或一条裸 URL(书签卡)。方向键导航据此把「进入只读块」转成「选中整块」(见 BlockHost 效应 + BlockSelectionKeys)。
// 与 BlockHost 里 embedTarget/bookmarkUrl 的判定等价(那边按解析后的具体类型分支,这里只需二元:控件 vs 文本)。
const EMBED_RE = /^!\[\[[^\]\n]+\]\]$/
const BARE_URL_RE = /^https?:\/\/\S+$/i

/** 整块是 ![[...]] 嵌入(任意子类)。回车进源码编辑只对这类有意义(书签有自己的改址入口)。 */
export function isEmbedBlock(content: string): boolean {
  return EMBED_RE.test(content.trim())
}

/** 只读控件块(嵌入 或 裸 URL 书签)= 无文本光标,方向键须「选中穿过」而非落光标。 */
export function isWidgetBlock(content: string): boolean {
  const t = content.trim()
  return EMBED_RE.test(t) || BARE_URL_RE.test(t)
}
