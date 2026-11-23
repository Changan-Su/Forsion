// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 记录有模块级缓存:每条用例重新载入模块,从干净的 localStorage 开始
// 第一次载入要编译 appStore 那一串(高负载下 4–5s),单条放宽到 30s
vi.setConfig({ testTimeout: 30_000 })
const load = async () => { vi.resetModules(); return import('./btwRelay') }

describe('splitRelay', () => {
  it('拆出末尾的 relay 块,块前的字照常显示', async () => {
    const { splitRelay } = await load()
    const r = splitRelay('好,我拟了一句:\n\n```relay\n把运算符表按长度倒序排。\n```')
    expect(r).toEqual({ body: '好,我拟了一句:', relay: '把运算符表按长度倒序排。' })
  })
  it('块后面还有字也留着;多个块取最后一个', async () => {
    const { splitRelay } = await load()
    const r = splitRelay('a\n```relay\nfirst\n```\nb\n```relay\nsecond\n```\nc')
    expect(r.relay).toBe('second')
    expect(r.body).toBe('a\n```relay\nfirst\n```\nb\n\nc')
  })
  it('普通代码块不当传话;没有块原样返回', async () => {
    const { splitRelay } = await load()
    expect(splitRelay('```ts\nconst a = 1\n```')).toEqual({ body: '```ts\nconst a = 1\n```' })
    expect(splitRelay('just text')).toEqual({ body: 'just text' })
  })
  it('还在流、块没闭合:先藏起来标 partial;流完还没闭合就当正文', async () => {
    const { splitRelay } = await load()
    expect(splitRelay('拟稿:\n```relay\n把运算', true)).toEqual({ body: '拟稿:', partial: true })
    expect(splitRelay('拟稿:\n```relay\n把运算', false)).toEqual({ body: '拟稿:\n```relay\n把运算' })
  })
  it('CRLF 换行也认', async () => {
    const { splitRelay } = await load()
    expect(splitRelay('好:\r\n```relay\r\n改一下\r\n```\r\n').relay).toBe('改一下')
  })
  it('空块不出卡;大小写 / 行首空格都认', async () => {
    const { splitRelay } = await load()
    expect(splitRelay('x\n```relay\n\n```').relay).toBeUndefined()
    expect(splitRelay('x\n  ```Relay\nhi\n  ```').relay).toBe('hi')
  })
})

describe('splitRelay 只认顶层围栏', () => {
  it('四个反引号 / 波浪号包着的 relay 示例不当稿,原样留在正文', async () => {
    const { splitRelay } = await load()
    const ex = '格式是这样:\n````md\n```relay\n示例\n```\n````\n就这些'
    expect(splitRelay(ex)).toEqual({ body: ex })
    const tilde = '~~~\n```relay\n示例\n```\n~~~'
    expect(splitRelay(tilde)).toEqual({ body: tilde })
    // 示例之后真有一个顶层块:取那个,示例原样
    const both = `${ex}\n\n\`\`\`relay\n真的那句\n\`\`\``
    expect(splitRelay(both)).toEqual({ body: ex, relay: '真的那句' })
  })
  it('普通代码块后面的 relay 照认;流着时示例里的未闭合 relay 不当 partial', async () => {
    const { splitRelay } = await load()
    expect(splitRelay('```ts\nx\n```\n```relay\nhi\n```').relay).toBe('hi')
    expect(splitRelay('看:\n````\n```relay\n写到一半', true)).toEqual({ body: '看:\n````\n```relay\n写到一半' })
  })
  it('缩进 4 格的围栏行是代码行,不闭合外层(Codex 复审)', async () => {
    const { splitRelay } = await load()
    const ex = '````md\n    ````\n```relay\n示例\n```\n````'
    expect(splitRelay(ex)).toEqual({ body: ex })
  })
})

describe('撤回 / 退回的插话撤掉「已发」', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())
  it('从等待区撤回:记录撤掉,卡片恢复可发、小标不画;别的会话的同字记录不动', async () => {
    const m = await load()
    const { useApp } = await import('../../stores/appStore')
    const { notifySteerDropped } = await import('../../tangu/store/steerDropped')
    useApp.setState({ messagesBySession: {} } as never)
    m.recordRelay({ to: 's1', from: 's0', asideId: 'a1', text: 'check tests', at: Date.now(), how: 'steer' })
    m.recordRelay({ to: 's2', from: 's0', asideId: 'a1', text: 'check tests', at: Date.now() + 1, how: 'steer' })
    notifySteerDropped('s1', [{ id: 'q-x', text: 'check  tests' }])
    expect(m.relayFor('s1', 'check tests')).toBeUndefined()
    expect(m.relayFor('s2', 'check tests')).toBeDefined()
    expect(JSON.parse(localStorage.getItem('forsion_btw_relays_v1') || '[]')).toHaveLength(1)
  })
  it('同一句早先已经落进对话:撤回的是用户另打的那句,记录留着', async () => {
    const m = await load()
    const { useApp } = await import('../../stores/appStore')
    const { notifySteerDropped } = await import('../../tangu/store/steerDropped')
    const at = Date.now()
    useApp.setState({ messagesBySession: { s1: [{ id: 'u1', role: 'user', content: 'check tests', status: 'done', timestamp: at + 50 }] } } as never)
    m.recordRelay({ to: 's1', from: 's0', text: 'check tests', at, how: 'steer' })
    notifySteerDropped('s1', [{ id: 'q-x', text: 'check tests' }])
    expect(m.relayFor('s1', 'check tests')).toBeDefined()
    // 早于这笔记录的同字消息不算送达(Codex 复审):撤回照撤
    useApp.setState({ messagesBySession: { s1: [{ id: 'u0', role: 'user', content: 'check tests', status: 'done', timestamp: at - 30_000 }] } } as never)
    notifySteerDropped('s1', [{ id: 'q-x', text: 'check tests' }])
    expect(m.relayFor('s1', 'check tests')).toBeUndefined()
  })
  it('同一句从两段顺便问各插话一次:撤回哪项就撤哪笔(按等待项 id)', async () => {
    const m = await load()
    const { useApp } = await import('../../stores/appStore')
    const { notifySteerDropped } = await import('../../tangu/store/steerDropped')
    const pending: Array<{ id: string; text: string }> = []
    const send = vi.fn(async (text: string) => { pending.push({ id: `steer-${pending.length + 1}`, text }); useApp.setState({ steerPendingBySession: { s1: [...pending] } } as never); return true })
    useApp.setState({ send, runningBySession: { s1: 'r1' }, messagesBySession: {}, steerPendingBySession: {} } as never)
    await m.sendRelay({ from: 's0', to: 's1', asideId: 'a1', text: 'check tests' })
    await m.sendRelay({ from: 's0', to: 's1', asideId: 'a2', text: 'check tests' })
    useApp.setState({ steerPendingBySession: { s1: [pending[1]] } } as never)
    notifySteerDropped('s1', [{ id: 'steer-1', text: 'check tests' }])
    expect(m.relaySentFrom('s0', 'check tests', 'a1')).toBeUndefined()
    expect(m.relaySentFrom('s0', 'check tests', 'a2')?.pendingId).toBe('steer-2')
  })
})

