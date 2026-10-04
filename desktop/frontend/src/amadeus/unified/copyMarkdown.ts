/** 「复制为 Markdown」(评审 C-24):⋯ 菜单 / 手机动作单把本篇的 md 正文放进剪贴板。
 *
 *  口径:**落盘正文,不含 frontmatter,不另拼 `# 标题`**。
 *   · fm 不是正文:v4 的 fm 里有 `amadeus_layout` / `amadeus_canvas` 这类结构 JSON(内部状态),属性在属性面板里;
 *     粘进聊天 / issue / 别的笔记时整块 `---` YAML 只是噪音(Notion 复制页面内容同样不带属性)。
 *   · 先把本篇待写冲洗落盘(非严格:写失败照样复制 —— pipe.body 就是编辑器此刻的正文,也就是屏幕上那份),
 *     再取实例手里的正文;没有 v4 实例(源码模式之外的边角 / 已卸载)才回落读盘 + 拆 fm。 */
import { amadeus } from '../api'
import { flushUnifiedPath, unifiedBody } from './lifecycle'
import { splitFm } from './fm'

export async function noteMarkdownBody(path: string): Promise<string | null> {
  await flushUnifiedPath(path) // 非严格:失败已在里面吞掉
  const live = unifiedBody(path)
  if (live != null) return live
  const raw = await amadeus.readTextFile(path).catch(() => null)
  return raw == null ? null : splitFm(raw).body
}
