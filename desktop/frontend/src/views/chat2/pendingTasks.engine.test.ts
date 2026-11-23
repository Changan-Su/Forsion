// @vitest-environment happy-dom
/**
 * 任务卡 / 作品卡「处理过了」跟会话走(引擎 GET / POST /agent/sessions/:id/card-marks,11-23):
 *  ① 另一端处理过的卡(引擎有、本机没有)不再回到卡片堆;
 *  ② 读引擎失败 = 不知道:照本机的看,什么也不写;
 *  ③ 老引擎(404 无 error 码)→ 只用本机,不发 POST,同一台引擎几分钟内不再问;
 *  ④ 读成功后补传:本机有、引擎没有的这个会话的记录发上去(别的会话 / 收件箱的不发);只加不减,引擎回空表也不删本机;
 *  ⑤ 记一张卡只发那一条(delta),不发整表;收件箱(不传 sessionId)不发;
 *  ⑥ 同一张卡两份记录:「忽略」让位给真做了的,其余本机的优先;
 *  ⑦ 引擎回的过期任务卡记录不算数,作品卡记录算;响应形状不对当失败。
 */
import { beforeEach, expect, it, vi } from 'vitest'
import '../../i18n.generated'
import type { UiMessage } from '../../../../../tangu-agent/src/contracts/clientTypes'

const getMock = vi.fn()
const postMock = vi.fn()
vi.mock('../../services/backendService', async (orig) => ({
  ...(await orig<typeof import('../../services/backendService')>()),
  getSessionCardMarks: (...a: unknown[]) => getMock(...a),
  postSessionCardMarks: (...a: unknown[]) => postMock(...a),
}))
const fakeTarget = (key: string) => ({ key, base: 'http://engine', via: 'local' })
let targetKey = 'home'
vi.mock('../../services/engine/targets', async (orig) => ({
  ...(await orig<typeof import('../../services/engine/targets')>()),
  targetForSession: () => fakeTarget(targetKey),
}))

const card = (title: string, extra = '') => '```forsion-task\ntitle: ' + title + '\n' + extra + '---\ndo ' + title + '\n```'
const creation = (name: string) => '```forsion-creation\nname: ' + name + '\n```'
const msg = (id: string, content: string, over: Partial<UiMessage> = {}): UiMessage =>
  ({ id, role: 'assistant', content, status: 'done', timestamp: Date.now(), ...over }) as UiMessage
const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)) }
const httpErr = (status: number, code?: string) => Object.assign(new Error(`HTTP ${status}`), { status }, code ? { code } : {})

beforeEach(async () => {
  localStorage.clear(); vi.resetModules(); getMock.mockReset(); postMock.mockReset(); targetKey = 'home'
  postMock.mockImplementation(async (_t: unknown, _sid: string, marks: Record<string, unknown>) => marks)
  await import('../../tangu/store/standalone')
})

it('① 另一端处理过的卡不再回到卡片堆', async () => {
  const P = await import('./pendingTasks')
  const list = [msg('m1', `${card('A', 'id: a\n')}\n${card('B', 'id: b\n')}`)]
  getMock.mockResolvedValue({ 'id:a': { l: 'child', t: Date.now(), c: 'kid-1' } })
  expect(P.pendingTaskCardsOf(list, 's1').map((p) => p.card.title), '引擎还没回:先照本机的').toEqual(['A', 'B'])
  await flush()
  expect(getMock).toHaveBeenCalledTimes(1)
  expect(getMock.mock.calls[0][1]).toBe('s1')
  expect(P.pendingTaskCardsOf(list, 's1').map((p) => p.card.title)).toEqual(['B'])
  expect(P.taskHandled('s1:id:a')).toEqual({ landing: 'child', childId: 'kid-1' })
  expect(P.taskHandled('s2:id:a'), '别的会话不受影响').toBeUndefined()
  // 30s 内再算不重复读
  P.pendingTaskCardsOf(list, 's1'); await flush()
  expect(getMock).toHaveBeenCalledTimes(1)
})

