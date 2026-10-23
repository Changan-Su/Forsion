// @vitest-environment happy-dom
/**
 * 卡片堆里的任务卡(10-23 方案「待确认卡片」B):
 *  ① pendingTaskCardsOf 只收做完的回答里、没撤回 / 没过 7 天 / 没处理过的卡;Muse 提的待办没拉到引擎状态时不收。
 *  ⑥ Muse 提的待办(proactive:todo 上的 `todo:` 卡,10-23「交互卡片放最新位置」):引擎确认还 pending 的才收。
 *  ② 处理记录落 localStorage:重新加载模块(= 重启)后照样认得,卡不会回到卡片堆。
 *  ③ 写卡那条回答下面(TaskTraces):还在等的并成一行,处理过的写结局。
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, expect, it, vi } from 'vitest'
import '../../i18n.generated'
import type { UiMessage } from '../../../../../tangu-agent/src/contracts/clientTypes'

const card = (title: string, extra = '') => '```forsion-task\ntitle: ' + title + '\n' + extra + '---\ndo ' + title + '\n```'
const msg = (id: string, content: string, over: Partial<UiMessage> = {}): UiMessage =>
  ({ id, role: 'assistant', content, status: 'done', timestamp: Date.now(), ...over }) as UiMessage

beforeEach(() => { localStorage.clear(); vi.resetModules() })

it('① 只收还在等你选的卡', async () => {
  const { pendingTaskCardsOf } = await import('./pendingTasks')
  const list = [
    msg('m1', `${card('A')}\n${card('B', 'id: b\n')}`),
    msg('m2', card('Streaming'), { status: 'streaming' }),
    msg('m3', card('Old'), { timestamp: Date.now() - 8 * 24 * 3600_000 }),
    msg('m4', card('Muse todo', 'todo: t1\n'), { origin: 'proactive:todo' } as Partial<UiMessage>),
    msg('m5', '```forsion-task\nwithdraw: b\nreason: done already\n```'),
  ]
  expect(pendingTaskCardsOf(list, 's1').map((p) => p.card.title)).toEqual(['A'])
})

it('② 处理记录重启后还在', async () => {
  const first = await import('./pendingTasks')
  const list = [msg('m1', `${card('A')}\n${card('B')}`)]
  const [a] = first.pendingTaskCardsOf(list, 's1')
  first.markTaskHandled(a.doneKey, 'here')
  vi.resetModules()
  const again = await import('./pendingTasks')
  expect(again.pendingTaskCardsOf(list, 's1').map((p) => p.card.title)).toEqual(['B'])
  expect(again.pendingTaskCardsOf(list, 's2').length, '别的会话里同样内容的卡不受影响').toBe(2)
})

it('③ 回答下面只留一行', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const { TaskTraces } = await import('./TaskCards')
  const { markTaskHandled, taskDoneKey } = await import('./pendingTasks')
  const { splitSuggestions } = await import('./suggest')
  const tasks = splitSuggestions(`${card('A')}\n${card('B')}`, { kinds: ['task'] }).tasks
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  const onJump = vi.fn()
  await act(async () => root.render(React.createElement(TaskTraces, { tasks, ownerId: 'm1', sessionId: 's1', createdAt: Date.now(), onJump })))
  expect(host.querySelector('[data-task-trace="pending"]')?.textContent).toBe('2 张任务卡 · 在对话最下面')
  ;(host.querySelector('[data-task-trace="pending"]') as HTMLButtonElement).click()
  expect(onJump).toHaveBeenCalled()
  await act(async () => { markTaskHandled(taskDoneKey('s1', tasks[0]), 'here') })
  expect(host.querySelector('[data-task-trace="here"]')?.textContent).toBe('任务卡「A」· 已在此执行')
  expect(host.querySelector('[data-task-trace="pending"]')?.textContent).toBe('任务卡「B」· 在对话最下面')
  await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals()
})

it('④ 两个窗口各记一笔不互相抹掉;同样文字的两条 Muse 待办各认各的(Codex 10-23)', async () => {
  const list = [msg('m1', `${card('A')}\n${card('B')}`)]
  const winA = await import('./pendingTasks')
  winA.pendingTaskCardsOf(list, 's1') // 两边都先读过一遍(各自缓存了空记录)
  vi.resetModules()
  const winB = await import('./pendingTasks')
  winB.pendingTaskCardsOf(list, 's1')
  const [a, b] = winA.pendingTaskCardsOf(list, 's1')
  winA.markTaskHandled(a.doneKey, 'here')
  winB.markTaskHandled(b.doneKey, 'ignore')
  vi.resetModules()
  const after = await import('./pendingTasks')
  expect(after.pendingTaskCardsOf(list, 's1')).toEqual([])
  const todo1 = { title: 'Same', prompt: 'p', todo: 't1' }, todo2 = { ...todo1, todo: 't2' }
  after.markTaskHandled(after.taskDoneKey('s1', todo1), 'muse')
  expect(after.taskHandled(after.taskDoneKey('s1', todo2))).toBeUndefined()
})

it('⑥ Muse 提的待办:引擎还 pending 的才进卡片堆;普通回答里的 todo 头不算数', async () => {
  const { pendingTaskCardsOf, markTaskHandled } = await import('./pendingTasks')
  const muse = { origin: 'proactive:todo' } as Partial<UiMessage>
  const list = [
    msg('m1', card('Plain')),
    msg('p1', card('Todo 1', 'todo: t1\n'), muse),
    msg('p2', card('Todo 2', 'todo: t2\n'), muse),
    msg('m2', card('Fake todo', 'todo: t3\n')),
  ]
  expect(pendingTaskCardsOf(list, 's1', Date.now(), null).map((p) => p.card.title), '还没拉到').toEqual(['Plain', 'Fake todo'])
  const got = pendingTaskCardsOf(list, 's1', Date.now(), new Set(['t1', 't3']))
  expect(got.map((p) => p.card.title), 't2 已不 pending;m2 不是 Muse 发的,todo 头被忽略').toEqual(['Plain', 'Todo 1', 'Fake todo'])
  expect(got[1].card.todo).toBe('t1')
  markTaskHandled(got[1].doneKey, 'muse')
  expect(pendingTaskCardsOf(list, 's1', Date.now(), new Set(['t1'])).map((p) => p.card.title), '本机处理过就离开,不等引擎重拉').toEqual(['Plain', 'Fake todo'])
})

it('⑦ 协作请求卡与作品卡(10-23 也算交互卡片):没处理的进卡片堆;知道了 / 撤销 / 做成 / 不用了 / 过 7 天的不进', async () => {
  const { pendingHumanCardsOf, pendingCreationCardsOf, markTaskHandled } = await import('./pendingTasks')
  const { ackHumanChanges, markHumanUndone } = await import('../../services/humanCollaboration')
  const change = (id: string) => ({
    id, scope: { kind: 'human', file: 'HUMAN.md' }, summary: `ask ${id}`, evidence: 'why', at: '2026-10-23T00:00:00Z', actor: 'agent',
    beforeVersion: 'a'.repeat(64), afterVersion: 'b'.repeat(64),
  })
  const ev = (id: string) => ({ id: `ev-${id}`, name: 'manage_human', done: true, result: JSON.stringify({ kind: 'human_update', change: change(id) }) })
  const uuid = (n: number) => `0000000${n}-0000-4000-8000-000000000000`
  const list = [
    msg('h1', 'one', { toolEvents: [ev(uuid(1))] } as Partial<UiMessage>),
    msg('h2', 'two', { toolEvents: [ev(uuid(2))] } as Partial<UiMessage>),
    msg('h3', 'three', { toolEvents: [ev(uuid(3))] } as Partial<UiMessage>),
    msg('h4', 'old', { toolEvents: [ev(uuid(4))], timestamp: Date.now() - 8 * 24 * 3600_000 } as Partial<UiMessage>),
  ]
  expect(pendingHumanCardsOf(list).map((h) => h.messageId)).toEqual(['h1', 'h2', 'h3'])
  ackHumanChanges([uuid(1)]); markHumanUndone([uuid(2)])
  expect(pendingHumanCardsOf(list).map((h) => h.messageId)).toEqual(['h3'])

  const cc = (name: string) => '```forsion-creation\nname: ' + name + '\n```'
  // 一条回答最多一张作品卡(suggest MAX_CREATIONS)
  const cl = [msg('c1', cc('Alpha')), msg('c3', cc('Beta')), msg('c2', cc('Old'), { timestamp: Date.now() - 8 * 24 * 3600_000 })]
  const got = pendingCreationCardsOf(cl, 's1')
  expect(got.map((c) => c.card.name)).toEqual(['Alpha', 'Beta'])
  markTaskHandled(got[0].doneKey, 'here'); markTaskHandled(got[1].doneKey, 'ignore')
  expect(pendingCreationCardsOf(cl, 's1')).toEqual([])
  expect(pendingCreationCardsOf(cl, 's2').length, '别的会话不受影响').toBe(2)
})

it('⑧ 评审三条:停掉的回答里的协作请求也进卡片堆;作品卡记录不随 8 天清理;本机存不下时「知道了」照样在本次生效', async () => {
  const { pendingHumanCardsOf, creationDoneKey, markTaskHandled } = await import('./pendingTasks')
  const hc = await import('../../services/humanCollaboration')
  const id = '00000009-0000-4000-8000-000000000000'
  const change = { id, scope: { kind: 'human', file: 'HUMAN.md' }, summary: 's', evidence: 'e', at: '2026-10-23T00:00:00Z', actor: 'agent', beforeVersion: 'a'.repeat(64), afterVersion: 'b'.repeat(64) }
  const stopped = msg('h9', 'cut off', { status: 'stopped', toolEvents: [{ id: 'ev', name: 'manage_human', done: true, result: JSON.stringify({ kind: 'human_update', change }) }] } as Partial<UiMessage>)
  expect(pendingHumanCardsOf([stopped]).map((h) => h.messageId)).toEqual(['h9'])

  const key = creationDoneKey('s1', { name: 'Old', path: undefined } as never)
  markTaskHandled(key, 'ignore')
  const raw = JSON.parse(localStorage.getItem('forsion_task_cards_handled') || '{}')
  raw[key].t = Date.now() - 30 * 24 * 3600_000
  raw['s1:old-task'] = { l: 'here', t: Date.now() - 30 * 24 * 3600_000 }
  localStorage.setItem('forsion_task_cards_handled', JSON.stringify(raw))
  vi.resetModules()
  const again = await import('./pendingTasks')
  expect(again.taskHandled(key)?.landing, '作品卡记录留着').toBe('ignore')
  expect(again.taskHandled('s1:old-task'), '任务卡老记录照旧清掉').toBeUndefined()

  const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
  hc.ackHumanChanges([id])
  set.mockRestore()
  expect(hc.humanAcked([id])).toBe(true)
  expect(pendingHumanCardsOf([stopped])).toEqual([])
})
