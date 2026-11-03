// @vitest-environment happy-dom
/**
 * ctx.app.registerRibbonAction 的落点:无论用户排没排过序都在「商店」下面(明暗原来的位置);反注册清干净。
 * moveModeLastOnce:老存档里明暗紧跟商店才挪到最后,只挪一次;用户别的摆法不动。
 * 负对照:删掉 addRibbonAction 里写 bottomOrder 的那行 → 「用户排过序」那条红;去掉 moveModeLastOnce 的形状判断 → 「用户自己摆过」两条红;
 * 不挪旧位的首方图标 → 「旧版存在商店上面」那条红。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { rankIds, useRibbonStore } from '@lcl/engine'
import { RIBBON_ACTION_PREFIX, addRibbonAction, moveModeLastOnce } from './ribbonAction'

const ID = `${RIBBON_ACTION_PREFIX}events`
const base = ['rb-feedback', 'rb-market', 'rb-cmd', 'rb-settings', 'rb-mode'].map((id) => ({ id, side: 'bottom' as const }))
const shown = (): string[] => { const s = useRibbonStore.getState(); return rankIds(s.items.map((i) => i.id), s.bottomOrder) }
const opts = { id: 'events', icon: 'gift', title: '活动', run: () => {} }

beforeEach(() => { useRibbonStore.setState({ items: base, bottomOrder: [], folders: [] }); localStorage.clear() })

describe('addRibbonAction', () => {
  it('没排过序:按注册序插在商店下面,明暗在最后', () => {
    addRibbonAction(opts)
    expect(shown()).toEqual(['rb-feedback', 'rb-market', ID, 'rb-cmd', 'rb-settings', 'rb-mode'])
  })
  it('用户排过序:顺序表里也插在商店下面', () => {
    useRibbonStore.setState({ bottomOrder: ['rb-settings', 'rb-market', 'rb-feedback'] })
    addRibbonAction(opts)
    expect(useRibbonStore.getState().bottomOrder).toEqual(['rb-settings', 'rb-market', ID, 'rb-feedback'])
  })
  it('用户拖过这一格:不改它的位置', () => {
    useRibbonStore.setState({ bottomOrder: [ID, 'rb-market', 'rb-feedback'] })
    addRibbonAction(opts)
    expect(useRibbonStore.getState().bottomOrder).toEqual([ID, 'rb-market', 'rb-feedback'])
  })
  it('没有商店的宿主:排在最后', () => {
    useRibbonStore.setState({ items: [base[0]!] })
    addRibbonAction(opts)
    expect(shown()).toEqual(['rb-feedback', ID])
  })
  it('反注册清掉图标和顺序', () => {
    useRibbonStore.setState({ bottomOrder: ['rb-market'] })
    addRibbonAction(opts)()
    expect(shown()).not.toContain(ID)
    expect(useRibbonStore.getState().bottomOrder).toEqual(['rb-market'])
  })
})

describe('moveModeLastOnce', () => {
  it('老存档里明暗紧跟商店:挪到最后,再调不动', () => {
    useRibbonStore.setState({ bottomOrder: ['rb-feedback', 'rb-market', 'rb-mode', 'rb-cmd', 'rb-settings'] })
    moveModeLastOnce()
    expect(useRibbonStore.getState().bottomOrder).toEqual(['rb-feedback', 'rb-market', 'rb-cmd', 'rb-settings', 'rb-mode'])
    useRibbonStore.setState({ bottomOrder: ['rb-market', 'rb-mode', 'rb-cmd'] })
    moveModeLastOnce()
    expect(useRibbonStore.getState().bottomOrder).toEqual(['rb-market', 'rb-mode', 'rb-cmd'])
  })
  it('用户自己摆过明暗:不动', () => {
    useRibbonStore.setState({ bottomOrder: ['rb-feedback', 'rb-mode', 'rb-market', 'rb-cmd'] })
    moveModeLastOnce()
    expect(useRibbonStore.getState().bottomOrder).toEqual(['rb-feedback', 'rb-mode', 'rb-market', 'rb-cmd'])
  })
  it('用户换过命令面板和设置:明暗紧跟商店也不动', () => {
    useRibbonStore.setState({ bottomOrder: ['rb-feedback', 'rb-market', 'rb-mode', 'rb-settings', 'rb-cmd'] })
    moveModeLastOnce()
    expect(useRibbonStore.getState().bottomOrder).toEqual(['rb-feedback', 'rb-market', 'rb-mode', 'rb-settings', 'rb-cmd'])
  })
  it('旧版存在商店上面的活动图标:挪到商店下面,后面不再插第二份', () => {
    useRibbonStore.setState({ bottomOrder: ['rb-feedback', ID, 'rb-market', 'rb-mode', 'rb-cmd', 'rb-settings'] })
    moveModeLastOnce()
    addRibbonAction(opts)
    expect(useRibbonStore.getState().bottomOrder).toEqual(['rb-feedback', 'rb-market', ID, 'rb-cmd', 'rb-settings', 'rb-mode'])
  })
  it('明暗收在收纳夹里:不动', () => {
    useRibbonStore.setState({ bottomOrder: ['rb-market', 'rb-mode', 'rb-cmd'], folders: [{ id: 'f', side: 'bottom', name: 'x', items: ['rb-mode'] } as never] })
    moveModeLastOnce()
    expect(useRibbonStore.getState().bottomOrder).toEqual(['rb-market', 'rb-mode', 'rb-cmd'])
  })
  it('没排过序:什么都不写', () => {
    moveModeLastOnce()
    expect(useRibbonStore.getState().bottomOrder).toEqual([])
  })
})
