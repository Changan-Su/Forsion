import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetObjectsForTest, buildObjectMenu, executeAction, freezeRefs, objectActions, openObject, registerObjectAction, registerObjectType,
  setObjectHost, OBJECT_REASON, type ObjectAction, type ObjectContext, type ObjectRef, type ObjectTypeDefinition,
} from './objects'
import { __resetObjectFocusForTest, claimObjectFocus, focusedObjects } from './objectFocus'

const CX: ObjectContext = { place: { kind: 'test' }, caps: { openWindow: true, desktopShortcut: false, pinHome: false, revealFile: false, singleColumn: false } }
const sp = (id: string): ObjectRef => ({ type: 'space', id })

/** 一个可变的小世界:哪些 Space 在、各自版本号。 */
let world: Map<string, number>
const spaceType = (over: Partial<ObjectTypeDefinition> = {}): ObjectTypeDefinition => ({
  type: 'space',
  label: () => 'Space',
  isValidId: (id) => /^[a-z]+$/.test(id),
  info: (r) => (world.has(r.id) ? { title: r.id } : undefined),
  openModes: ['here', 'newWindow'],
  open: vi.fn(),
  snapshot: (r) => world.get(r.id),
  verify: (r, snap) => (!world.has(r.id) ? 'gone' : world.get(r.id) !== snap ? 'changed' : null),
  ...over,
})
const act = (over: Partial<ObjectAction> & Pick<ObjectAction, 'id'>): ObjectAction => ({
  types: ['space'],
  title: () => over.id,
  group: 'open',
  run: vi.fn(),
  ...over,
})

