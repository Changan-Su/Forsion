// @vitest-environment happy-dom
//
// 聊天内联嵌入(ChatEmbed)的开关闸:Markdown 缺省关、只有显式给 embeds 的调用点(聊天助手消息)才把
// 独占一段的 `![[…]]` 升格成嵌入。缺省关是安全闸 —— Markdown 还给市场 / 更新日志等渲远端文本,
// 那里的 `![[/Users/x/.ssh/id_rsa]]` 连组件都不该挂上(挂上才会有读盘的 effect)。
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown } from './Markdown'
import { usePageStore } from '../amadeus/store/pageStore'
import type { EmbedCtx } from './ChatEmbed'

const html = (content: string, embeds?: EmbedCtx): string => renderToStaticMarkup(React.createElement(Markdown, { content, embeds }))
const DOC = '![[/abs/a.png]]\n\n看 ![[/abs/b.png]] 这张'

describe('Markdown × 内联嵌入开关', () => {
  it('缺省关:嵌入段只渲引用条,不挂 ChatEmbed', () => {
    const h = html(DOC)
    expect(h).not.toContain('t2-embed')
    expect(h).toContain('data-wiki="/abs/a.png"')
    expect(h).not.toContain('data-embeds') // 标记只给组件读,不漏进 DOM
  })
  it('host 会话开了:独占一段的升格成嵌入(读盘前是占位);句中的仍是引用条', () => {
    const h = html(DOC, { execMode: 'host' })
    expect(h).toContain('class="t2-embeds"')
    expect(h).toMatch(/class="t2-embed t2-embed-image t2-embed-pending"[^>]*title="\/abs\/a\.png"/)
    expect(h).toMatch(/<p>看 !<a class="wikilink" data-wiki="\/abs\/b\.png"/)
  })
  it('sandbox 会话:库外绝对路径不读本机盘(那是云工作区里的文件),退回引用条', () => {
    const h = html(DOC, { execMode: 'sandbox' })
    expect(h).not.toContain('t2-embed-pending')
    expect(h).toContain('data-wiki="/abs/a.png"')
  })
  it('非图片/音视频(PDF 等)不内联,退回引用条', () => {
    const h = html('![[/abs/r.pdf]]', { execMode: 'host' })
    expect(h).not.toContain('t2-embed-pending')
    expect(h).toContain('data-wiki="/abs/r.pdf"')
  })
  it('Windows:库内文件写成 `C:\\…` 绝对路径也认成库内(走 amadeus-asset 流式),不掉进 50MB 的整读路', async () => {
    // SSR 读 zustand 的初始快照(getServerSnapshot),塞进去的库状态看不见 —— 这条得真渲染。
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const prev = usePageStore.getState()
    usePageStore.setState({ vaultRoot: 'C:\\Vault', files: ['img/a.png'] })
    const el = document.createElement('div')
    const root = createRoot(el)
    try {
      await act(async () => { root.render(React.createElement(Markdown, { content: '![[C:\\Vault\\img\\a.png]]', embeds: { execMode: 'host' } })) })
      expect(el.querySelector('img.t2-embed-image')?.getAttribute('src')).toBe('amadeus-asset://v/img%2Fa.png')
    } finally {
      await act(async () => root.unmount())
      usePageStore.setState({ vaultRoot: prev.vaultRoot, files: prev.files })
    }
  })
})
