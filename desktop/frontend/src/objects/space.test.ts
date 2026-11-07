// Space 对象的菜单在各处长什么样(LCL 对象层第一期)。各界面只给「本处」那一节,对象那几项来自这一份定义 ——
// 这里钉住:能力(caps)不同、当前在不在它里面、是不是用户自己建的,各列哪几项;删除要确认、失败不重复上报。
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { deleteUserSpace } = vi.hoisted(() => ({ deleteUserSpace: vi.fn(async (_id: string) => true) }))
vi.mock('../userSpaces', () => ({ isUserSpace: (id: string) => id.startsWith('u-'), deleteUserSpace }))

import { buildObjectMenu, executeAction, openObject, setObjectHost, useSpaceStore, type ObjectCaps, type SpaceDefinition } from '@lcl/engine'
import { installSpaceObject, spaceRef } from './space'

const CAPS: ObjectCaps = { openWindow: true, desktopShortcut: true, pinHome: false, revealFile: false, singleColumn: false }
const PHONE: ObjectCaps = { openWindow: false, desktopShortcut: false, pinHome: true, revealFile: false, singleColumn: true }
const space = (id: string, name: string): SpaceDefinition => ({ id, name, build: () => {}, sidebarDefaults: {} } as unknown as SpaceDefinition)

let caps = CAPS
const confirm = vi.fn(async (_req: unknown) => true)
const report = vi.fn()

beforeAll(() => {
  setObjectHost({ caps: () => caps, confirm, report })
  installSpaceObject()
})
beforeEach(() => {
  caps = CAPS
  confirm.mockClear(); report.mockClear(); deleteUserSpace.mockClear()
  useSpaceStore.setState({ spaces: [space('home', '主页'), space('tangu', 'Tangu'), space('u-reading', '读书')], activeSpaceId: 'home' })
})

const ids = (id: string, place = { kind: 'ribbon' }, extra: { id: string; label: string }[] = []): string[][] =>
  buildObjectMenu({ refs: [spaceRef(id)], place, placeSections: extra.length ? [{ items: extra }] : [] }).sections.map((s) => s.items.map((i) => i.id))
const labels = (id: string): string[] =>
  buildObjectMenu({ refs: [spaceRef(id)], place: { kind: 'ribbon' } }).sections.flatMap((s) => s.items.map((i) => i.label))

describe('Space 对象菜单', () => {
  it('电脑主窗口,用户自己建的另一个 Space:打开 / 新窗口 / 添加到桌面 / 删除,分组排好', () => {
    expect(ids('u-reading')).toEqual([['space.open', 'space.openInNewWindow'], ['space.addToDesktop'], ['space.delete']])
    expect(labels('u-reading')).toEqual(['打开', '在新窗口中打开', '添加到桌面', '删除 Space…'])
  })

  it('当前就在它里面不列「打开」;插件带来的 Space 不列删除', () => {
    expect(ids('home')).toEqual([['space.openInNewWindow'], ['space.addToDesktop']])
  })

  it('本处那一节插在「整理」之后、「分享」之前(收纳夹里的「移出收纳夹」)', () => {
    expect(ids('tangu', { kind: 'organizer' }, [{ id: 'move-out', label: '移出收纳夹' }]))
      .toEqual([['space.open', 'space.openInNewWindow'], ['move-out'], ['space.addToDesktop']])
  })

  it('手机:没有新窗口;「添加到桌面」换成「添加到主屏幕」', () => {
    caps = PHONE
    expect(ids('tangu')).toEqual([['space.open'], ['space.addToDesktop']])
    expect(labels('tangu')).toEqual(['打开', '添加到主屏幕'])
  })

  it('不存在的 Space 不打开,报一次', async () => {
    const r = await openObject(spaceRef('ghost'))
    expect(r.ok).toBe(false)
    expect(report).toHaveBeenCalledTimes(1)
    expect(useSpaceStore.getState().activeSpaceId).toBe('home')
  })
})

describe('删除 Space', () => {
  it('先确认;确认了才删', async () => {
    confirm.mockResolvedValueOnce(false)
    expect((await executeAction('space.delete', [spaceRef('u-reading')], { place: { kind: 'ribbon' }, caps }))[0]).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(deleteUserSpace).not.toHaveBeenCalled()
    expect((await executeAction('space.delete', [spaceRef('u-reading')], { place: { kind: 'ribbon' }, caps }))[0]).toMatchObject({ ok: true })
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(confirm.mock.calls[1]?.[0]).toMatchObject({ danger: true })
    expect(deleteUserSpace).toHaveBeenCalledWith('u-reading')
  })

  it('删除失败时 deleteUserSpace 自己提示过,这里不再报一次', async () => {
    deleteUserSpace.mockResolvedValueOnce(false)
    expect((await executeAction('space.delete', [spaceRef('u-reading')], { place: { kind: 'ribbon' }, caps }))[0]).toMatchObject({ ok: false, reason: 'reported' })
    expect(report).not.toHaveBeenCalled()
  })

  it('插件带来的 Space 删不了(when 不过 = 不执行)', async () => {
    expect((await executeAction('space.delete', [spaceRef('tangu')], { place: { kind: 'ribbon' }, caps }))[0]).toMatchObject({ ok: false })
    expect(deleteUserSpace).not.toHaveBeenCalled()
  })
})
