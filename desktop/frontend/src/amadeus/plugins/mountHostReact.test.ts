// @vitest-environment happy-dom
/**
 * mountHostReact 的容器契约(2026-10-04:隔离层从 pluginChat 下沉到这里)。真 React + happy-dom。
 *  ① dispose 之后 el 立刻还给调用方:清空它、在它上面再挂(同一拍或晚一拍)都行;
 *  ② 不 dispose、同一个 el 再挂 = 原地更新(组件实例与 DOM 身份不变)—— 表格 / 输入卡 / 编辑器的 update 靠它;
 *  ③ 两条历史教训:同一个容器不出现两个 root(旧树必须真卸掉)、旧 disposer 不清掉新挂载。
 * 负对照(2026-10-04 都实跑红过):实现换回「root 直接建在 el 上」→ ① 三条红(el 里还留着旧节点 / 重挂的内容不在文档里 / 卸载抛 NotFoundError);
 * disposer 去掉代际判断 → 「被顶掉的旧 disposer 作废」与「旧 disposer 晚到」两条红;dispose 不再 unmount → 「旧树恰好卸一次」红;
 * 「那一层已不在 el 里」的判断去掉 → 「没 dispose 就清空 el」红。
 */
import { act, createElement as h, useEffect, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountHostReact } from '@lcl/components'

let el: HTMLDivElement
const errors: unknown[] = []
const onError = (e: ErrorEvent): void => { errors.push(e.error ?? e.message); e.preventDefault() }
const log = { mounted: [] as string[], unmounted: [] as string[] }
const flush = () => act(async () => { await Promise.resolve() })

function Probe({ name }: { name: string }) {
  const [clicks, setClicks] = useState(0)
  useEffect(() => { log.mounted.push(name); return () => { log.unmounted.push(name) } }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return h('button', { 'data-probe': name, onClick: () => setClicks((n) => n + 1) }, String(clicks))
}
const probe = (name: string) => el.querySelector<HTMLButtonElement>(`[data-probe="${name}"]`)

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  el = document.createElement('div')
  document.body.append(el)
  errors.length = 0; log.mounted.length = 0; log.unmounted.length = 0
  window.addEventListener('error', onError)
})
afterEach(() => {
  window.removeEventListener('error', onError)
  el.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('dispose 之后 el 立刻还给调用方', () => {
  it('dispose 同步摘掉宿主自己那一层(不等 React 的卸载落地),调用方自己放进 el 的节点不动', async () => {
    const own = el.appendChild(document.createElement('p'))
    let dispose!: () => void
    await act(async () => { dispose = mountHostReact(el, h(Probe, { name: 'a' })) })
    expect(probe('a')).not.toBeNull()
    await act(async () => {
      dispose()
      expect([...el.children]).toEqual([own])
      expect(log.unmounted).toEqual([]) // 卸载还没落地
    })
    expect(log.unmounted).toEqual(['a'])
    expect(errors).toEqual([])
  })

  it('dispose → 清空 el → 同一拍再挂:新的那份在文档里', async () => {
    let dispose!: () => void
    await act(async () => { dispose = mountHostReact(el, h(Probe, { name: 'a' })) })
    await act(async () => {
      dispose()
      el.replaceChildren()
      dispose = mountHostReact(el, h(Probe, { name: 'b' }))
    })
    expect(probe('b')?.isConnected).toBe(true)
    expect(probe('a')).toBeNull()
    expect(log.unmounted).toEqual(['a'])
    expect(errors).toEqual([])
    await act(async () => { dispose() })
  })

  it('dispose → 清空 el → 不再挂 / 晚一拍再挂:卸载不报错', async () => {
    let dispose!: () => void
    await act(async () => { dispose = mountHostReact(el, h(Probe, { name: 'a' })) })
    await act(async () => { dispose(); el.replaceChildren() })
    await flush()
    expect(errors).toEqual([])
    expect(log.unmounted).toEqual(['a'])
    await act(async () => { dispose = mountHostReact(el, h(Probe, { name: 'b' })) })
    expect(probe('b')?.isConnected).toBe(true)
    await act(async () => { dispose() })
    expect(errors).toEqual([])
  })

  it('没 dispose 就清空了 el 再挂:另起一层,旧树照样卸掉', async () => {
    await act(async () => { mountHostReact(el, h(Probe, { name: 'a' })) })
    let dispose!: () => void
    await act(async () => { el.replaceChildren(); dispose = mountHostReact(el, h(Probe, { name: 'b' })) })
    expect(probe('b')?.isConnected).toBe(true)
    expect(log.unmounted).toEqual(['a'])
    await act(async () => { dispose() })
    expect(el.childElementCount).toBe(0)
    expect(errors).toEqual([])
  })
})

describe('同一个 el 不 dispose 再挂 = 原地更新', () => {
  it('组件实例、DOM 节点、组件自己的状态都留着;被顶掉的旧 disposer 作废,最新那个才收得掉', async () => {
    let first!: () => void, second!: () => void
    await act(async () => { first = mountHostReact(el, h(Probe, { name: 'a' })) })
    const node = probe('a')!
    await act(async () => { node.click() })
    await act(async () => { second = mountHostReact(el, h(Probe, { name: 'a' })) })
    expect(probe('a')).toBe(node)
    expect(node.textContent).toBe('1')
    expect(log.mounted).toEqual(['a'])
    expect(el.childElementCount).toBe(1)

    await act(async () => { first() })
    expect(probe('a')).toBe(node)
    expect(log.unmounted).toEqual([])

    await act(async () => { second(); second() }) // 幂等
    expect(el.childElementCount).toBe(0)
    expect(log.unmounted).toEqual(['a'])
    expect(errors).toEqual([])
  })
})

describe('历史教训:同容器双 root / 旧 dispose 清掉新挂载', () => {
  it('dispose 后同一拍重挂(React effect 的 cleanup → setup,不清 el):旧树恰好卸一次,新挂载留着,el 里只有一层', async () => {
    const warn = vi.spyOn(console, 'error')
    let first!: () => void, second!: () => void
    await act(async () => { first = mountHostReact(el, h(Probe, { name: 'a' })) })
    await act(async () => {
      first()
      second = mountHostReact(el, h(Probe, { name: 'b' }))
    })
    expect(log.unmounted).toEqual(['a'])
    expect(probe('b')?.isConnected).toBe(true)
    expect(el.childElementCount).toBe(1)
    expect(warn).not.toHaveBeenCalled() // React 对「同一个容器第二次 createRoot」会 console.error

    await act(async () => { first() }) // 旧 disposer 晚到 / 被重复调用
    const node = probe('b')
    expect(node?.isConnected).toBe(true)
    expect(log.unmounted).toEqual(['a'])
    await act(async () => { second = mountHostReact(el, h(Probe, { name: 'b' })) }) // 之后的原地更新仍落在新挂载上,不会另起一层
    expect(probe('b')).toBe(node)
    expect(el.childElementCount).toBe(1)

    await act(async () => { second() })
    expect(log.unmounted).toEqual(['a', 'b'])
    expect(el.childElementCount).toBe(0)
    expect(errors).toEqual([])
  })
})
