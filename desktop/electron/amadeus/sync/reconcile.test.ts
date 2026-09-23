import { describe, expect, it } from 'vitest'
import { conflictCopyPath, decide, mergeText3, shouldTripMassDelete, type RemoteInfo, type ShadowEntry } from './reconcile'
import { isIgnoredName, isUnderFolder, normalizeServerPath, toServerPath } from './syncPaths'

const sh = (seq: number, hash: string): ShadowEntry => ({ seq, hash, size: 1, mtimeMs: 1 })
const rm = (seq: number, hash: string | null): RemoteInfo => ({ seq, hash })

describe('decide — 三方对账判定矩阵全表', () => {
  // 记法:L=本地 hash,S=shadow 基线,R=远端 {seq,hash}
  it('全空 → none', () => {
    expect(decide(null, null, null)).toEqual({ kind: 'none' })
  })

  describe('远端不存在(R=null)', () => {
    it('本地新文件(无基线)→ pushCreate', () => {
      expect(decide('a', null, null)).toEqual({ kind: 'pushCreate' })
    })
    it('两端都没了但留有基线 → dropShadow(墓碑清理)', () => {
      expect(decide(null, sh(3, 'a'), null)).toEqual({ kind: 'dropShadow' })
    })
    it('本地未改 + 云端已删 → deleteLocal(删除生效)', () => {
      expect(decide('a', sh(3, 'a'), null)).toEqual({ kind: 'deleteLocal' })
    })
    it('本地改过 + 云端已删 → pushCreate(编辑胜删除)', () => {
      expect(decide('b', sh(3, 'a'), null)).toEqual({ kind: 'pushCreate' })
    })
  })

  describe('本地不存在(L=null)', () => {
    it('远端新文件(无基线)→ pull', () => {
      expect(decide(null, null, rm(1, 'a'))).toEqual({ kind: 'pull' })
    })
    it('本地删了 + 远端未动 → pushDelete(删除生效)', () => {
      expect(decide(null, sh(3, 'a'), rm(3, 'a'))).toEqual({ kind: 'pushDelete' })
    })
    it('本地删了 + 远端改过 → pull(编辑胜删除)', () => {
      expect(decide(null, sh(3, 'a'), rm(5, 'b'))).toEqual({ kind: 'pull' })
    })
  })

  describe('两端都有、无基线(首次配对同路径)', () => {
    it('内容一致 → adopt(只记账)', () => {
      expect(decide('a', null, rm(4, 'a'))).toEqual({ kind: 'adopt' })
    })
    it('内容不同 → conflict', () => {
      expect(decide('b', null, rm(4, 'a'))).toEqual({ kind: 'conflict' })
    })
    it('远端 hash 未知(null)→ 永不视作相等 → conflict', () => {
      expect(decide('a', null, rm(4, null))).toEqual({ kind: 'conflict' })
    })
  })

  describe('两端都有、有基线', () => {
    it('双方都没动 → none', () => {
      expect(decide('a', sh(3, 'a'), rm(3, 'x-ignored'))).toEqual({ kind: 'none' })
    })
    it('只远端动了 → pull', () => {
      expect(decide('a', sh(3, 'a'), rm(5, 'b'))).toEqual({ kind: 'pull' })
    })
    it('只本地动了 → push(CAS 带基线 seq)', () => {
      expect(decide('b', sh(3, 'a'), rm(3, 'a'))).toEqual({ kind: 'push', baseSeq: 3 })
    })
    it('双方都动、内容恰好一致 → adopt', () => {
      expect(decide('b', sh(3, 'a'), rm(5, 'b'))).toEqual({ kind: 'adopt' })
    })
    it('双方都动、内容不同 → conflict(LWW+冲突副本)', () => {
      expect(decide('c', sh(3, 'a'), rm(5, 'b'))).toEqual({ kind: 'conflict' })
    })
    it('本地改过 + 远端 seq 动了但内容仍是基线(原样重写 / 改了又改回,seq 可跳)→ push 按新 seq,不是 conflict', () => {
      expect(decide('b', sh(3, 'a'), rm(5, 'a'))).toEqual({ kind: 'push', baseSeq: 5 })
    })
    it('远端 hash 未知(null)+ 本地改过 → 仍是 conflict(不许把 null 当基线)', () => {
      expect(decide('b', sh(3, 'a'), rm(5, null))).toEqual({ kind: 'conflict' })
    })
  })
})

describe('conflictCopyPath', () => {
  const now = new Date(2026, 6, 10, 15, 32) // 2026-07-10 15:32 本地时间
  it('带目录与扩展名', () => {
    expect(conflictCopyPath('a/b/Note.md', now)).toBe('a/b/Note (conflict 2026-07-10 1532).md')
  })
  it('根级无扩展名', () => {
    expect(conflictCopyPath('README', now)).toBe('README (conflict 2026-07-10 1532)')
  })
  it('点开头文件不吞名字', () => {
    expect(conflictCopyPath('.hidden', now)).toBe('.hidden (conflict 2026-07-10 1532)')
  })
})

