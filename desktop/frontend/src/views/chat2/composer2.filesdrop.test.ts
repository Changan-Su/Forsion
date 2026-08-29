/**
 * OS 文件拖进聊天区的**接线**契约(2026-08-28:落区从输入框卡片提到整片聊天区)。
 *
 * 用户实报:拖着文件时满屏都在提示可落(fileDropGuard 的 .shell-work 虚线框),
 * 但只有 .t2c-card 那一小块真接得住。这里钉三件会静默退化的事:
 *   1 监听到底挂在**祖先**还是卡片上(挂错=又只有输入框能落,类型检查抓不到)
 *   2 只吃 'Files' —— 应用内引用拖拽(REF_MIME/PATHS_MIME)必须原样漏给 ChatView 的 refdrop
 *   3 选择器与 ChatView 根节点类名同步(改一处即断)
 *
 * 无 DOM 环境(vitest 跑 node),故用最小假节点;真机那一段由 DESIGN.md §8 的截图自查兜。
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, it, expect } from 'vitest'
import { bindFilesDropZone, DROP_ZONE_SEL } from './Composer2'

type H = (e: any) => void
const mkEl = (): any => {
  const ls: Record<string, H[]> = {}
  return {
    ls,
    attrs: new Set<string>(),
    addEventListener(k: string, f: H) { (ls[k] ||= []).push(f) },
    removeEventListener(k: string, f: H) { ls[k] = (ls[k] || []).filter((x) => x !== f) },
    toggleAttribute(k: string, on: boolean) { on ? this.attrs.add(k) : this.attrs.delete(k) },
    contains: () => true,
    closest: () => null,
    count: () => Object.values(ls).reduce((n, a) => n + a.length, 0),
    fire(k: string, e: any) { (ls[k] || []).slice().forEach((f) => f(e)) },
  }
}
const evt = (types: string[], files: any[] = []) => {
  const e: any = { dataTransfer: { types, files }, prevented: false, preventDefault: () => { e.prevented = true } }
  return e
}
/** 卡片 + 一个假的 .t2-chat-view 祖先 */
const withZone = () => {
  const card = mkEl(), zone = mkEl()
  card.closest = (sel: string) => (sel === DROP_ZONE_SEL ? zone : null)
  const dragOver: boolean[] = []
  const got: any[] = []
  const off = bindFilesDropZone(card as any, (f) => got.push(f), (on) => dragOver.push(on))
  return { card, zone, dragOver, got, off }
}

describe('bindFilesDropZone', () => {
  it('落区是整片聊天区,不是输入框卡片', () => {
    const { card, zone } = withZone()
    expect(zone.count()).toBe(3) // dragover / dragleave / drop
    expect(card.count()).toBe(0)
  })

  it('拖 OS 文件:整片高亮 + 认领事件(不认领会被 fileDropGuard 吞掉)', () => {
    const { zone, got, dragOver } = withZone()
    const over = evt(['Files'])
    zone.fire('dragover', over)
    expect(over.prevented).toBe(true)
    expect(zone.attrs.has('data-filedrop')).toBe(true)
    expect(dragOver).toEqual([]) // 卡片那条亮边不参与

    const drop = evt(['Files'], [{ name: 'a.txt' }])
    zone.fire('drop', drop)
    expect(drop.prevented).toBe(true)
    expect(zone.attrs.has('data-filedrop')).toBe(false)
    expect(got).toHaveLength(1)
  })

  it('应用内引用拖拽原样放行(归 ChatView 的 refdrop,两条路不打架)', () => {
    const { zone, got } = withZone()
    const over = evt(['application/x-forsion-chatref'])
    zone.fire('dragover', over)
    zone.fire('drop', evt(['application/x-tangu-paths']))
    expect(over.prevented).toBe(false)
    expect(zone.attrs.has('data-filedrop')).toBe(false)
    expect(got).toEqual([])
  })

  it('没有聊天区祖先(ChatPreview/移动端)→ 退回卡片本身的 .dragover', () => {
    const card = mkEl()
    const dragOver: boolean[] = []
    bindFilesDropZone(card as any, () => {}, (on) => dragOver.push(on))
    expect(card.count()).toBe(3)
    card.fire('dragover', evt(['Files']))
    expect(dragOver).toEqual([true])
    expect(card.attrs.size).toBe(0)
  })

  it('卸载摘干净监听并清高亮(切会话/关标签不留残影)', () => {
    const { zone, off } = withZone()
    zone.fire('dragover', evt(['Files']))
    off()
    expect(zone.count()).toBe(0)
    expect(zone.attrs.has('data-filedrop')).toBe(false)
  })

  it('选择器与 ChatView 根节点类名同步', () => {
    const src = readFileSync(join(__dirname, '../ChatView.tsx'), 'utf8')
    expect(src).toContain(`\`${DROP_ZONE_SEL.slice(1)}\${refDrop ? ' refdrop' : ''}\``)
  })
})