it('② 读引擎失败 = 不知道:本机记录照算,不发 POST,也不清本机', async () => {
  const P = await import('./pendingTasks')
  const list = [msg('m1', `${card('A', 'id: a\n')}\n${card('B', 'id: b\n')}`)]
  getMock.mockRejectedValue(httpErr(500))
  P.markTaskHandled('s1:id:a', 'here', undefined, 's1')
  await flush()
  P.pendingTaskCardsOf(list, 's1'); await flush()
  expect(postMock).not.toHaveBeenCalled()
  expect(P.pendingTaskCardsOf(list, 's1').map((p) => p.card.title)).toEqual(['B'])
  expect(JSON.parse(localStorage.getItem('forsion_task_cards_handled') || '{}')['s1:id:a'].l).toBe('here')
  // 形状不对的响应也当失败(读不出来 ≠ 空表)
  getMock.mockRejectedValue(Object.assign(new Error('bad card-marks response'), { status: 0 }))
  await P.refreshCardMarks('s1', 0); await flush()
  expect(postMock).not.toHaveBeenCalled()
})

it('③ 老引擎(404 无 error 码):只用本机,不 POST,同一台几分钟内不再问', async () => {
  const P = await import('./pendingTasks')
  getMock.mockRejectedValue(httpErr(404))
  P.pendingTaskCardsOf([msg('m1', card('A', 'id: a\n'))], 's1'); await flush()
  P.markTaskHandled('s1:id:a', 'here', undefined, 's1'); await flush()
  expect(postMock).not.toHaveBeenCalled()
  expect(P.taskHandled('s1:id:a')?.landing).toBe('here')
  P.pendingTaskCardsOf([msg('m2', card('C', 'id: c\n'))], 's2'); await flush()
  expect(getMock, '同一台引擎:第二个会话不再问').toHaveBeenCalledTimes(1)
  // 会话不在(404 session_not_found)不是「老引擎」:别的会话照样问
  targetKey = 'unit:u1'
  getMock.mockRejectedValue(httpErr(404, 'session_not_found'))
  P.pendingTaskCardsOf([msg('m3', card('D', 'id: d\n'))], 's3'); await flush()
  getMock.mockResolvedValue({})
  P.pendingTaskCardsOf([msg('m4', card('E', 'id: e\n'))], 's4'); await flush()
  expect(getMock).toHaveBeenCalledTimes(3)
})

it('④ 读成功后补传本机有、引擎没有的这个会话的记录;别的会话 / 收件箱不发;引擎回空表不删本机', async () => {
  const now = Date.now()
  localStorage.setItem('forsion_task_cards_handled', JSON.stringify({
    's1:id:a': { l: 'here', t: now - 1000 },
    's1:creation:x': { l: 'ignore', t: now - 30 * 24 * 3600_000 }, // 作品卡记录不过期,照样补传
    's1:id:b': { l: 'new', t: now - 2000 },
    's2:id:z': { l: 'here', t: now },
    'letter-9:id:q': { l: 'new', t: now },
  }))
  const P = await import('./pendingTasks')
  getMock.mockResolvedValue({ 'id:b': { l: 'muse', t: now - 5000 } })
  P.pendingTaskCardsOf([msg('m1', card('A', 'id: a\n'))], 's1'); await flush()
  expect(postMock).toHaveBeenCalledTimes(1)
  const [, sid, sent] = postMock.mock.calls[0]
  expect(sid).toBe('s1')
  expect(sent).toEqual({ 'id:a': { l: 'here', t: now - 1000 }, 'creation:x': { l: 'ignore', t: now - 30 * 24 * 3600_000 } })
  // 引擎上已有的(id:b)不重发,显示按本机的(本机先有)
  expect(P.taskHandled('s1:id:b')?.landing).toBe('new')
  const local = JSON.parse(localStorage.getItem('forsion_task_cards_handled') || '{}')
  expect(Object.keys(local).sort()).toEqual(['letter-9:id:q', 's1:creation:x', 's1:id:a', 's1:id:b', 's2:id:z'])
})

