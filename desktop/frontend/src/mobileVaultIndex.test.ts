import { describe, it, expect } from 'vitest'
// 运行时再导:静态导入会把 mobile 的源码(path-browserify 无类型)拉进 desktop 的 tsc
const MOBILE_INDEX = '../../../mobile/src/amadeus/vaultIndex'
// 手机本地库的索引(mobile/src/amadeus/vaultIndex.ts):同一篇的读取交错时只认最后发起的那次(Codex 评审 2026-11-19)
describe('手机库索引:同一篇的更新交错', () => {
  it('早发起、晚读完的那次不覆盖后一次;remove 之后迟到的读不把那篇塞回去', async () => {
    const texts: Record<string, string> = { 'n.md': '# n\n\nold #oldtag\n' }
    const gates: Array<() => void> = []
    const vault = {
      isPagePath: (p: string) => p.endsWith('.md'),
      absPath: (p: string) => p,
      listPages: async () => Object.keys(texts),
      readTextAbs: async (p: string) => { const t = texts[p]; await new Promise<void>((r) => gates.push(r)); if (t == null) throw new Error('gone'); return t },
    }
    const { VaultIndex } = await import(/* @vite-ignore */ MOBILE_INDEX)
    const idx = new VaultIndex(vault)
    const first = idx.update('n.md') // reads "old"
    texts['n.md'] = '# n\n\nnew #newtag\n'
    const second = idx.update('n.md') // reads "new"
    gates[1](); await second
    gates[0](); await first
    const dump = JSON.stringify((idx as unknown as { entries: Map<string, unknown> }).entries.get('n.md'))
    expect(dump).toContain('newtag')
    expect(dump).not.toContain('oldtag')
    const late = idx.update('n.md')
    idx.remove('n.md')
    gates[2](); await late
    expect((idx as unknown as { entries: Map<string, unknown> }).entries.has('n.md')).toBe(false)
  })
})
