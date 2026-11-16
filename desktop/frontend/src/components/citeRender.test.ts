// @vitest-environment happy-dom
/**
 * 搜索来源编号在聊天正文里的渲染:指向这一轮来源的链接带 data-cite-n(样式表用 ::after 画编号、替掉 ↗),
 * 其他链接不带;编号不是 DOM 文本 —— 复制回答 / 选区转 Markdown / 点击定位的引语都碰不到它。
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { Markdown } from './Markdown'
import { citeIndexOf } from './citeSources'
import { selectionMarkdown } from './selectionBar/selectionMarkdown'
import { useCiteHover } from './citeHover'
import type { ToolEvent } from '../../../../tangu-agent/src/contracts/clientTypes'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const A = 'https://www.hokkaido-ski.jp/niseko/beginner'
const B = 'https://www.rusutsu-resort.com/winter/lessons'
const OTHER = 'https://unrelated.example/page'
const events: ToolEvent[] = [{
  id: 's1', name: 'web_search', done: true, result: '…',
  sources: [{ url: A, site: 'hokkaido-ski.jp', title: '二世谷新手指南' }, { url: B, site: 'rusutsu-resort.com' }],
}]
const content = `1. [山脚有一条缓坡](${A})\n2. [教练全季可约](${B})\n\n还有 [别的网页](${OTHER});[缓坡长](${A})。`

async function render(withCites: boolean) {
  const host = document.createElement('div'); host.className = 't2-content'; document.body.appendChild(host)
  const root = createRoot(host)
  const cites = withCites ? citeIndexOf({ id: 'a1', content, toolEvents: events }) : null
  await act(async () => { root.render(React.createElement(Markdown, { content, linkCards: true, cites })) })
  return { host, root }
}

describe('正文来源编号', () => {
  it('指向来源的链接带号(同网址同号),其他链接不带', async () => {
    const { host, root } = await render(true)
    const links = [...host.querySelectorAll('a')]
    expect(links.map((a) => a.getAttribute('data-cite-n'))).toEqual(['1', '2', null, '1'])
    expect(links.every((a) => a.classList.contains('citelink'))).toBe(true) // 照旧是网页引用条
    act(() => root.unmount())
  })

  it('编号不进文本:复制 / 选区 Markdown 里没有号,链接照旧是 Markdown 链接', async () => {
    const { host, root } = await render(true)
    expect(host.textContent).not.toMatch(/缓坡1|可约2/)
    const range = document.createRange(); range.selectNodeContents(host)
    const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(range)
    const out = selectionMarkdown(sel, host)!
    expect(out.markdown).toContain(`[山脚有一条缓坡](<${A}>)`)
    expect(out.text).not.toMatch(/\d缓坡|缓坡\d/)
    act(() => root.unmount())
  })

  it('没有来源表(老消息 / 别处的 Markdown)照旧:不带号', async () => {
    const { host, root } = await render(false)
    expect(host.querySelector('a[data-cite-n]')).toBeNull()
    act(() => root.unmount())
  })

  it('悬停联动:右栏那行悬停 → 正文同一来源的链接都标 rail;正文自己悬停 → body', async () => {
    const { host, root } = await render(true)
    const idx = citeIndexOf({ id: 'a1', content, toolEvents: events })!
    const key = `a1\u0000${idx.entries[0].key}`
    await act(async () => { useCiteHover.setState({ key, from: 'rail' }) })
    expect([...host.querySelectorAll('a')].map((a) => a.getAttribute('data-cite-hot'))).toEqual(['rail', null, null, 'rail'])
    await act(async () => { host.querySelectorAll('a')[1].dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(useCiteHover.getState().from).toBe('body')
    expect(host.querySelectorAll('a')[1].getAttribute('data-cite-hot')).toBe('body')
    await act(async () => { useCiteHover.setState({ key: null, from: null }) })
    act(() => root.unmount())
  })
})
