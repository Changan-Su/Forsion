// @vitest-environment happy-dom
/**
 * 托盘(10-23 起是对话末尾的卡片堆)的三条行为(评审 09-27):
 *  ① 展开项钉住 —— 插到它前面的新条目(并行团队里排在前面的成员晚来的审批 / 提问)只垫到后面,
 *     不把正在看的这项顶掉(草稿会丢,冷却过后还会点到顶上来的那张);它离开列表才回落到最早那项。
 *  ② 同一项不送第二次(第二次必然 410);没送达(返回 false)才解锁重试。锁在托盘层,卡片重挂不丢。
 *  ③ 换卡冷却:展开项一换,冷却期内的提交一律不送(鼠标、键盘都算)。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import '../../i18n.generated'
import type { TrayItem } from './approvalQueue'

const { ApprovalTray } = await import('./ApprovalTray')

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers() })

const ask = (id: string, messageId: string, question: string): TrayItem =>
  ({ kind: 'inquiry', id, messageId, req: { inquiryId: id, runId: 'r', question, options: ['yes', 'no'], status: 'pending' } })
const apv = (id: string, messageId: string, preview: string): TrayItem =>
  ({ kind: 'approval', id, messageId, req: { approvalId: id, runId: 'r', name: 'run_bash', preview, status: 'pending' } })

const render = (items: TrayItem[], onAnswer = vi.fn(), onDecide = vi.fn()) =>
  act(async () => root.render(React.createElement(ApprovalTray, { items, onAnswer, onDecide })))
const body = () => host.querySelector<HTMLElement>('.t2c-apv-body')!
const optionBtn = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('.inquiry-opts .btn')].find((b) => b.textContent?.includes(label))!

it('① 展开项钉住:更早的消息后来插进一条,它只垫到后面;展开项离开后才回落到最早那项', async () => {
  const b = ask('q-b', 'm-b', 'Question from B')
  const a = apv('a-a', 'm-a', '$ from A')
  await render([b])
  expect(body().dataset.trayMsg).toBe('m-b')
  await render([a, b]) // A 的消息排在前面(并行团队里先激活的成员),它的审批晚到
  expect(body().dataset.trayMsg, '正在看的提问被新插进来的审批顶掉了').toBe('m-b')
  expect(host.querySelector('.inquiry-q')?.textContent).toContain('Question from B')
  expect(host.querySelector('.t2c-apv-more')?.textContent).toBe('还有 1 个审批')
  expect(host.querySelector('.t2c-apv-title')?.textContent).toBe('等你处理 · 2')
  expect(host.querySelector('.t2c-apv-n')?.textContent).toBe('2 / 2')
  expect(host.querySelector('.t2c-apv')?.getAttribute('data-peek')).toBe('1')
  await render([a]) // B 答完离开托盘 → 回落到最早那项
  expect(body().dataset.trayMsg).toBe('m-a')
})

it('①b 全是同一种:只写「等你批准 · n」,不再补「还有」(走查续六 6.6)', async () => {
  await render([apv('a1', 'm1', '$ one'), apv('a2', 'm1', '$ two'), apv('a3', 'm1', '$ three')])
  expect(host.querySelector('.t2c-apv-title')?.textContent).toBe('等你批准 · 3')
  expect(host.querySelector('.t2c-apv-more')).toBeNull()
  expect(host.querySelector('.t2c-apv-n')?.textContent).toBe('1 / 3')
})

it('② 同一项连点只送一次;没送达(返回 false)才解锁,可以重试', async () => {
  let resolveFirst!: (ok: boolean) => void
  const onAnswer = vi.fn()
    .mockImplementationOnce(() => new Promise<boolean>((r) => { resolveFirst = r }))
    .mockImplementation(() => Promise.resolve(true))
  vi.useFakeTimers()
  await render([ask('q1', 'm1', 'Pick one')], onAnswer)
  await act(async () => { vi.advanceTimersByTime(400) }) // 过了换卡冷却
  await act(async () => { optionBtn('yes').click(); optionBtn('yes').click() })
  expect(onAnswer).toHaveBeenCalledTimes(1)
  expect(body().classList.contains('is-sent')).toBe(true)
  await act(async () => { resolveFirst(false) }) // 没送达
  expect(body().classList.contains('is-sent')).toBe(false)
  await act(async () => { optionBtn('no').click() })
  expect(onAnswer).toHaveBeenCalledTimes(2)
  expect(onAnswer.mock.calls[1]).toEqual(['m1', 'q1', 'no'])
})

it('③ 换卡冷却:点 › 换卡后,冷却内的点击不送(JS 层拦,键盘回车同样拦),ARM_MS 后才送', async () => {
  const onAnswer = vi.fn(() => Promise.resolve(true))
  vi.useFakeTimers()
  await render([ask('q1', 'm1', 'First'), ask('q2', 'm2', 'Second')], onAnswer)
  await act(async () => { vi.advanceTimersByTime(400) })
  expect(body().classList.contains('is-arming')).toBe(false)
  await act(async () => { host.querySelector<HTMLButtonElement>('.t2c-apv-nav[data-dir="next"]')!.click() })
  expect(body().dataset.trayMsg).toBe('m2')
  expect(body().classList.contains('is-arming')).toBe(true)
  // happy-dom 的 click() 不看 CSS pointer-events:这里拦住的只能是 submit 里的冷却判断
  await act(async () => { optionBtn('yes').click() })
  expect(onAnswer, '冷却期内的点击被送出去了').not.toHaveBeenCalled()
  await act(async () => { vi.advanceTimersByTime(400) })
  expect(body().classList.contains('is-arming')).toBe(false)
  await act(async () => { optionBtn('yes').click() })
  expect(onAnswer).toHaveBeenCalledWith('m2', 'q2', 'yes')
})

it('④ 任务卡垫底且不挡路:停在任务卡上时来了审批,换到审批;收着时来了新的审批会展开,来了任务卡不展开', async () => {
  const task = { kind: 'task', id: 'task:m0:0', messageId: 'm0', doneKey: 's:x', card: { title: 'Later', prompt: 'do it' } } as const
  await render([task as never])
  expect(body().dataset.trayKind).toBe('task')
  await render([apv('a1', 'm1', '$ make'), task as never])
  expect(body().dataset.trayKind, '审批来了还停在任务卡上').toBe('approval')
  await act(async () => { host.querySelector<HTMLButtonElement>('.t2c-apv-head')!.click() }) // 收起
  expect(host.querySelector('.t2c-apv-body')).toBeNull()
  const task2 = { ...task, id: 'task:m0:1', card: { title: 'Another', prompt: 'p' } }
  await render([apv('a1', 'm1', '$ make'), task as never, task2 as never])
  expect(host.querySelector('.t2c-apv-body'), '来了任务卡不该展开').toBeNull()
  await render([apv('a1', 'm1', '$ make'), apv('a2', 'm2', '$ test'), task as never, task2 as never])
  expect(host.querySelector('.t2c-apv-body'), '来了新审批该展开').not.toBeNull()
})

it('⑤ 卡片堆挪位置(画布模式切换 = 重挂)后,已送出的那项照样锁着(Codex 10-23)', async () => {
  const onAnswer = vi.fn(() => new Promise<boolean>(() => {})) // 一直没回执
  vi.useFakeTimers()
  const q = ask('q1', 'm1', 'Pick one')
  await act(async () => root.render(React.createElement(ApprovalTray, { items: [q], onAnswer, onDecide: vi.fn(), sessionId: 's-lock' })))
  await act(async () => { vi.advanceTimersByTime(400) })
  await act(async () => { optionBtn('yes').click() })
  await act(async () => root.unmount())
  root = createRoot(host)
  await act(async () => root.render(React.createElement(ApprovalTray, { items: [q], onAnswer, onDecide: vi.fn(), sessionId: 's-lock' })))
  await act(async () => { vi.advanceTimersByTime(400) })
  await act(async () => { optionBtn('yes').click() })
  expect(onAnswer).toHaveBeenCalledTimes(1)
})

it('⑥ 入场只给刚换上来的那张:托盘出现时卡体不单独入场,答的那一下也不重放;答完离开、下一张顶上来才入场', async () => {
  const onAnswer = vi.fn(() => Promise.resolve(true))
  vi.useFakeTimers()
  const q1 = ask('q1', 'm1', 'First'); const q2 = ask('q2', 'm2', 'Second')
  await render([q1, q2], onAnswer)
  expect(body().dataset.motion).toBeUndefined()
  await act(async () => { vi.advanceTimersByTime(400) })
  await act(async () => { optionBtn('yes').click() })
  expect(onAnswer).toHaveBeenCalledTimes(1)
  expect(body().dataset.motion).toBeUndefined() // 正在答的那张还在,不许重放
  await render([q2], onAnswer) // 引擎收下,它离开
  expect(body().dataset.trayMsg).toBe('m2')
  expect(body().dataset.motion).toBe('enter')
})
