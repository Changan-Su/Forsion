import { afterEach, describe, expect, it } from 'vitest'
import type { Ctx } from '@milkdown/kit/ctx'
import { Plugin } from '@milkdown/kit/prose/state'
import { addEditorExtension, clearEditorExtensions, pluginEditorExtensions } from './editorExtensions'

function editorContext() {
  let plugins: Plugin[] = []
  const ctx = {
    wait: async () => {},
    update: (_key: unknown, fn: (current: Plugin[]) => Plugin[]) => { plugins = fn(plugins) },
  } as unknown as Ctx
  return { ctx, plugins: () => plugins }
}

describe('editor extension source context', () => {
  afterEach(() => clearEditorExtensions('source-context-test'))

  it('keeps each editor bound to its own live page path', async () => {
    const paths: Array<() => string | undefined> = []
    addEditorExtension('source-context-test', (pm, source) => {
      paths.push(source.pagePath)
      return [new pm.Plugin({})]
    }, { priority: 'high' })
    let firstPath = '视频 A.md'
    const a = editorContext(), b = editorContext()
    const stopA = await pluginEditorExtensions('high', { pagePath: () => firstPath })(a.ctx)()
    const stopB = await pluginEditorExtensions('high', { pagePath: () => '视频 B.md' })(b.ctx)()
    expect(paths.map(read => read())).toEqual(['视频 A.md', '视频 B.md'])
    firstPath = '重命名 A.md'
    expect(paths.map(read => read())).toEqual(['重命名 A.md', '视频 B.md'])
    expect(a.plugins()[0]).not.toBe(b.plugins()[0])
    if (typeof stopA === 'function') stopA()
    expect(a.plugins()).toHaveLength(0)
    expect(b.plugins()).toHaveLength(1)
    if (typeof stopB === 'function') stopB()
  })

  it('still accepts legacy one-argument factories and absent source paths', async () => {
    addEditorExtension('source-context-test', pm => [new pm.Plugin({})])
    const editor = editorContext()
    const stop = await pluginEditorExtensions()(editor.ctx)()
    expect(editor.plugins()).toHaveLength(1)
    if (typeof stop === 'function') stop()
  })
})
