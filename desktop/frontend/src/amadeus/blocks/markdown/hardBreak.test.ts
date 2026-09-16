// @vitest-environment happy-dom
//
// 收件箱的「一个 `\n` 就是一行」。不测纯函数,起**真的 Milkdown 编辑器**看渲染出来的 DOM ——
// 病灶本来就在 preset 内部(remark-line-break 造 break{isInline:true} → hardbreak schema 的 toDOM
// 给的是 `<span> </span>` 而不是 `<br>`),纸面推理看不见,改 preset 版本也可能悄悄变。
import { describe, expect, it } from 'vitest'
import { Editor, defaultValueCtx, rootCtx, editorViewCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { hardBreakRemark } from './softBreak'

/** 起一个真编辑器,返回正文的 HTML。withFix = UnifiedPage 在 hardBreaks 打开时多挂的那一个插件。 */
const render = async (initial: string, withFix: boolean): Promise<string> => {
  const root = document.createElement('div')
  document.body.appendChild(root)
  let editor = Editor.make().config((ctx) => {
    ctx.set(rootCtx, root)
    ctx.set(defaultValueCtx, initial)
  })
  editor = editor.use(commonmark).use(gfm)
  if (withFix) editor = editor.use(hardBreakRemark)
  const ed = await editor.create()
  const html = ed.action((ctx) => ctx.get(editorViewCtx).dom.innerHTML)
  await ed.destroy()
  root.remove()
  return html
}

describe('收件箱正文:单个换行', () => {
  // 负对照 —— 这条**必须**是「不挂就不换行」,它证明上一条不是白测的。
  it('不挂插件:软换行被渲染成空格(CommonMark 本来的语义,笔记与分享页保持这样)', async () => {
    const html = await render('第一行\n第二行', false)
    expect(html).not.toContain('<br')
    expect(html).toContain('data-is-inline="true"')
  })

  it('挂上插件:软换行变成真正的 <br>', async () => {
    const html = await render('第一行\n第二行', true)
    expect(html).toContain('<br')
    expect(html).not.toContain('data-is-inline="true"')
  })

  it('不碰段落与硬换行:空行仍分段,行尾两空格仍是换行', async () => {
    const paras = await render('第一段\n\n第二段', true)
    expect((paras.match(/<p/g) || []).length).toBe(2)
    expect(await render('第一行  \n第二行', true)).toContain('<br')
  })
})