describe('传话记录', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('记下之后按 会话 + 正文 认(空白差异不算),别的会话不认', async () => {
    const { recordRelay, relayFor, relaySentFrom } = await load()
    recordRelay({ to: 's1', from: 's1', asideId: 'x1', text: '改一下 运算符表', at: 1, how: 'sent' })
    expect(relayFor('s1', '改一下\n运算符表')?.asideId).toBe('x1')
    expect(relayFor('s2', '改一下 运算符表')).toBeUndefined()
    expect(relaySentFrom('s1', '改一下 运算符表')?.to).toBe('s1')
  })
  it('写进 localStorage,重新载入还在;坏数据当空', async () => {
    let m = await load()
    m.recordRelay({ to: 's1', from: 's1', text: 'hello', at: 1, how: 'steer' })
    m = await load()
    expect(m.relayFor('s1', 'hello')?.how).toBe('steer')
    localStorage.setItem('forsion_btw_relays_v1', '{not json')
    m = await load()
    expect(m.relayFor('s1', 'hello')).toBeUndefined()
  })
  it('写前从 localStorage 重读:别的窗口刚写的那条不被本窗口的旧缓存盖掉', async () => {
    const { recordRelay, relayFor } = await load()
    expect(relayFor('s1', 'x')).toBeUndefined() // 先把缓存读成空的
    localStorage.setItem('forsion_btw_relays_v1', JSON.stringify([{ to: 's9', from: 's9', text: 'other window', at: 5, how: 'sent' }]))
    recordRelay({ to: 's1', from: 's1', text: 'mine', at: 6, how: 'sent' })
    expect(JSON.parse(localStorage.getItem('forsion_btw_relays_v1') || '[]').map((r: { text: string }) => r.text)).toEqual(['other window', 'mine'])
  })
  it('小标:比记录早两分钟以上的同字老消息不认;卡片:两边都有段 id 时要对上', async () => {
    const { recordRelay, relayFor, relaySentFrom } = await load()
    recordRelay({ to: 's1', from: 's1', asideId: 'a1', text: 'check the tests', at: 1_000_000, how: 'sent' })
    expect(relayFor('s1', 'check the tests', 1_000_500)).toBeDefined()
    expect(relayFor('s1', 'check the tests', 1_000_000 - 5 * 60_000)).toBeUndefined()
    expect(relaySentFrom('s1', 'check the tests', 'a1')).toBeDefined()
    expect(relaySentFrom('s1', 'check the tests', 'a2')).toBeUndefined()
  })
})

describe('sendRelay', () => {
  beforeEach(() => localStorage.clear())
  it('主对话没在跑 = 普通发送;在跑 = 插话;发失败不留记录', async () => {
    const m = await load()
    const { useApp } = await import('../../stores/appStore')
    const send = vi.fn().mockResolvedValue(true)
    useApp.setState({ send, runningBySession: {} } as never)
    expect(await m.sendRelay({ from: 's1', to: 's1', text: '  do it  ' })).toBe('sent')
    expect(send).toHaveBeenCalledWith('do it', [], undefined, undefined, undefined, 's1')
    useApp.setState({ runningBySession: { s2: 'r1' } } as never)
    expect(await m.sendRelay({ from: 's1', to: 's2', text: 'steer me' })).toBe('steer')
    send.mockResolvedValueOnce(false)
    expect(await m.sendRelay({ from: 's1', to: 's1', text: 'fails' })).toBeNull()
    expect(m.relayFor('s1', 'fails')).toBeUndefined()
    // 同一句重发失败:之前那条成功的记录还在
    send.mockResolvedValueOnce(false)
    expect(await m.sendRelay({ from: 's1', to: 's1', text: 'do it' })).toBeNull()
    expect(m.relayFor('s1', 'do it')?.how).toBe('sent')
    expect(m.relayFor('s2', 'steer me')?.how).toBe('steer')
  })
})
