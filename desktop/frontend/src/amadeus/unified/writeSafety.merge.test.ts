/** 挪动途中打的字交接到新路径(holdUnifiedPath → UnifiedPage.handOver):与主进程改写过引用的那版按行三方合并。
 *  整条链在 desktop 的 npm run e2e:notemove;这里只钉合并本身:能合的合上,同一行两边都改了交回 null(调用方落冲突副本)。 */
import { afterEach, describe, expect, it, vi } from 'vitest'

async function load() {
  vi.resetModules()
  vi.stubGlobal('window', { dispatchEvent: () => true, amadeus: {} })
  return import('./writeSafety')
}
afterEach(() => { vi.unstubAllGlobals() })

const BASE = '# 带图\n\n正文一行\n\n![](.amadeus/p.png)\n\n[doc](attachments/d.pdf)\n'
const MOVED = BASE.replace('](.amadeus/', '](../来源夹/.amadeus/').replace('](attachments/', '](../来源夹/attachments/')

it('挪动途中打的字并进主进程改写过的引用(两边各改各的行)', async () => {
  const { mergeMovedText } = await load()
  const typed = BASE.replace('正文一行', '正文一行续写') + '\n新起一段\n'
  expect(mergeMovedText(BASE, typed, MOVED)).toBe(MOVED.replace('正文一行', '正文一行续写') + '\n新起一段\n')
})

it('CRLF 照样合(两边都是盘上字节)', async () => {
  const { mergeMovedText } = await load()
  const crlf = (s: string) => s.replace(/\n/g, '\r\n')
  expect(mergeMovedText(crlf(BASE), crlf(BASE.replace('正文一行', '正文一行续写')), crlf(MOVED))).toBe(crlf(MOVED.replace('正文一行', '正文一行续写')))
})

it('就在被改写的那行上打字 → 合不拢,交回 null', async () => {
  const { mergeMovedText } = await load()
  expect(mergeMovedText(BASE, BASE.replace('![](.amadeus/p.png)', '![](.amadeus/p.png) 图注'), MOVED)).toBeNull()
})

// 打字中 / CAS 拒写时盘上那版离开了基线(2026-11-14):两台设备改同一篇的不同段落,先合并、合不拢才落冲突副本。
describe('mergeUnsavedEdits (unsaved editor text × newer stored version)', () => {
  const B = '# T\n\npara1\n\npara2\n\npara3\n'
  const ours = B.replace('para3', 'para3 local')
  const theirs = B.replace('para1', 'para1 remote')
  const LAYOUT = '---\namadeus_layout: {"v":4,"rows":[]}\n---\n'

  it('merges edits in different paragraphs', async () => {
    const { mergeUnsavedEdits } = await load()
    expect(mergeUnsavedEdits(B, ours, theirs)).toBe(ours.replace('para1', 'para1 remote'))
  })

  it('same or adjacent lines do not merge', async () => {
    const { mergeUnsavedEdits } = await load()
    expect(mergeUnsavedEdits(B, ours, B.replace('para3', 'para3 remote'))).toBeNull()
    expect(mergeUnsavedEdits('a\nb\nc\n', 'a\nB\nc\n', 'a\nb\nC\n')).toBeNull()
  })

  it('frontmatter is taken whole from the one side that changed it, never line-merged', async () => {
    const { mergeUnsavedEdits } = await load()
    const fm = '---\nstatus: done\n---\n'
    expect(mergeUnsavedEdits(B, ours, fm + theirs)).toBe(fm + ours.replace('para1', 'para1 remote'))
    expect(mergeUnsavedEdits(B, fm + ours, theirs)).toBe(fm + ours.replace('para1', 'para1 remote'))
    expect(mergeUnsavedEdits(B, fm + ours, fm + theirs)).toBe(fm + ours.replace('para1', 'para1 remote'))
    // 两边各加一个键:按行合会合出两个 fm 块里的键 / 重复键,一律交给冲突副本
    const base = '---\na: 1\n\nz: 9\n---\n' + B
    expect(mergeUnsavedEdits(base, base.replace('a: 1', 'a: 1\nmine: x') + 'x\n', base.replace('z: 9', 'z: 9\ntheirs: y'))).toBeNull()
  })

  it('layout / canvas structure lines must be identical in all three versions', async () => {
    const { mergeUnsavedEdits } = await load()
    expect(mergeUnsavedEdits(LAYOUT + B, LAYOUT + ours, LAYOUT + theirs)).toBe(LAYOUT + ours.replace('para1', 'para1 remote'))
    const moved = LAYOUT.replace('"rows":[]', '"rows":[{"columns":[{"refs":["a1"],"width":1}]}]')
    expect(mergeUnsavedEdits(LAYOUT + B, LAYOUT + ours, moved + theirs)).toBeNull()
    expect(mergeUnsavedEdits(LAYOUT + B, moved + ours, LAYOUT + theirs)).toBeNull()
    const canvas = '---\namadeus_canvas: {"cards":[]}\n---\n'
    expect(mergeUnsavedEdits(B, ours, canvas + theirs)).toBeNull()
  })
})
