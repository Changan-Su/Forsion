import { beforeEach, describe, expect, it } from 'vitest'
import { useRibbonStore, useSpaceStore, type SpaceDefinition } from '@lcl/engine'
import { shelfMove, shelfMoveIntoFolder, shelfMoveOut, shelfTiles } from './homeShelf'

const sp = (id: string): SpaceDefinition => ({ id, name: id, build() {} } as unknown as SpaceDefinition)
const order = () => useRibbonStore.getState().order
const folders = () => useRibbonStore.getState().folders

beforeEach(() => {
  useSpaceStore.setState({ spaces: ['home', 'tangu', 'amadeus', 'calendar'].map(sp) })
  useRibbonStore.setState({ items: [], order: ['space:home', 'space:tangu', 'space:amadeus', 'space:calendar'], bottomOrder: [], folders: [], commandItems: [], commandIcons: {} })
})

// 内置主页与 ctx.spaces.shelf 共用的那两条不变式(主页插件化 S3 把它们从 HomepageView 搬出来)
describe('收纳架 = Ribbon 上区的另一个投影', () => {
  it('架上不画主页自己,但顺序里它还占着第一格', () => {
    const { tiles, topIds } = shelfTiles(useSpaceStore.getState().spaces, order(), folders(), 'home')
    expect(tiles.map((t) => t.id)).toEqual(['space:tangu', 'space:amadeus', 'space:calendar'])
    expect(topIds[0]).toBe('space:home')
  })

  it('拖一格:主页不从持久序里掉出去(否则下次它落进 Ribbon 的「…」)', () => {
    shelfMove('space:calendar', 'space:tangu')
    expect(order()).toEqual(['space:home', 'space:calendar', 'space:tangu', 'space:amadeus'])
  })

  it('收进收纳夹再解散:同一个 id 在顺序里只出现一次', () => {
    useRibbonStore.getState().addFolder('top', 'Work')
    const folder = folders()[0]!.id
    shelfMoveIntoFolder(folder, 'space:amadeus')
    expect(order()).not.toContain('space:amadeus')
    shelfMove('space:calendar', 'space:tangu') // 夹内成员不能被当成顶层项写回
    expect(order()).not.toContain('space:amadeus')
    useRibbonStore.getState().removeFolder(folder)
    expect(order().filter((id) => id === 'space:amadeus')).toHaveLength(1)
  })

  it('移出收纳夹 = 回到顶层序末尾', () => {
    useRibbonStore.getState().addFolder('top', 'Work')
    const folder = folders()[0]!.id
    shelfMoveIntoFolder(folder, 'space:tangu')
    shelfMoveOut('space:tangu')
    expect(folders()[0]!.items).toEqual([])
    expect(order().at(-1)).toBe('space:tangu')
  })
})
