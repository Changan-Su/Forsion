// @vitest-environment happy-dom
/** 反链面板(评审 2026-09-27 L-16)DOM 契约:逐处上下文(属性区标「属性」)、旧宿主退回 snippet、
 *  未链接提及**展开才取**、「链接」按钮把提及交给 linkMention(内文按唯一即最短 + `|原文`)。
 *  负对照:把面板换回旧版「每来源一条 snippet」→ 逐处用例红。createElement 而非 JSX(同 amadeusProperties.draft.test)。 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import * as React from 'react'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { BacklinkRef, UnlinkedMention } from '@amadeus-shared/ipc'

const api = vi.hoisted(() => ({
  backlinks: vi.fn(),
  unlinkedMentions: vi.fn(),
  linkMention: vi.fn(),
}))
vi.mock('./amadeus/api', () => ({ amadeus: api }))
vi.mock('./amadeusNav', () => ({ openNote: vi.fn(() => Promise.resolve()) }))

import { AmadeusBacklinksView, mentionInner } from './amadeusBacklinks'
import { usePageStore } from './amadeus/store/pageStore'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean; React: typeof React }
g.IS_REACT_ACT_ENVIRONMENT = true
g.React = React

const REFS: BacklinkRef[] = [
  { path: 'Alpha.md', title: 'Alpha', snippet: 'related: Target', hits: [{ line: 0, text: 'related: Target' }] },
  { path: 'Src.md', title: 'Src', snippet: 'first Target line', hits: [{ line: 1, text: 'first Target line' }, { line: 3, text: 'second 别名 line' }] },
  { path: 'Old.md', title: 'Old', snippet: 'only a snippet' }, // 旧宿主:没有 hits
]
const UNLINKED: UnlinkedMention[] = [
  { path: 'Plain.md', title: 'Plain', hits: [{ line: 3, text: 'I mention target here.', raw: 'I mention target here.', occ: 0, col: 10, match: 'target' }, { line: 9, text: '字符引用行(只展示)' }] },
]

let root: Root | null = null
let host: HTMLDivElement
const flush = async (): Promise<void> => { await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
const texts = (sel: string): string[] => [...host.querySelectorAll(sel)].map((e) => e.textContent ?? '')

beforeEach(() => {
  api.backlinks.mockReset().mockResolvedValue(REFS)
  api.unlinkedMentions.mockReset().mockResolvedValue(UNLINKED)
  api.linkMention.mockReset().mockResolvedValue(true)
  usePageStore.setState({ activePage: null, activeNotePath: 'Target.md', pages: ['Alpha.md', 'Plain.md', 'Src.md', 'Target.md'] })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root?.unmount())
  root = null
  host.remove()
})

describe('反链面板(L-16)', () => {
  it('逐处列出上下文;属性区标「属性」;旧宿主退回 snippet', async () => {
    act(() => { root!.render(createElement(AmadeusBacklinksView)) })
    await flush()
    expect(texts('.amx-backlink-src')).toEqual(['Alpha', 'Src', 'Old'])
    expect(texts('.amx-backlink-hit')).toEqual(['属性related: Target', 'first Target line', 'second 别名 line', 'only a snippet'])
  })
  it('未链接提及:折叠时不取(全库扫描);展开才取;可回写的一处才有「链接」按钮', async () => {
    act(() => { root!.render(createElement(AmadeusBacklinksView)) })
    await flush()
    expect(api.unlinkedMentions).not.toHaveBeenCalled()
    act(() => { (host.querySelector('.amx-backlink-toggle') as HTMLButtonElement).click() })
    await flush()
    expect(api.unlinkedMentions).toHaveBeenCalledWith('Target.md')
    expect(texts('.amx-mention-text')).toEqual(['I mention target here.', '字符引用行(只展示)'])
    const btns = host.querySelectorAll<HTMLButtonElement>('.amx-backlink-link')
    expect(btns).toHaveLength(1)
    act(() => { btns[0].click() })
    await flush()
    expect(api.linkMention).toHaveBeenCalledWith('Plain.md', { raw: 'I mention target here.', occ: 0, col: 10, match: 'target' }, 'Target|target')
  })
  it('mentionInner:唯一即最短;原文与标题一致不带别名;重名走路径', () => {
    expect(mentionInner('Target.md', ['Target.md'], 'Target')).toBe('Target')
    expect(mentionInner('Target.md', ['Target.md'], 'target')).toBe('Target|target')
    expect(mentionInner('a/Target.md', ['a/Target.md', 'b/Target.md'], 'Target')).toBe('a/Target|Target')
  })
})
