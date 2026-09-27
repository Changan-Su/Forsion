// @vitest-environment happy-dom
/**
 * 输入框上方托盘的三条行为(评审 09-27):
 *  ① 展开项钉住 —— 插到它前面的新条目(并行团队里排在前面的成员晚来的审批 / 提问)只进排队行,
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

it('① 展开项钉住:更早的消息后来插进一条,它只进排队行;展开项离开后才回落到最早那项', async () => {
  const b = ask('q-b', 'm-b', 'Question from B')
  const a = apv('a-a', 'm-a', '$ from A')
  await render([b])
  expect(body().dataset.trayMsg).toBe('m-b')
  await render([a, b]) // A 的消息排在前面(并行团队里先激活的成员),它的审批晚到
  expect(body().dataset.trayMsg, '正在看的提问被新插进来的审批顶掉了').toBe('m-b')
  expect(host.querySelector('.inquiry-q')?.textContent).toContain('Question from B')
  expect([...host.querySelectorAll('.t2c-apv-row')].map((r) => r.textContent)).toEqual(['run_bash$ from A'])
  await render([a]) // B 答完离开托盘 → 回落到最早那项
  expect(body().dataset.trayMsg).toBe('m-a')
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

it('③ 换卡冷却:点排队行换卡后,冷却内的点击不送(JS 层拦,键盘回车同样拦),ARM_MS 后才送', async () => {
  const onAnswer = vi.fn(() => Promise.resolve(true))
  vi.useFakeTimers()
  await render([ask('q1', 'm1', 'First'), ask('q2', 'm2', 'Second')], onAnswer)
  await act(async () => { vi.advanceTimersByTime(400) })
  expect(body().classList.contains('is-arming')).toBe(false)
  await act(async () => { host.querySelector<HTMLButtonElement>('.t2c-apv-row')!.click() })
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
