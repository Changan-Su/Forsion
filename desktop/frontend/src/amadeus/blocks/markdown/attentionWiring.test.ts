// @vitest-environment happy-dom
//
// 这一条不测编码逻辑,只测**装配链**:`.use(attentionSerializer)` 的 `ctx.update` 到底赶不赶得上
// milkdown `init` 烘焙 remark 处理器的那一刻(它在 `await ctx.waitTimers(initTimerCtx)` 之后
// 才 `ctx.get(remarkStringifyOptionsCtx)`)。这一环此前全靠读源码推理 —— 而同类接缝今天已经
// 推错过两次(扩展 vs options.handlers 的优先级、裸 remark-stringify vs milkdown 管线),
// 所以起一个**真的 Editor**,从 serializerCtx 拿真的落盘结果。
import { describe, expect, it } from 'vitest'
import { Editor, defaultValueCtx, rootCtx, serializerCtx, editorViewCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { attentionSerializer } from './attentionFlanking'

/** 起一个真编辑器,把 initial 灌进去再原样序列化出来。 */
const boot = async (initial: string, withFix: boolean): Promise<string> => {
  const root = document.createElement('div')
  document.body.appendChild(root)
  let editor = Editor.make().config((ctx) => {
    ctx.set(rootCtx, root)
    ctx.set(defaultValueCtx, initial)
  })
  editor = editor.use(commonmark).use(gfm)
  if (withFix) editor = editor.use(attentionSerializer) // ← UnifiedSpike 里那一行
  const ed = await editor.create()
  const md = ed.action((ctx) => ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc))
  await ed.destroy()
  root.remove()
  return md.trim()
}

// 喂进去的必须是**能解析成 mark** 的写法 —— `**abc **` 本身就不成立(那正是 bug),
// 所以用字符引用写尾随空格,它解析后就是「加粗 + 尾巴带一个空格」的真文档。
// 两条选材约束,都是踩出来的:
//  · 放**句尾**:后面跟汉字的话闭合定界符前是 `;` 后是汉字,按 flanking 本来就不成立,
//    喂进去连 mark 都解析不出来。
//  · 用 **NBSP** 不用 ASCII 空格:ProseMirror 解析时会把 mark 里的尾随 ASCII 空格吃掉,
//    喂什么都测不到。用户实报那条本来就是输入法打的 U+00A0 —— 正因为它不被 trim,
//    才能一路烂到磁盘上。
const BOLD = '**abc&#xA0;**'
const STRIKE = '~~abc&#xA0;~~'
const NBSP = '\u00A0'

describe('装配链:.use(attentionSerializer) 真的赶在 init 烘焙处理器之前', () => {
  it('挂了 → 加粗原样往返(说明 ctx.update 赶上了)', async () => {
    expect(await boot(BOLD, true)).toBe('**abc&#xA0;**')
  }, 30000)

  it('没挂 → milkdown 自带 handler 把它写成自毁形态 `**abc<NBSP>**`', async () => {
    expect(await boot(BOLD, false)).toBe(`**abc${NBSP}**`)
  }, 30000)

  it('删除线同一条链上一起生效', async () => {
    expect(await boot(STRIKE, true)).toBe('~~abc&#xA0;~~')
  }, 30000)

  it('删除线没挂时同样自毁(gfm 上游一条编码都不做)', async () => {
    expect(await boot(STRIKE, false)).toBe(`~~abc${NBSP}~~`)
  }, 30000)
})