it('⑤ 记一张卡只发那一条;收件箱(不传 sessionId)不发', async () => {
  const P = await import('./pendingTasks')
  getMock.mockResolvedValue({})
  P.pendingTaskCardsOf([msg('m1', `${card('A', 'id: a\n')}\n${card('B', 'id: b\n')}`)], 's1'); await flush()
  expect(postMock).not.toHaveBeenCalled()
  P.markTaskHandled('s1:id:a', 'child', 'kid-2', 's1'); await flush()
  expect(postMock).toHaveBeenCalledTimes(1)
  expect(postMock.mock.calls[0][1]).toBe('s1')
  expect(Object.keys(postMock.mock.calls[0][2])).toEqual(['id:a'])
  expect(postMock.mock.calls[0][2]['id:a']).toMatchObject({ l: 'child', c: 'kid-2' })
  P.markTaskHandled('letter-1:id:a', 'new'); await flush()
  P.markTaskHandled('letter-1:id:b', 'new', undefined, 's1'); await flush() // 键不是这个会话的:不发
  expect(postMock).toHaveBeenCalledTimes(1)
})

it('⑤b 引擎还在读时记的卡:读回来后补传带上', async () => {
  const P = await import('./pendingTasks')
  let resolve!: (v: unknown) => void
  getMock.mockReturnValue(new Promise((r) => { resolve = r }))
  P.pendingTaskCardsOf([msg('m1', card('A', 'id: a\n'))], 's1')
  P.markTaskHandled('s1:id:a', 'here', undefined, 's1')
  expect(postMock).not.toHaveBeenCalled()
  resolve({}); await flush()
  expect(postMock).toHaveBeenCalledTimes(1)
  expect(Object.keys(postMock.mock.calls[0][2])).toEqual(['id:a'])
})

it('⑥ 同一张卡两份记录:「忽略」让位给真做了的,其余本机优先', async () => {
  const now = Date.now()
  localStorage.setItem('forsion_task_cards_handled', JSON.stringify({ 's1:id:a': { l: 'ignore', t: now }, 's1:id:b': { l: 'here', t: now } }))
  const P = await import('./pendingTasks')
  getMock.mockResolvedValue({ 'id:a': { l: 'new', t: now }, 'id:b': { l: 'child', t: now, c: 'kid' } })
  P.pendingTaskCardsOf([msg('m1', card('A', 'id: a\n'))], 's1'); await flush()
  expect(P.taskHandled('s1:id:a')?.landing).toBe('new')
  expect(P.taskHandled('s1:id:b')?.landing).toBe('here')
  expect(postMock, '引擎已有做了的记录:本机的「忽略」不补传,「here」也不覆盖它').not.toHaveBeenCalled()
})

it('⑦ 引擎回的过期任务卡记录不算,作品卡记录算;作品卡在卡片堆里也跟着走', async () => {
  const old = Date.now() - 9 * 24 * 3600_000
  const P = await import('./pendingTasks')
  const { splitSuggestions } = await import('./suggest')
  const cr = splitSuggestions(creation('Demo'), { kinds: ['creation'] }).creations[0]
  const ck = P.creationDoneKey('s1', cr).slice('s1:'.length)
  getMock.mockResolvedValue({ 'id:a': { l: 'here', t: old }, [ck]: { l: 'ignore', t: old }, 'id:bad': { l: 'nuke', t: Date.now() } })
  const list = [msg('m1', `${card('A', 'id: a\n')}\n${creation('Demo')}`)]
  P.pendingCreationCardsOf(list, 's1'); await flush()
  expect(P.taskHandled('s1:id:a')).toBeUndefined()
  expect(P.taskHandled('s1:id:bad')).toBeUndefined()
  expect(P.taskHandled(`s1:${ck}`)?.landing).toBe('ignore')
  expect(P.pendingCreationCardsOf(list, 's1')).toEqual([])
  expect(P.pendingTaskCardsOf(list, 's1').map((p) => p.card.title)).toEqual(['A'])
})

