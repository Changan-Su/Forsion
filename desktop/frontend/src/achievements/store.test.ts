import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { medalTier, seriesPoints, OFFICIAL_SERIES } from './definitions'
import { registerPluginSeries, track, unregisterPluginAchievements, useAchievements } from './store'

const KEY = 'forsion_tangu_achievements'
const mem = new Map<string, string>()

beforeEach(() => {
  mem.clear()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v) },
    removeItem: (k: string) => { mem.delete(k) },
  })
  useAchievements.setState({ counters: {}, claimed: {}, queue: [], pluginSeries: [] })
})
afterEach(() => vi.unstubAllGlobals())

describe('track 跨线检测', () => {
  it('goal=1 首次跨线入队一次,重复触发不再入队', () => {
    track('chat.send')
    expect(useAchievements.getState().queue).toEqual(['first-message'])
    track('chat.send')
    expect(useAchievements.getState().queue).toEqual(['first-message'])
    expect(useAchievements.getState().counters['chat.send']).toBe(2)
  })

  it('阶梯成就按 before<goal<=after 各只弹一次(一次跨两线也都入队)', () => {
    track('chat.send', 10)
    expect(useAchievements.getState().queue).toEqual(['first-message', 'chat-10'])
  })

  it('非法输入不计数', () => {
    track('', 1)
    track('chat.send', 0)
    track('chat.send', -5)
    expect(useAchievements.getState().counters['chat.send']).toBeUndefined()
    expect(useAchievements.getState().queue).toEqual([])
  })
})

describe('claim 与勋章', () => {
  it('未达成不可领;达成可领且幂等;点数按已领取计', () => {
    const chat = OFFICIAL_SERIES.find((s) => s.id === 'chat')!
    const { claim } = useAchievements.getState()
    claim('first-message')
    expect(useAchievements.getState().claimed['first-message']).toBeUndefined()
    track('chat.send', 10)
    useAchievements.getState().claim('first-message')
    useAchievements.getState().claim('first-message')
    useAchievements.getState().claim('chat-10')
    const st = useAchievements.getState()
    expect(st.claimed['first-message']).toBe(true)
    expect(seriesPoints(chat, st.claimed)).toBe(25) // 10+15
    expect(medalTier(chat, seriesPoints(chat, st.claimed))).toBe('bronze')
    expect(medalTier(chat, 70)).toBe('gold')
  })
})

describe('toast 队列', () => {
  it('shiftToast 只在 queue[0] 匹配时出队(animationend+timeout 双触发幂等)', () => {
    track('chat.send')
    track('note.create')
    const { shiftToast } = useAchievements.getState()
    shiftToast('first-note') // 不是队首,无效
    expect(useAchievements.getState().queue).toEqual(['first-message', 'first-note'])
    shiftToast('first-message')
    shiftToast('first-message') // 幂等
    expect(useAchievements.getState().queue).toEqual(['first-note'])
  })
})

describe('持久化合并', () => {
  it('save=读-合并-写:counter 取 max、claimed 并集;损坏数据回空', () => {
    mem.set(KEY, JSON.stringify({ v: 1, counters: { 'chat.send': 50 }, claimed: ['first-note'] }))
    track('chat.send') // 内存 0→1,磁盘 50 → 写回 max=50
    const disk = JSON.parse(mem.get(KEY)!)
    expect(disk.counters['chat.send']).toBe(50)
    expect(disk.claimed).toContain('first-note')

    mem.set(KEY, '{{{garbage')
    expect(() => track('chat.send')).not.toThrow()
  })
})

describe('插件系列', () => {
  it('注册强制 plugin:<id>: 前缀;ctx 事件跨线;反注册移除系列但计数保留', () => {
    registerPluginSeries('demo', {
      id: 'quest', title: 'Demo Quests',
      achievements: [{ id: 'hi', title: 'Hi', desc: 'say hi', event: 'hi', goal: 1, points: 5 }],
    })
    const ps = useAchievements.getState().pluginSeries
    expect(ps).toHaveLength(1)
    expect(ps[0].def.id).toBe('plugin:demo:quest')
    expect(ps[0].def.achievements[0].event).toBe('plugin:demo:hi')
    expect(ps[0].def.medals.gold).toBe(5) // 缺省勋章=按总点数推导

    track('plugin:demo:hi') // 宿主 ctx.track 会加同样前缀
    expect(useAchievements.getState().queue).toEqual(['plugin:demo:hi'])

    unregisterPluginAchievements('demo')
    expect(useAchievements.getState().pluginSeries).toEqual([])
    expect(useAchievements.getState().counters['plugin:demo:hi']).toBe(1)
  })

  it('非法系列被拒绝且不抛', () => {
    registerPluginSeries('bad', { id: 'x', title: 'x', achievements: [] })
    registerPluginSeries('bad', { id: 'y', title: 'y', achievements: [{ id: 'a', title: '', desc: '', event: 'e', goal: 0, points: 1 }] })
    expect(useAchievements.getState().pluginSeries).toEqual([])
  })
})
