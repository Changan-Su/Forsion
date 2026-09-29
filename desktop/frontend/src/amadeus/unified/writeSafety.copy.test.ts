/** 冲突副本占名(Codex 复核返修 P0):「读到空位 → 写」之间别的窗口刚占了同一个名字 → 必须换下一个编号,不许把人家的副本盖掉。
 *  宿主按 create = 原子仅新建实现(与桌面主进程 / 移动桥 / 云桥同契约)。负对照(实跑过):去掉对 create 结果的判断 → 本组红。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const disk = new Map<string, string>()
let onRead: (p: string) => void = () => {}

async function load() {
  vi.resetModules()
  vi.stubGlobal('window', {
    dispatchEvent: () => true,
    amadeus: {
      readTextFile: async (p: string) => { const v = disk.get(p) ?? null; onRead(p); return v },
      writeTextFile: async (p: string, text: string, o?: { create?: boolean }) => {
        if (o?.create) {
          const cur = disk.get(p)
          if (cur != null) return { ok: false, current: cur }
          disk.set(p, text)
          return { ok: true }
        }
        disk.set(p, text)
      },
    },
  })
  return import('./writeSafety')
}

beforeEach(() => { disk.clear(); onRead = () => {} })
afterEach(() => { vi.unstubAllGlobals() })

describe('writeConflictCopy 跨窗口占名', () => {
  const now = new Date(2026, 8, 29, 1, 2)
  it('读到空位之后别的窗口抢先占了这个名字 → 换下一个编号,两份副本都在', async () => {
    const { writeConflictCopy } = await load()
    let raced = false
    onRead = (p) => { if (!raced && p.includes('(conflict')) { raced = true; disk.set(p, '别的窗口的副本') } }
    const copy = await writeConflictCopy('Note.md', '我的内容', now)
    expect(disk.get(copy)).toBe('我的内容')
    const others = [...disk].filter(([, v]) => v === '别的窗口的副本')
    expect(others).toHaveLength(1)
    expect(others[0][0]).not.toBe(copy)
  })
  it('抢先占名的恰好是同一份内容 → 复用,不出第二份', async () => {
    const { writeConflictCopy } = await load()
    let raced = false
    onRead = (p) => { if (!raced && p.includes('(conflict')) { raced = true; disk.set(p, '同一份') } }
    const copy = await writeConflictCopy('Note.md', '同一份', now)
    expect([...disk.values()].filter((v) => v === '同一份')).toHaveLength(1)
    expect(disk.get(copy)).toBe('同一份')
  })
})
