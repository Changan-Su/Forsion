import { describe, expect, it } from 'vitest'
import { arrangeStatusItems } from './StatusBar'
import type { StatusItem } from './types'

const Noop = (): null => null
const item = (id: string, side?: 'left' | 'right'): StatusItem => ({ id, component: Noop, side })

describe('arrangeStatusItems', () => {
  it('无偏好时保持注册序', () => {
    const items = [item('a'), item('b'), item('c')]
    expect(arrangeStatusItems(items).map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })

  it('hidden 过滤', () => {
    const items = [item('a'), item('b'), item('c')]
    expect(arrangeStatusItems(items, ['b']).map((i) => i.id)).toEqual(['a', 'c'])
  })

  it('order 里出现的按序靠前,未列出的保持注册序排后', () => {
    const items = [item('a'), item('b'), item('c'), item('d')]
    expect(arrangeStatusItems(items, undefined, ['c', 'a']).map((i) => i.id)).toEqual(['c', 'a', 'b', 'd'])
  })

  it('order 含未注册 id 不影响结果;hidden 与 order 组合', () => {
    const items = [item('a'), item('b'), item('c')]
    expect(arrangeStatusItems(items, ['a'], ['ghost', 'c']).map((i) => i.id)).toEqual(['c', 'b'])
  })

  it('trailing:无自定义顺序时插件项挪到末尾,内置项保持注册序', () => {
    const items = [item('a'), item('plugin:x:1'), item('b'), item('plugin:y:2'), item('c')]
    const plugin = (i: StatusItem): boolean => i.id.startsWith('plugin:')
    expect(arrangeStatusItems(items, undefined, undefined, plugin).map((i) => i.id)).toEqual(['a', 'b', 'c', 'plugin:x:1', 'plugin:y:2'])
  })

  it('trailing:用户排过序就完全按用户的来(插件项可以排在前面)', () => {
    const items = [item('a'), item('plugin:x:1'), item('b')]
    const plugin = (i: StatusItem): boolean => i.id.startsWith('plugin:')
    expect(arrangeStatusItems(items, undefined, ['plugin:x:1', 'b'], plugin).map((i) => i.id)).toEqual(['plugin:x:1', 'b', 'a'])
  })

  it('不改动入参数组', () => {
    const items = [item('b'), item('a')]
    arrangeStatusItems(items, undefined, ['a'])
    expect(items.map((i) => i.id)).toEqual(['b', 'a'])
  })
})

describe('StatusBar 渲染:插件项分组 + 分隔', () => {
  it('trailing 与非 trailing 相邻处恰好一条 .sb-sep;不传 trailing 不画', async () => {
    const React = await import('react')
    const { createElement } = React
    // vitest 的 esbuild 按经典 JSX 编 .tsx(React.createElement),node 环境里得先挂全局 React
    ;(globalThis as unknown as { React: typeof React }).React = React
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { StatusSide, arrangeStatusItems: arrange } = await import('./StatusBar')
    const Txt = (s: string) => () => createElement('span', null, s)
    const items: StatusItem[] = [
      { id: 'core.a', side: 'right', component: Txt('A') },
      { id: 'plugin:p:x', side: 'right', component: Txt('X') },
      { id: 'core.b', side: 'right', component: Txt('B') },
    ]
    const plugin = (i: StatusItem): boolean => i.id.startsWith('plugin:')
    const html = renderToStaticMarkup(createElement(StatusSide, { list: arrange(items, undefined, undefined, plugin), trailing: plugin }))
    const order = [...html.matchAll(/data-sb-id="([^"]+)"|class="sb-sep"/g)].map((m) => m[1] ?? '|')
    expect(order).toEqual(['core.a', 'core.b', '|', 'plugin:p:x'])
    expect(renderToStaticMarkup(createElement(StatusSide, { list: items }))).not.toContain('sb-sep')
  })
})