let reported: { failures: unknown[]; what: string }[]
let confirmAnswer: boolean | (() => Promise<boolean>)
beforeEach(() => {
  __resetObjectsForTest()
  __resetObjectFocusForTest()
  world = new Map([['tangu', 1], ['home', 1], ['notes', 1]])
  reported = []
  confirmAnswer = true
  setObjectHost({
    caps: () => CX.caps,
    confirm: () => (typeof confirmAnswer === 'function' ? confirmAnswer() : Promise.resolve(confirmAnswer)),
    report: (failures, what) => { reported.push({ failures, what }) },
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

describe('注册表', () => {
  it('同 type / 同动作 id 先到先得,后来的不覆盖;dispose 只摘自己那份', () => {
    const a = spaceType()
    const offA = registerObjectType(a)
    const offB = registerObjectType(spaceType({ label: () => 'other' }))
    offB() // 后来的那份没登记上,摘它不影响前一份
    registerObjectAction(act({ id: 'x', title: () => 'first' }))
    registerObjectAction(act({ id: 'x', title: () => 'second' }))
    expect(objectActions([sp('tangu')], CX).map((x) => x.title([], CX))).toEqual(['first'])
    offA()
    expect(objectActions([sp('tangu')], CX)).toEqual([]) // 类型没了,动作也不列
  })

  it('按组 → order → 登记序排;多选只列 multi 的;when 抛错当不列', () => {
    registerObjectType(spaceType())
    registerObjectAction(act({ id: 'del', group: 'danger', multi: true }))
    registerObjectAction(act({ id: 'win', group: 'open', order: 2 }))
    registerObjectAction(act({ id: 'open', group: 'open', order: 1, multi: true }))
    registerObjectAction(act({ id: 'boom', group: 'edit', when: () => { throw new Error('x') } }))
    registerObjectAction(act({ id: 'note-only', types: ['note'] }))
    expect(objectActions([sp('tangu')], CX).map((a) => a.id)).toEqual(['open', 'win', 'del'])
    expect(objectActions([sp('tangu'), sp('home')], CX).map((a) => a.id)).toEqual(['open', 'del'])
  })
})

describe('buildObjectMenu', () => {
  beforeEach(() => {
    registerObjectType(spaceType())
    registerObjectAction(act({ id: 'open', group: 'open' }))
    registerObjectAction(act({ id: 'desk', group: 'share' }))
    registerObjectAction(act({ id: 'del', group: 'danger' }))
    registerObjectAction(act({ id: 'pin', group: 'organize', disabledReason: () => 'nope' }))
  })

  it('打开 → 编辑 → 整理 → 本处 → 分享 → 危险,空组不出;危险组标红;灰掉的带原因', () => {
    const m = buildObjectMenu({ refs: [sp('tangu')], place: { kind: 'ribbon' }, placeSections: [{ title: 'Here', items: [{ id: 'mv', label: 'Move out', run: () => {} }] }] })
    expect(m.sections.map((s) => s.items.map((i) => i.id))).toEqual([['open'], ['pin'], ['mv'], ['desk'], ['del']])
    expect(m.sections[4].items[0].danger).toBe(true)
    expect(m.sections[1].items[0]).toMatchObject({ disabled: true, detail: 'nope' })
  })

  it('没有对象、只有本处项也能出菜单(Ribbon 空白处那种)', () => {
    const m = buildObjectMenu({ refs: [], place: { kind: 'ribbon' }, placeSections: [{ items: [{ id: 'n', label: 'New', run: () => {} }] }] })
    expect(m.sections.map((s) => s.items.map((i) => i.id))).toEqual([['n']])
  })

  it('目标在弹菜单那一刻冻结:之后对象被换掉(同 id 新版本),点下去不执行', async () => {
    const run = vi.fn()
    registerObjectAction(act({ id: 'go', group: 'edit', run }))
    const m = buildObjectMenu({ refs: [sp('tangu')], place: { kind: 'ribbon' } })
    world.set('tangu', 2) // 改名后旧 id 被一个新的同名对象占了
    m.sections.flatMap((s) => s.items).find((i) => i.id === 'go')!.run!()
    await new Promise((r) => setTimeout(r, 0))
    expect(run).not.toHaveBeenCalled()
    expect(reported).toEqual([{ failures: [{ ref: sp('tangu'), ok: false, reason: 'changed' }], what: 'go' }])
  })
})

describe('executeAction', () => {
  beforeEach(() => { registerObjectType(spaceType()) })

  it('确认取消:不执行、不上报', async () => {
    const run = vi.fn()
    registerObjectAction(act({ id: 'del', group: 'danger', run, confirm: () => ({ title: 'Delete?', confirm: 'Delete', danger: true }) }))
    confirmAnswer = false
    const out = await executeAction('del', freezeRefs([sp('tangu')]), CX)
    expect(run).not.toHaveBeenCalled()
    expect(out).toEqual([{ ref: sp('tangu'), ok: false, reason: OBJECT_REASON.cancelled }])
    expect(reported).toEqual([])
  })

  it('确认框开着时对象被删了:确认后再验一次,不执行', async () => {
    const run = vi.fn()
    registerObjectAction(act({ id: 'del', group: 'danger', run, confirm: () => ({ title: 'Delete?', confirm: 'Delete' }) }))
    confirmAnswer = () => { world.delete('tangu'); return Promise.resolve(true) }
    const out = await executeAction('del', freezeRefs([sp('tangu')]), CX)
    expect(run).not.toHaveBeenCalled()
    expect(out).toEqual([{ ref: sp('tangu'), ok: false, reason: 'gone' }])
  })

  it('连点:同一动作同一目标在途时,第二次不执行、不上报', async () => {
    let release!: () => void
    const run = vi.fn(() => new Promise<void>((r) => { release = r }))
    registerObjectAction(act({ id: 'slow', run }))
    const first = executeAction('slow', [sp('tangu')], CX)
    await new Promise((r) => setTimeout(r, 0))
    const second = await executeAction('slow', [sp('tangu')], CX)
    expect(second[0]).toMatchObject({ ok: false, reason: OBJECT_REASON.busy })
    release()
    expect(await first).toEqual([{ ref: sp('tangu'), ok: true }])
    expect(run).toHaveBeenCalledTimes(1)
    expect(reported).toEqual([])
  })

  it('多选部分失败:还在的照常执行,逐项返回,失败的上报', async () => {
    const run = vi.fn()
    registerObjectAction(act({ id: 'del', group: 'danger', multi: true, run }))
    const frozen = freezeRefs([sp('tangu'), sp('home')])
    world.delete('home')
    const out = await executeAction('del', frozen, CX)
    expect(run).toHaveBeenCalledWith([sp('tangu')], { ...CX, batch: 2 })
    expect(out).toEqual([{ ref: sp('tangu'), ok: true }, { ref: sp('home'), ok: false, reason: 'gone' }])
    expect(reported[0].failures).toEqual([{ ref: sp('home'), ok: false, reason: 'gone' }])
  })

  it('run 抛错 = 全部失败并上报;when 此刻不成立 = 不可用', async () => {
    registerObjectAction(act({ id: 'bad', run: () => { throw new Error('disk full') } }))
    expect(await executeAction('bad', [sp('tangu')], CX)).toEqual([{ ref: sp('tangu'), ok: false, reason: 'disk full' }])
    let allow = true
    const run = vi.fn()
    registerObjectAction(act({ id: 'gated', run, when: () => allow }))
    allow = false
    expect((await executeAction('gated', [sp('tangu')], CX))[0]).toMatchObject({ ok: false, reason: OBJECT_REASON.unavailable })
    expect(run).not.toHaveBeenCalled()
  })

  it('不合法的 id 不执行', async () => {
    const run = vi.fn()
    registerObjectAction(act({ id: 'go', run }))
    expect((await executeAction('go', [sp('../x')], CX))[0]).toMatchObject({ ok: false, reason: OBJECT_REASON.unavailable })
    expect(run).not.toHaveBeenCalled()
  })
})

describe('executeAction 的批量信息', () => {
  it('滤掉不在了的之后,confirm / run 仍知道当初一共选了几个', async () => {
    const seen: Array<[number, number | undefined]> = []
    registerObjectType(spaceType())
    registerObjectAction(act({ id: 'del', multi: true, confirm: (refs, cx) => { seen.push([refs.length, cx.batch]); return undefined }, run: () => {} }))
    await executeAction('del', [sp('tangu'), sp('ghost')], CX)
    expect(seen).toEqual([[1, 2]])
  })
})

describe('openObject', () => {
  it('不支持的打开方式、不在的对象都不打开;open 抛错 = 失败', async () => {
    const open = vi.fn()
    registerObjectType(spaceType({ open }))
    expect((await openObject(sp('tangu'), 'beside')).ok).toBe(false)
    expect((await openObject(sp('ghost'))).ok).toBe(false)
    expect(open).not.toHaveBeenCalled()
    expect(await openObject(sp('tangu'), 'newWindow')).toEqual({ ref: sp('tangu'), ok: true })
    expect(open).toHaveBeenCalledWith(sp('tangu'), 'newWindow', expect.objectContaining({ place: { kind: 'api' } }))
    open.mockImplementationOnce(() => { throw new Error('locked') })
    expect(await openObject(sp('tangu'))).toEqual({ ref: sp('tangu'), ok: false, reason: 'locked' })
  })

  it('同步的类型同步打开:调用返回时已经开好(插件打开 Space 后紧接着在那里开视图)', () => {
    const open = vi.fn()
    registerObjectType(spaceType({ open }))
    void openObject(sp('tangu'))
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('verify 返回 Promise 时等它;verify 抛错 = 失败,不打开', async () => {
    const open = vi.fn()
    registerObjectType(spaceType({ open, verify: () => Promise.resolve('gone') }))
    expect(await openObject(sp('tangu'))).toEqual({ ref: sp('tangu'), ok: false, reason: 'gone' })
    __resetObjectsForTest()
    registerObjectType(spaceType({ open, verify: () => { throw new Error('boom') } }))
    expect(await openObject(sp('tangu'))).toEqual({ ref: sp('tangu'), ok: false, reason: 'boom' })
    expect(open).not.toHaveBeenCalled()
  })
})

describe('objectFocus', () => {
  it('谁申领谁释放:旧组件卸载不清掉新组件的焦点', () => {
    const a = claimObjectFocus('w', [sp('tangu')], { kind: 'tree' })
    const b = claimObjectFocus('w', [sp('home')], { kind: 'organizer' })
    expect(focusedObjects('w')?.refs).toEqual([sp('home')])
    a.release()
    expect(focusedObjects('w')?.refs).toEqual([sp('home')])
    a.release() // 重复释放无害
    b.update([sp('notes')])
    expect(focusedObjects('w')).toEqual({ refs: [sp('notes')], place: { kind: 'organizer' } })
    b.release()
    expect(focusedObjects('w')).toBeNull()
  })

  it('activate 把自己挪到最上面;选中为空 = 对着空,不往下找', () => {
    const a = claimObjectFocus('w', [sp('tangu')], { kind: 'tree' })
    const b = claimObjectFocus('w', [], { kind: 'organizer' })
    expect(focusedObjects('w')).toBeNull()
    a.activate()
    expect(focusedObjects('w')?.refs).toEqual([sp('tangu')])
    expect(focusedObjects('other')).toBeNull()
    b.release()
  })
})
