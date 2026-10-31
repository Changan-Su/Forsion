// @vitest-environment happy-dom
/**
 * ctx.app.registerRibbonAction 的落点:无论用户排没排过序都在「商店」上面;反注册清干净。
 * 负对照:删掉 addRibbonAction 里写 bottomOrder 的那行 → 「用户排过序」那条红。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { rankIds, useRibbonStore } from '@lcl/engine'
import { RIBBON_ACTION_PREFIX, addRibbonAction } from './ribbonAction'

const ID = `${RIBBON_ACTION_PREFIX}events`
const base = ['rb-feedback', 'rb-market', 'rb-settings'].map((id) => ({ id, side: 'bottom' as const }))
const shown = (): string[] => { const s = useRibbonStore.getState(); return rankIds(s.items.map((i) => i.id), s.bottomOrder) }
const opts = { id: 'events', icon: 'gift', title: '活动', run: () => {} }

beforeEach(() => { useRibbonStore.setState({ items: base, bottomOrder: [] }) })

describe('addRibbonAction', () => {
  it('没排过序:按注册序插在商店上面', () => {
    addRibbonAction(opts)
    expect(shown()).toEqual(['rb-feedback', ID, 'rb-market', 'rb-settings'])
  })
  it('用户排过序:顺序表里也插在商店上面', () => {
    useRibbonStore.setState({ bottomOrder: ['rb-settings', 'rb-market', 'rb-feedback'] })
    addRibbonAction(opts)
    expect(shown()).toEqual(['rb-settings', ID, 'rb-market', 'rb-feedback'])
  })
  it('用户拖过这一格:不改它的位置', () => {
    useRibbonStore.setState({ bottomOrder: ['rb-market', ID, 'rb-feedback'] })
    addRibbonAction(opts)
    expect(useRibbonStore.getState().bottomOrder).toEqual(['rb-market', ID, 'rb-feedback'])
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
