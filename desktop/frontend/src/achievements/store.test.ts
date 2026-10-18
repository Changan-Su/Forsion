import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { medalTier, seriesPoints, OFFICIAL_SERIES } from './definitions'
import {
  claimCloudAchievement, hasClaimable, initCloudAchievements, refreshCloudAchievements, registerPluginSeries, syncAchievementsFromDisk, track, unregisterPluginAchievements, useAchievements,
  type CloudAchievement,
} from './store'

const KEY = 'forsion_tangu_achievements'
const mem = new Map<string, string>()

beforeEach(() => {
  mem.clear()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v) },
    removeItem: (k: string) => { mem.delete(k) },
  })
  useAchievements.setState({ counters: {}, claimed: {}, queue: [], pluginSeries: [], cloud: { list: [], signedIn: false } })
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

describe('别的窗口写入的解锁(syncAchievementsFromDisk)', () => {
  it('本窗新跨线且未领取的入队一次;已领取的不入队;计数合并后本窗再 track 不二次跨线', () => {
    // 另一窗口(设置浮窗)换了主题 + 早先领过 first-message:只写了磁盘,本窗 store 还是旧的
    mem.set(KEY, JSON.stringify({ v: 1, counters: { 'theme.change': 1, 'chat.send': 1 }, claimed: ['first-message'] }))
    syncAchievementsFromDisk()
    expect(useAchievements.getState().queue).toEqual(['theme-change'])
    syncAchievementsFromDisk() // 同一次写入的重复事件:幂等
    expect(useAchievements.getState().queue).toEqual(['theme-change'])
    track('theme.change')
    expect(useAchievements.getState().queue).toEqual(['theme-change'])
    expect(useAchievements.getState().counters['theme.change']).toBe(2)
  })
})

