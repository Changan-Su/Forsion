import { describe, expect, it } from 'vitest'
import type { StoredDesktopConfig } from '../types'
import { dropCommittedEdits, hasDirtyEdits, mergeEdits, pickEdits } from './settingsDraft'

const saved = { mode: 'managed', sandbox: 'auto', mirror: 'default', keepAwakeWhileRunning: false, defaultWorkspaceDir: '/a' } as unknown as StoredDesktopConfig

// U-05:「改草稿 → 拨即时开关 → 草稿仍在」—— 即时开关回来的 effectiveConfig 只替换快照,草稿层原样叠在上面。
describe('settings draft overlay', () => {
  it('即时开关刷新快照后,未保存的草稿仍浮在上面', () => {
    const edits = { sandbox: 'none' as const, defaultWorkspaceDir: '/draft' }
    const afterInstantToggle = { ...saved, keepAwakeWhileRunning: true } as StoredDesktopConfig // 主进程回来的整份配置
    const view = mergeEdits(afterInstantToggle, edits)!
    expect(view.sandbox).toBe('none')
    expect(view.defaultWorkspaceDir).toBe('/draft')
    expect(view.keepAwakeWhileRunning).toBe(true)
  })

  it('快照没到时视图为 null;没草稿时原样返回快照', () => {
    expect(mergeEdits(null, { sandbox: 'none' })).toBeNull()
    expect(mergeEdits(saved, {})).toBe(saved)
  })

  it('提交完成只摘掉提交时那一份值;提交途中又改的保留', () => {
    const committed = { defaultWorkspaceDir: '/draft ' }
    expect(dropCommittedEdits({ defaultWorkspaceDir: '/draft ', sandbox: 'none' }, committed)).toEqual({ sandbox: 'none' })
    expect(dropCommittedEdits({ defaultWorkspaceDir: '/draft-newer' }, committed)).toEqual({ defaultWorkspaceDir: '/draft-newer' })
  })

  it('pickEdits 只挑存在的键', () => {
    expect(pickEdits({ sandbox: 'none', mirror: 'china' }, ['sandbox', 'pythonMode'])).toEqual({ sandbox: 'none' })
  })

  it('脏判断按缺省值归一:改回原值不算脏', () => {
    expect(hasDirtyEdits(saved, { mirror: 'china' }, ['mirror'])).toBe(true)
    expect(hasDirtyEdits(saved, { mirror: 'default' }, ['mirror'])).toBe(false)
    const noPython = { ...saved } as StoredDesktopConfig
    expect(hasDirtyEdits(noPython, { pythonMode: 'bundled' }, ['pythonMode'], { pythonMode: 'bundled' })).toBe(false)
    expect(hasDirtyEdits(null, { mirror: 'china' }, ['mirror'])).toBe(false)
  })
})