it('⑧ 点卡执行前跟引擎再对一下:另一端刚处理过就不执行', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const React = (await import('react')).default
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { TaskCards } = await import('./TaskCards')
  const { splitSuggestions } = await import('./suggest')
  const tasks = splitSuggestions(card('A', 'id: a\n'), { kinds: ['task'] }).tasks
  // 这一屏还没读过引擎(卡片堆没算过):点下去当场读,另一端已经在这里做了
  getMock.mockResolvedValue({ 'id:a': { l: 'here', t: Date.now() } })
  const onTask = vi.fn(() => true)
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(React.createElement(TaskCards, { tasks, ownerId: 'm1', sessionId: 's1', createdAt: Date.now(), onTask })))
  const btn = [...host.querySelectorAll('button')].find((b) => /在这里做|在此执行|Run here/.test(b.textContent || ''))
  expect(btn, 'has a run-here button').toBeTruthy()
  await act(async () => { btn!.click(); await flush() })
  expect(onTask).not.toHaveBeenCalled()
  expect(host.querySelector('[data-task-state="here"]')).toBeTruthy()
  expect(getMock).toHaveBeenCalledTimes(1)
  await act(async () => root.unmount())
})

it('⑨ 补传被拒(远端 403 REMOTE_*)/ 卡住:不把这台当成不支持,也不挡下一次读', async () => {
  const P = await import('./pendingTasks')
  getMock.mockResolvedValue({})
  postMock.mockRejectedValue(httpErr(403, 'REMOTE_SESSIONS_OFF'))
  P.markTaskHandled('s1:id:a', 'here', undefined, 's1') // 还没读过:先读,读成功后补传(被拒)
  P.pendingTaskCardsOf([msg('m1', card('A', 'id: a\n'))], 's1'); await flush()
  expect(postMock).toHaveBeenCalledTimes(1)
  P.pendingTaskCardsOf([msg('m2', card('B', 'id: b\n'))], 's2'); await flush()
  expect(getMock, '同一台的别的会话照样读').toHaveBeenCalledTimes(2)
  // 补传挂住不回:下一次读照常发
  postMock.mockReturnValue(new Promise(() => {}))
  await P.refreshCardMarks('s1', 0); await flush()
  await P.refreshCardMarks('s1', 0); await flush()
  expect(getMock).toHaveBeenCalledTimes(4)
})

it('⑩ 长开着的窗口:缓存里过期的记录让位给引擎回来的新记录,也不挡补传', async () => {
  const realNow = Date.now
  let now = realNow()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  try {
    const P = await import('./pendingTasks')
    getMock.mockResolvedValue({ 'id:a': { l: 'child', t: now, c: 'old-kid' } })
    P.pendingTaskCardsOf([msg('m1', card('A', 'id: a\n'))], 's1'); await flush()
    expect(P.taskHandled('s1:id:a')?.childId).toBe('old-kid')
    now += 9 * 24 * 3600_000 // 同一张卡(同 id)9 天后重新写出
    expect(P.taskHandled('s1:id:a'), '过期的那条不再算').toBeUndefined()
    getMock.mockResolvedValue({ 'id:a': { l: 'here', t: now } })
    await P.refreshCardMarks('s1', 0); await flush()
    expect(P.taskHandled('s1:id:a')).toEqual({ landing: 'here', childId: undefined })
    // 引擎回空表、本机有新记录:照样补传(不被缓存里那条旧的挡住)
    getMock.mockResolvedValue({})
    now += 9 * 24 * 3600_000
    P.markTaskHandled('s1:id:a', 'new', undefined, 's1'); await flush()
    expect(postMock.mock.calls.some((c) => c[2]['id:a']?.l === 'new')).toBe(true)
  } finally { vi.restoreAllMocks() }
})

it('⑪ 没有执行入口(画布视图)不摆按钮,不记处理过,也不同步', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const React = (await import('react')).default
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { TaskCards } = await import('./TaskCards')
  const { splitSuggestions } = await import('./suggest')
  const P = await import('./pendingTasks')
  getMock.mockResolvedValue({})
  const tasks = splitSuggestions(card('A', 'id: a\n'), { kinds: ['task'] }).tasks
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(React.createElement(TaskCards, { tasks, ownerId: 'm1', sessionId: 's1', createdAt: Date.now() })))
  expect(host.querySelector('.t2-taskcard-actions')).toBeNull()
  await act(async () => { await flush() })
  expect(P.taskHandled('s1:id:a')).toBeUndefined()
  expect(postMock).not.toHaveBeenCalled()
  await act(async () => root.unmount())
})