describe('云端成就', () => {
  const def = (o: Partial<CloudAchievement> = {}): CloudAchievement => ({
    id: 'chat-5', series: 'chat', seriesTitle: { zh: '对话', en: 'Chat' }, title: { zh: '聊开了', en: 'Warming up' }, desc: { zh: '', en: '' },
    event: 'chat.send', goal: 5, points: 20, reward: [{ kind: 'points', label: { zh: '积分 ×100', en: 'Points ×100' } }],
    claimUntil: null, expired: false, progress: 0, claimed: null, ...o,
  })
  let replies: Array<{ status: number; json?: any }>
  let cloudFetch: ReturnType<typeof vi.fn>
  beforeEach(() => {
    replies = []
    cloudFetch = vi.fn(async () => replies.shift() ?? { status: 0, error: 'offline' })
    vi.stubGlobal('window', { tangu: { cloudFetch, platform: 'darwin' }, addEventListener() {} })
  })
  afterEach(() => vi.useRealTimers())

  it('红点:云端「达成未领」只在已登录时算;过期 / 已领 / 没达成都不算', () => {
    const st = () => useAchievements.getState()
    useAchievements.setState({ cloud: { signedIn: true, list: [def({ progress: 5 })] } })
    expect(hasClaimable(st())).toBe(true)
    useAchievements.setState({ cloud: { signedIn: false, list: [def({ progress: 5 })] } })
    expect(hasClaimable(st())).toBe(false)
    for (const o of [{ progress: 5, expired: true }, { progress: 5, claimed: { device: 'Mac', at: null } }, { progress: 4 }]) {
      useAchievements.setState({ cloud: { signedIn: true, list: [def(o)] } })
      expect(hasClaimable(st())).toBe(false)
    }
  })

  it('第一次拉:先拿定义,再把本机已有的累计值补报(只报云端用到的事件)', async () => {
    track('chat.send', 3)
    track('theme.change')
    replies.push({ status: 200, json: { achievements: [def()] } }, { status: 200, json: { achievements: [def({ progress: 3 })] } })
    await refreshCloudAchievements()
    expect(cloudFetch.mock.calls.map((c) => c[0].path)).toEqual(['/achievements/me', '/achievements/progress'])
    const body = cloudFetch.mock.calls[1][0].body
    expect(body.counts).toEqual({ 'chat.send': 3 })
    expect(body.deviceId).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(useAchievements.getState().cloud).toMatchObject({ signedIn: true, list: [{ progress: 3 }] })
    expect(JSON.parse(mem.get('forsion_cloud_achievements')!).list[0].progress).toBe(3) // 缓存:下次启动即有
  })

  it('track 命中云端事件 → 节流合成一次上报;设备号不变', async () => {
    vi.useFakeTimers()
    useAchievements.setState({ cloud: { signedIn: true, list: [def()] } })
    replies.push({ status: 200, json: { achievements: [def({ progress: 2 })] } })
    track('chat.send')
    track('chat.send')
    track('theme.change') // 不是云端用到的事件:不触发
    expect(cloudFetch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3000)
    expect(cloudFetch).toHaveBeenCalledTimes(1)
    expect(cloudFetch.mock.calls[0][0]).toMatchObject({ path: '/achievements/progress', method: 'POST', body: { counts: { 'chat.send': 2 } } })
    const id = cloudFetch.mock.calls[0][0].body.deviceId
    replies.push({ status: 200, json: { achievements: [def({ progress: 3 })] } })
    track('chat.send')
    await vi.advanceTimersByTimeAsync(3000)
    expect(cloudFetch.mock.calls[1][0].body.deviceId).toBe(id)
  })

  it('401:定义留着展示,进度与领取清掉(换号的人看不到上一位的);停用的去掉', async () => {
    useAchievements.setState({ cloud: { signedIn: true, list: [def({ progress: 5, claimed: { device: 'Mac', at: 'x' } }),
      def({ id: 'old', enabled: false, claimed: { device: 'Mac', at: 'x' } })] } })
    replies.push({ status: 401 })
    await refreshCloudAchievements()
    expect(useAchievements.getState().cloud).toEqual({ signedIn: false, list: [def()] })
  })

  it('领取:成功换上服务端的列表;失败回错误类别(不带服务端中文说明)并重拉对齐', async () => {
    useAchievements.setState({ cloud: { signedIn: true, list: [def({ progress: 5 })] } })
    replies.push({ status: 200, json: { claimed: true, alreadyClaimed: false, achievements: [def({ progress: 5, claimed: { device: 'Mac', at: 'now' } })] } })
    expect(await claimCloudAchievement('chat-5')).toEqual({ ok: true })
    expect(cloudFetch.mock.calls[0][0]).toMatchObject({ path: '/achievements/chat-5/claim', method: 'POST', body: { device: 'Mac' } })
    expect(hasClaimable(useAchievements.getState())).toBe(false)

    replies.push({ status: 410, json: { error: 'expired', detail: '已过领取期限' } }, { status: 200, json: { achievements: [def({ expired: true })] } })
    expect(await claimCloudAchievement('chat-5')).toEqual({ ok: false, reason: 'expired' })
    await vi.waitFor(() => expect(useAchievements.getState().cloud.list[0].expired).toBe(true))
  })

  it('没有 cloudFetch 桥(网页版 / 没装 Extend):什么都不发、不抛', async () => {
    vi.stubGlobal('window', { tangu: {} })
    track('chat.send')
    await refreshCloudAchievements()
    expect(await claimCloudAchievement('x')).toEqual({ ok: false, reason: 'network' })
  })

  it('回包按发出顺序认:先发的进度回包晚到,不压掉领取结果', async () => {
    useAchievements.setState({ cloud: { signedIn: true, list: [def({ progress: 5 })] } })
    const gates: Array<(v: unknown) => void> = []
    cloudFetch.mockImplementation(() => new Promise((ok) => gates.push(ok)))
    const slow = refreshCloudAchievements()
    const claim = claimCloudAchievement('chat-5')
    gates[1]({ status: 200, json: { achievements: [def({ progress: 5, claimed: { device: 'Mac', at: 'now' } })] } })
    expect(await claim).toEqual({ ok: true })
    gates[0]({ status: 200, json: { achievements: [def({ progress: 5 })] } })
    await slow
    expect(useAchievements.getState().cloud.list[0].claimed).toEqual({ device: 'Mac', at: 'now' })
  })

  it('领取回包比之后发出的刷新晚到:不落旧包,但再拉一次,界面不停在「可领取」', async () => {
    useAchievements.setState({ cloud: { signedIn: true, list: [def({ progress: 5 })] } })
    const gates: Array<(v: unknown) => void> = []
    cloudFetch.mockImplementation(() => new Promise((ok) => gates.push(ok)))
    const claim = claimCloudAchievement('chat-5')
    const later = refreshCloudAchievements()
    gates[1]({ status: 200, json: { achievements: [def({ progress: 5 })] } }) // 刷新先回来,读到的是领取前
    await later
    gates[0]({ status: 200, json: { claimed: true, alreadyClaimed: false, achievements: [def({ progress: 5, claimed: { device: 'Mac', at: 'now' } })] } })
    expect(await claim).toEqual({ ok: true })
    expect(cloudFetch).toHaveBeenCalledTimes(3)
    gates[2]({ status: 200, json: { achievements: [def({ progress: 5, claimed: { device: 'Mac', at: 'now' } })] } })
    await vi.waitFor(() => expect(hasClaimable(useAchievements.getState())).toBe(false))
  })

  it('进度被拒(设备数满了 429):照样拉一次列表', async () => {
    track('chat.send', 2)
    useAchievements.setState({ cloud: { signedIn: true, list: [def()] } })
    replies.push({ status: 429, json: { error: 'too_many_devices' } }, { status: 200, json: { achievements: [def({ progress: 7 })] } })
    await refreshCloudAchievements()
    expect(cloudFetch.mock.calls.map((c) => c[0].path)).toEqual(['/achievements/progress', '/achievements/me'])
    expect(useAchievements.getState().cloud.list[0].progress).toBe(7)
  })

  it('换号前发出的回包丢掉(A 的进度别落到 B 头上)', async () => {
    vi.useFakeTimers()
    let authChanged = () => {}
    const gates: Array<(v: unknown) => void> = []
    cloudFetch.mockImplementation(() => new Promise((ok) => gates.push(ok)))
    vi.stubGlobal('window', { tangu: { cloudFetch, platform: 'darwin', onAuthChanged: (cb: () => void) => { authChanged = cb } }, addEventListener() {} })
    useAchievements.setState({ cloud: { signedIn: true, list: [def({ progress: 9, claimed: { device: 'Mac', at: 'x' } })] } })
    initCloudAchievements()
    const stale = refreshCloudAchievements() // 账号 A 发出
    authChanged() // 换成 B,重拉;新号的请求还没回来,A 的进度 / 领取当场清掉
    expect(useAchievements.getState().cloud).toEqual({ signedIn: false, list: [def()] })
    gates[0]({ status: 200, json: { achievements: [def({ progress: 9 })] } })
    await stale
    expect(useAchievements.getState().cloud.list[0].progress).toBe(0)
    gates[1]({ status: 200, json: { achievements: [def({ progress: 1 })] } })
    await vi.advanceTimersByTimeAsync(1)
    expect(useAchievements.getState().cloud.list.map((a) => a.progress)).toEqual([1])
  })
})
