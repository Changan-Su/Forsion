import { beforeEach, describe, expect, it } from 'vitest'
import { useRibbonStore, rankIds, reorderBase, moveTo, slotIndexAt } from './ribbonRegistry'

const reset = (): void => useRibbonStore.setState({ items: [], order: [], bottomOrder: [], folders: [], commandItems: [], commandIcons: {} })

describe('rankIds', () => {
  it('order 里的按序靠前,未列出的按出现序排后', () => {
    expect(rankIds(['a', 'b', 'c', 'd'], ['c', 'a'])).toEqual(['c', 'a', 'b', 'd'])
  })
  it('order 含幽灵 id 不影响', () => {
    expect(rankIds(['a', 'b'], ['ghost', 'b'])).toEqual(['b', 'a'])
  })
  it('新装插件的 Space 默认排在 Space 区最后(排过序的老用户也是)', () => {
    // 用户拖过顺序 → order 里是既有 Space;插件 Space 异步注册进 items,未列入 order
    const visible = ['space:bluebird', 'space:tangu', 'space:amadeus'] // 注册序:插件的可能排在前面
    const order = ['space:amadeus', 'space:tangu', 'space:ghost']       // 含已卸载的幽灵
    expect(rankIds(visible, order)).toEqual(['space:amadeus', 'space:tangu', 'space:bluebird'])
  })
})

describe('reorderBase (codex#2: 保住异步未加载项)', () => {
  it('持久序里当前不可见的 id 不被抹掉', () => {
    // space:user 还没加载(visible 只有 tangu),拖动 tangu 不能丢 user 的存档位
    const base = reorderBase(['space:user', 'space:tangu'], ['space:tangu'], 'space:tangu')
    expect(base).toEqual(['space:user']) // moved 已剔除,user 保留
    base.splice(base.length, 0, 'space:tangu')
    expect(base).toEqual(['space:user', 'space:tangu']) // 顺序还原,user 仍在前
  })
  it('新出现的可见项(不在持久序)追加在后', () => {
    expect(reorderBase(['a'], ['a', 'b'], 'x')).toEqual(['a', 'b'])
  })
})

describe('moveTo (悬停谁就顶掉谁)', () => {
  it('下移一格是真的动了 —— 旧的「插到目标之前」在这里是空操作', () => {
    expect(moveTo(['A', 'B', 'C'], 'A', 1)).toEqual(['B', 'A', 'C'])
  })
  it('下移到末位可达(插入语义排不到最后)', () => {
    expect(moveTo(['A', 'B', 'C'], 'A', 2)).toEqual(['B', 'C', 'A'])
  })
  it('上移:C 顶掉 A 的位置', () => {
    expect(moveTo(['A', 'B', 'C'], 'C', 0)).toEqual(['C', 'A', 'B'])
  })
  it('落回原位 = 不动', () => {
    expect(moveTo(['A', 'B', 'C'], 'B', 1)).toEqual(['A', 'B', 'C'])
  })
  it('外来项(不在 list)插到 to 之前', () => {
    expect(moveTo(['A', 'B', 'C'], 'X', 2)).toEqual(['A', 'B', 'X', 'C'])
  })
  it('越界夹取', () => {
    expect(moveTo(['A', 'B'], 'A', 99)).toEqual(['B', 'A'])
    expect(moveTo(['A', 'B'], 'B', -3)).toEqual(['B', 'A'])
  })
})

// 让位预览与提交共用 slotIndexAt + moveTo:预览显示的顺序 = 松手后的顺序(「提示≠落点」的根治条件)。
describe('slotIndexAt', () => {
  const g = { top: 100, pitch: 36, grabDy: 18 } // 三槽,抓住第 0 槽的中点(y=118)
  it('没挪动 = 停在原位(不虚报落点)', () => {
    expect(slotIndexAt(118, 3, g)).toBe(0)
  })
  it('过半槽才换位,上下对称', () => {
    expect(slotIndexAt(118 + 17, 3, g)).toBe(0)
    expect(slotIndexAt(118 + 19, 3, g)).toBe(1)
    expect(slotIndexAt(118 + 36 - 19, 3, g)).toBe(0) // 从第 1 槽往回,同样是过半才换
  })
  it('槽间隙里也有确定落点(不再滑到区末尾)', () => {
    expect(slotIndexAt(118 + 34, 3, g)).toBe(1) // 34px 处 = 两槽之间那 4px gap
  })
  it('拖出列表两端 = 夹到首/末槽', () => {
    expect(slotIndexAt(-999, 3, g)).toBe(0)
    expect(slotIndexAt(9999, 3, g)).toBe(2)
  })
  it('单槽 / pitch 量不到时不炸', () => {
    expect(slotIndexAt(9999, 1, g)).toBe(0)
    expect(slotIndexAt(9999, 3, { ...g, pitch: 0 })).toBe(0)
  })
})

