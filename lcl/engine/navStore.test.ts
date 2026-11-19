/** per-tab 导航历史:栈按 leafId 隔离、去重、前进截断、drop/reset 清理。 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useNav, type NavEntry } from './navStore'

const nav = () => useNav.getState()
const entry = (key: string, log: string[]) => ({ key, restore: () => { log.push(key) } })

describe('navStore per-leaf', () => {
  beforeEach(() => useNav.getState().reset())

  it('栈按 leaf 隔离,back 只动本 leaf', () => {
    const log: string[] = []
    nav().record('A', entry('a1', log))
    nav().record('A', entry('a2', log))
    nav().record('B', entry('b1', log))
    nav().back('A')
    expect(log).toEqual(['a1'])
    expect(nav().stacks.A.idx).toBe(0)
    expect(nav().stacks.B.idx).toBe(0) // B 不受影响
  })

  it('同 key 去重;新记录截断 forward', async () => {
    const log: string[] = []
    nav().record('A', entry('a1', log))
    nav().record('A', entry('a1', log)) // 去重
    expect(nav().stacks.A.entries).toHaveLength(1)
    nav().record('A', entry('a2', log))
    nav().back('A')
    await Promise.resolve() // navigating 闸在 restore 的 finally(microtask)后才放开
    nav().record('A', entry('a3', log)) // 在 idx0 处压入 → a2 被截断
    expect(nav().stacks.A.entries.map((e) => e.key)).toEqual(['a1', 'a3'])
  })

  it('restore 期间 navigating 闸:restore 内的 record 不入栈', async () => {
    const log: string[] = []
    nav().record('A', { key: 'a1', restore: () => { nav().record('A', entry('ax', log)) } })
    nav().record('A', entry('a2', log))
    nav().back('A') // 触发 a1.restore → 其内 record 应被闸
    await Promise.resolve()
    expect(nav().stacks.A.entries.map((e) => e.key)).toEqual(['a1', 'a2'])
  })

  // 用户实报「有时候前进失效」的一条:真 restore 是异步的(loadPage / 引擎装载),连按两次后退时
  // 两个 restore 会重叠。闸若是布尔量,先落地的那个 finally 会提前放开它,后一个 restore 的落点被当成
  // 「用户新导航」重记 → forward 段当场截断:退两步只能前进一步。故闸必须是计数。
  // ⚠️ 两个 restore 的耗时必须**不同**且交错(快的先完成、慢的还在跑):都一样长的话布尔量与计数
  //    表现完全一致,测试恒绿 = 没测到东西(本轮写反过一次,负对照才抓出来)。
  it('⚠️异步 restore 重叠期间闸不许提前放开(否则前进史被吃掉)', async () => {
    const log: string[] = []
    const after = (key: string, ms: number) => ({ key, restore: () => new Promise<void>((r) => setTimeout(r, ms)).then(() => { log.push(key) }) })
    nav().record('A', after('a1', 80)) // 后按的那次退回它 —— 慢
    nav().record('A', after('a2', 5))  // 先按的那次退回它 —— 快
    nav().record('A', after('a3', 5))
    nav().back('A') // → 复原 a2(5ms 就结束)
    nav().back('A') // → 复原 a1(80ms),与上一个重叠
    await new Promise((r) => setTimeout(r, 30)) // 此刻 a2 已完成、a1 仍在跑:布尔闸在这里就开了
    nav().record('A', entry('intruder', log)) // 仍属复原过程 → 必须被闸掉
    await new Promise((r) => setTimeout(r, 120))
    expect(nav().stacks.A.entries.map((e) => e.key)).toEqual(['a1', 'a2', 'a3'])
    nav().forward('A')
    await new Promise((r) => setTimeout(r, 30))
    nav().forward('A')
    await new Promise((r) => setTimeout(r, 30))
    expect(nav().stacks.A.idx).toBe(2) // 退两步后仍能前进两步回到 a3
  })

  it('越界 back/forward 与未知 leaf 均 no-op', () => {
    const log: string[] = []
    nav().back('missing')
    nav().record('A', entry('a1', log))
    nav().back('A') // idx0 → 无更早
    nav().forward('A') // 顶端 → 无更新
    expect(log).toEqual([])
  })

  it('drop 删栈;reset 清全部', () => {
    const log: string[] = []
    nav().record('A', entry('a1', log))
    nav().record('B', entry('b1', log))
    nav().drop('A')
    expect(nav().stacks.A).toBeUndefined()
    expect(nav().stacks.B).toBeDefined()
    nav().reset()
    expect(Object.keys(nav().stacks)).toHaveLength(0)
  })
})

describe('remapNav(条目指向的东西改名 / 挪走 / 删掉之后改写历史)', () => {
  beforeEach(() => useNav.getState().reset())
  const keys = (id: string) => nav().stacks[id].entries.map((e) => e.key)

  it('改名:原位换 key 与复原,不另起一条;之后再记新 key 只替换当前那条(新建 → 改标题 → 返回不落到旧路径)', async () => {
    const { remapNav } = await import('./navStore')
    const log: string[] = []
    nav().record('A', entry('note:untitled.md', log))
    remapNav((_, e) => (e.key === 'note:untitled.md' ? entry('note:购物清单.md', log) : undefined))
    nav().record('A', entry('note:购物清单.md', log)) // 视图跟到新路径后照常记的那一下
    expect(keys('A')).toEqual(['note:购物清单.md'])
    expect(nav().stacks.A.idx).toBe(0)
  })

  it('删掉:拿掉那条,游标停在原来那条(被拿掉时退到它前面那条);两边留下的同 key 并成一条', async () => {
    const { remapNav } = await import('./navStore')
    const log: string[] = []
    for (const k of ['a', 'dead', 'a', 'b']) nav().record('A', entry(k, log))
    expect(nav().stacks.A.idx).toBe(3)
    remapNav((_, e) => (e.key === 'dead' ? null : undefined))
    expect(keys('A')).toEqual(['a', 'b'])
    expect(nav().stacks.A.idx).toBe(1)
    for (const k of ['c', 'gone']) nav().record('A', entry(k, log))
    remapNav((_, e) => (e.key === 'gone' ? null : undefined))
    expect(keys('A')).toEqual(['a', 'b', 'c'])
    expect(nav().stacks.A.idx).toBe(2)
    nav().back('A')
    await Promise.resolve()
    expect(log).toEqual(['b'])
  })

  it('只改当前布局的历史:停放的 Space 连布局带历史原样(别的库里同名改名碰不到它);没碰到的栈原样(同一个对象)', async () => {
    const { remapNav, beginNavSpace, finishNavSpace } = await import('./navStore')
    const log: string[] = []
    nav().record('A', entry('old', log))
    beginNavSpace('s1', 's2')
    finishNavSpace()
    nav().record('B', entry('x', log))
    const before = nav().stacks.B
    remapNav((_, e) => (e.key === 'old' ? entry('new', log) : undefined))
    expect(nav().stacks.B).toBe(before)
    beginNavSpace('s2', 's1')
    finishNavSpace()
    expect(keys('A')).toEqual(['old'])
  })

  it('改写时有还原在途:叫停它,游标回到正在显示的那条(不停在半路要去的那条上)', async () => {
    const { remapNav } = await import('./navStore')
    const log: string[] = []
    let release: () => void = () => {}
    const slow = (key: string): NavEntry => ({ key, restore: () => new Promise<void>((r) => { release = () => { log.push(key); r() } }) })
    nav().record('A', entry('a', log))
    nav().record('A', slow('b'))
    nav().record('A', entry('c', log))
    nav().back('A') // 去 b,b 慢慢加载
    expect(nav().stacks.A.idx).toBe(1)
    remapNav((_, e) => (e.key === 'a' ? null : undefined)) // 期间删掉 a
    expect(keys('A')).toEqual(['b', 'c'])
    expect(nav().stacks.A.idx).toBe(1) // 回到 c:屏上还是 c
    release()
    await Promise.resolve(); await Promise.resolve()
    expect(nav().stacks.A.idx).toBe(1) // 叫停的那次不再把游标挪走
    nav().back('A')
    await Promise.resolve()
    expect(nav().stacks.A.idx).toBe(0) // 再按返回才去 b
  })
})
