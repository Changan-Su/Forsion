// @vitest-environment happy-dom
/**
 * Muse 私聊里它提的待办进不进卡片堆(10-23「交互卡片放最新位置」,Codex 评审三条):
 *  按 id 读真状态,和流里那行 / 卡片堆里那张共用一份 —— 读失败的重试读到 pending 就进来;没有 500 条上限;
 *  在别处处理掉的,任何一处重读到不是 pending 就离开。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import '../../i18n.generated'

const status: Record<string, string | Error> = {}
vi.mock('../../services/backendService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getMuseTodo: vi.fn(async (_t: unknown, id: string) => {
    const st = status[id]
    if (st instanceof Error) throw st
    return { id, title: id, status: st }
  }),
}))

const { useMusePendingTodos } = await import('./MuseDm')
const { fetchMuseTodoStatus } = await import('./TaskCards')

let host: HTMLDivElement
let root: Root
let got: ReadonlySet<string> = new Set()
function Probe({ ids }: { ids: string }) { got = useMusePendingTodos(ids, 0); return null }

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() })

it('按 id 读:pending 的进,处理过 / 读失败的不进;重试读到 pending 进来,别处处理掉的重读后离开', async () => {
  Object.assign(status, { t1: 'pending', t2: 'injected', t3: new Error('offline') })
  await act(async () => root.render(React.createElement(Probe, { ids: 't1,t2,t3' })))
  await flush()
  expect([...got]).toEqual(['t1'])
  status.t3 = 'pending'
  await act(async () => { await fetchMuseTodoStatus('t3') }) // 流里那行点了重试
  expect([...got].sort()).toEqual(['t1', 't3'])
  status.t1 = 'done'
  await act(async () => { await fetchMuseTodoStatus('t1') }) // 换到卡片堆里这张时它自己重读
  expect([...got]).toEqual(['t3'])
})