describe('ribbon 收纳夹', () => {
  beforeEach(reset)

  it('新建收纳夹进入对应区顺序', () => {
    useRibbonStore.getState().addFolder('bottom', '工具')
    const s = useRibbonStore.getState()
    expect(s.folders).toHaveLength(1)
    expect(s.bottomOrder).toContain(s.folders[0].id)
    expect(s.folders[0].zone).toBe('bottom')
  })

  it('移入 → 成员登记且从其他夹去重;移出 → 去 membership', () => {
    const st = useRibbonStore.getState()
    st.addFolder('top', 'A')
    st.addFolder('top', 'B')
    const [a, b] = useRibbonStore.getState().folders
    st.moveIntoFolder(a.id, 'space:x')
    st.moveIntoFolder(b.id, 'space:x') // 应从 A 移出、进 B
    let f = useRibbonStore.getState().folders
    expect(f.find((x) => x.id === a.id)!.items).toEqual([])
    expect(f.find((x) => x.id === b.id)!.items).toEqual(['space:x'])
    st.moveOutOfFolder('space:x')
    f = useRibbonStore.getState().folders
    expect(f.every((x) => !x.items.includes('space:x'))).toBe(true)
  })

  it('removeRibbonIcon 清幽灵:删图标同时清 order/bottomOrder/夹成员(codex#4)', () => {
    const st = useRibbonStore.getState()
    st.setZoneOrder('top', ['space:x', 'space:y'])
    st.addFolder('top', 'F')
    const f = useRibbonStore.getState().folders[0]
    st.moveIntoFolder(f.id, 'space:x')
    st.removeRibbonIcon('space:x') // 删除该 Space
    const s = useRibbonStore.getState()
    expect(s.order).not.toContain('space:x')
    expect(s.folders[0].items).not.toContain('space:x') // 不留幽灵成员(否则计数虚高 + 同 id 重建诈尸回夹)
  })

  it('解散:成员回填到收纳夹在顺序数组里的原槽位', () => {
    const st = useRibbonStore.getState()
    st.setZoneOrder('bottom', ['x', 'y', 'z'])
    st.addFolder('bottom', 'F') // 追加到末尾
    const f = useRibbonStore.getState().folders[0]
    // 手动把夹挪到中间,并塞两个成员
    st.setZoneOrder('bottom', ['x', f.id, 'z'])
    st.setFolderItems(f.id, ['m', 'n'])
    st.removeFolder(f.id)
    expect(useRibbonStore.getState().folders).toHaveLength(0)
    expect(useRibbonStore.getState().bottomOrder).toEqual(['x', 'm', 'n', 'z'])
  })
})

describe('ribbon 自定义图标', () => {
  beforeEach(reset)

  it('收纳夹图标:设置 / 清除(空串回落 undefined)', () => {
    const st = useRibbonStore.getState()
    st.addFolder('top', 'F')
    const id = useRibbonStore.getState().folders[0].id
    st.setFolderIcon(id, 'star')
    expect(useRibbonStore.getState().folders[0].icon).toBe('star')
    st.setFolderIcon(id, '')
    expect(useRibbonStore.getState().folders[0].icon).toBeUndefined()
  })

  it('命令项图标:设置 / 清除删键;移除命令项一并清图标(不留孤儿)', () => {
    const st = useRibbonStore.getState()
    st.addCommandItem('toggle-left')
    st.setCommandIcon('toggle-left', 'zap')
    expect(useRibbonStore.getState().commandIcons['toggle-left']).toBe('zap')
    st.setCommandIcon('toggle-left', '')
    expect('toggle-left' in useRibbonStore.getState().commandIcons).toBe(false)
    st.setCommandIcon('toggle-left', 'star')
    st.removeCommandItem('toggle-left')
    expect('toggle-left' in useRibbonStore.getState().commandIcons).toBe(false)
  })
})

describe('ribbon 命令项', () => {
  beforeEach(reset)

  it('加命令:登记 id + 进 bottomOrder(前缀 cmd:);重复幂等', () => {
    const st = useRibbonStore.getState()
    st.addCommandItem('toggle-left')
    st.addCommandItem('toggle-left')
    expect(useRibbonStore.getState().commandItems).toEqual(['toggle-left'])
    expect(useRibbonStore.getState().bottomOrder).toContain('cmd:toggle-left')
  })

  it('移除命令:同时清 commandItems / bottomOrder / 收纳夹成员', () => {
    const st = useRibbonStore.getState()
    st.addCommandItem('quick-find')
    st.addFolder('bottom', 'F')
    const f = useRibbonStore.getState().folders[0]
    st.moveIntoFolder(f.id, 'cmd:quick-find')
    st.removeCommandItem('quick-find')
    const s = useRibbonStore.getState()
    expect(s.commandItems).toEqual([])
    expect(s.bottomOrder).not.toContain('cmd:quick-find')
    expect(s.folders[0].items).not.toContain('cmd:quick-find')
  })
})