describe('syncPaths', () => {
  it('normalizeServerPath:NFC 归一 + 反斜杠转正斜杠 + 尾斜杠剥离', () => {
    expect(normalizeServerPath('a\\b\\c.md')).toBe('a/b/c.md')
    expect(normalizeServerPath('a/b/')).toBe('a/b')
    // NFD(é = e + 组合符)→ NFC 单码点
    expect(normalizeServerPath('café.md')).toBe('café.md')
  })
  it('normalizeServerPath:非法路径拒绝', () => {
    expect(normalizeServerPath('/abs')).toBeNull()
    expect(normalizeServerPath('a/../b')).toBeNull()
    expect(normalizeServerPath('a//b')).toBeNull()
    expect(normalizeServerPath('')).toBeNull()
    expect(normalizeServerPath('a/./b')).toBeNull()
    expect(normalizeServerPath('bad\u0000name')).toBeNull() // 控制符
    expect(normalizeServerPath('My Note.md')).toBe('My Note.md') // 普通空格合法
  })
  it('toServerPath:剥子树前缀;子树外/子树根本身 → null', () => {
    expect(toServerPath('Cloud/Notes/x.md', 'Cloud')).toBe('Notes/x.md')
    expect(toServerPath('Cloud\\Notes\\x.md', 'Cloud')).toBe('Notes/x.md') // Windows 分隔符
    expect(toServerPath('Other/x.md', 'Cloud')).toBeNull()
    expect(toServerPath('Cloud', 'Cloud')).toBeNull()
    expect(toServerPath('Cloudy/x.md', 'Cloud')).toBeNull() // 前缀不粘连
  })
  it('isUnderFolder:含子树根本身', () => {
    expect(isUnderFolder('Cloud', 'Cloud')).toBe(true)
    expect(isUnderFolder('Cloud/x', 'Cloud')).toBe(true)
    expect(isUnderFolder('Cloudy/x', 'Cloud')).toBe(false)
  })
  it('isIgnoredName:临时文件/系统杂物', () => {
    expect(isIgnoredName('.DS_Store')).toBe(true)
    expect(isIgnoredName('x.md.tmp-123-456-7')).toBe(true)
    expect(isIgnoredName('x.md')).toBe(false)
    expect(isIgnoredName('.amadeus')).toBe(false) // 资产目录参与同步
  })
})

describe('mergeText3 — markdown 冲突机会性合并', () => {
  const base = '# 标题\n\n第一段\n\n第二段\n'
  it('两端改不同区域 → 干净合并,双方改动都在', () => {
    const ours = '# 标题\n\n第一段(本地改)\n\n第二段\n'
    const theirs = '# 标题\n\n第一段\n\n第二段(云端改)\n'
    const merged = mergeText3(ours, base, theirs)
    expect(merged).toContain('第一段(本地改)')
    expect(merged).toContain('第二段(云端改)')
  })
  it('两端改同一行且不同 → null(交给冲突副本,绝不出冲突标记)', () => {
    const ours = base.replace('第一段', '本地版')
    const theirs = base.replace('第一段', '云端版')
    expect(mergeText3(ours, base, theirs)).toBeNull()
  })
  it('单端追加 → 合并等于追加结果', () => {
    const ours = base + '\n本地追加\n'
    expect(mergeText3(ours, base, base)).toBe(ours)
  })
  it('两端改同一行、内容相同 → 干净(excludeFalseConflicts)', () => {
    const both = base.replace('第一段', '同改')
    expect(mergeText3(both, base, both)).toBe(both)
  })
})

describe('shouldTripMassDelete — 删除保护阈值', () => {
  it('小库半数以上删除 → 拦', () => {
    expect(shouldTripMassDelete(15, 30)).toBe(true) // 30 个文件删 15
    expect(shouldTripMassDelete(30, 30)).toBe(true) // 全删
  })
  it('大库正常量删除 → 放', () => {
    expect(shouldTripMassDelete(60, 1000)).toBe(false) // 删个大文件夹
    expect(shouldTripMassDelete(0, 1000)).toBe(false)
  })
  it('绝对上限 → 拦', () => {
    expect(shouldTripMassDelete(200, 10_000)).toBe(true)
  })
  it('空库/极小库不误拦', () => {
    expect(shouldTripMassDelete(3, 4)).toBe(false) // tracked<5 不触发比例规则
    expect(shouldTripMassDelete(4, 8)).toBe(false) // 半数=4 但 <5 下限…
    expect(shouldTripMassDelete(5, 8)).toBe(true)
  })
})
