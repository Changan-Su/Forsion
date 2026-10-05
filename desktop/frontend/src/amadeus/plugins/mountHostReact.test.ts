// @vitest-environment happy-dom
/**
 * mountHostReact 的容器契约(2026-10-04 隔离层下沉到这里;10-05 返回值改成句柄,所有权跟着句柄走)。真 React + happy-dom。
 *  ① dispose 之后 el 立刻还给调用方:清空它、在它上面再挂(同一拍或晚一拍)都行;
 *  ② 原地更新走句柄的 render(组件实例与 DOM 身份不变)—— 表格 / 输入卡 / 编辑器 / 对话的 update 靠它;
 *  ③ el 上一份没 dispose 就再挂:前一份被收掉,它的句柄此后是哑的(晚到的 render 顶不掉后来那份);
 *  ④ 两条历史教训:同一个容器不出现两个 root(旧树必须真卸掉)、旧句柄的 dispose 不清掉新挂载。
 * 负对照(2026-10-05 都实跑红过):root 直接建在 el 上(不加那一层)→ ① 前三条红(el 里还留着旧节点 / 再挂的内容不在文档里 /
 * 卸载抛 NotFoundError);再挂时不收前一份 → ③ 与「没 dispose 就清空 el」红;render 不看句柄死活 → ② ③ 红(往已卸的 root 上画);
 * dispose 不 unmount → 凡数卸载次数的都红;dispose 不看句柄死活 → ④ 末尾「登记没被旧句柄抹掉」红。
 */
import { act, createElement as h, useEffect, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountHostReact, type HostReactMount } from '@lcl/components'

let el: HTMLDivElement
const errors: unknown[] = []
const onError = (e: ErrorEvent): void => { errors.push(e.error ?? e.message); e.preventDefault() }
const log = { mounted: [] as string[], unmounted: [] as string[] }
const flush = () => act(async () => { await Promise.resolve() })

function Probe({ name, label = '' }: { name: string; label?: string }) {
  const [clicks, setClicks] = useState(0)
  useEffect(() => { log.mounted.push(name); return () => { log.unmounted.push(name) } }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return h('button', { 'data-probe': name, onClick: () => setClicks((n) => n + 1) }, `${label}${clicks}`)
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
    let mount!: HostReactMount
    await act(async () => { mount = mountHostReact(el, h(Probe, { name: 'a' })) })
    expect(probe('a')).not.toBeNull()
    await act(async () => {
      mount.dispose()
      expect([...el.children]).toEqual([own])
      expect(log.unmounted).toEqual([]) // 卸载还没落地
    })
    expect(log.unmounted).toEqual(['a'])
    expect(errors).toEqual([])
  })

  it('dispose → 清空 el → 同一拍再挂:新的那份在文档里', async () => {
    let mount!: HostReactMount
    await act(async () => { mount = mountHostReact(el, h(Probe, { name: 'a' })) })
    await act(async () => {
      mount.dispose()
      el.replaceChildren()
      mount = mountHostReact(el, h(Probe, { name: 'b' }))
    })
    expect(probe('b')?.isConnected).toBe(true)
    expect(probe('a')).toBeNull()
    expect(log.unmounted).toEqual(['a'])
    expect(errors).toEqual([])
    await act(async () => { mount.dispose() })
  })

  it('dispose → 清空 el → 不再挂 / 晚一拍再挂:卸载不报错', async () => {
    let mount!: HostReactMount
    await act(async () => { mount = mountHostReact(el, h(Probe, { name: 'a' })) })
    await act(async () => { mount.dispose(); el.replaceChildren() })
    await flush()
    expect(errors).toEqual([])
    expect(log.unmounted).toEqual(['a'])
    await act(async () => { mount = mountHostReact(el, h(Probe, { name: 'b' })) })
    expect(probe('b')?.isConnected).toBe(true)
    await act(async () => { mount.dispose() })
    expect(errors).toEqual([])
  })

  it('没 dispose 就清空了 el 再挂:另起一层,旧树照样卸掉', async () => {
    await act(async () => { mountHostReact(el, h(Probe, { name: 'a' })) })
    let mount!: HostReactMount
    await act(async () => { el.replaceChildren(); mount = mountHostReact(el, h(Probe, { name: 'b' })) })
    expect(probe('b')?.isConnected).toBe(true)
    expect(log.unmounted).toEqual(['a'])
    await act(async () => { mount.dispose() })
    expect(el.childElementCount).toBe(0)
    expect(errors).toEqual([])
  })
})

describe('原地更新走句柄的 render', () => {
  it('组件实例、DOM 节点、组件自己的状态都留着;dispose 幂等,之后 render 无效也不报错', async () => {
    const warn = vi.spyOn(console, 'error')
    let mount!: HostReactMount
    await act(async () => { mount = mountHostReact(el, h(Probe, { name: 'a' })) })
    const node = probe('a')!
    await act(async () => { node.click() })
    await act(async () => { mount.render(h(Probe, { name: 'a', label: 'n=' })) })
    expect(probe('a')).toBe(node)
    expect(node.textContent).toBe('n=1') // 新 props 到了,点出来的状态还在
    expect(log.mounted).toEqual(['a'])
    expect(el.childElementCount).toBe(1)

    await act(async () => { mount.dispose(); mount.dispose() })
    expect(el.childElementCount).toBe(0)
    expect(log.unmounted).toEqual(['a'])
    await act(async () => { mount.render(h(Probe, { name: 'a' })) })
    expect(el.childElementCount).toBe(0)
    expect(log.mounted).toEqual(['a'])
    expect(warn).not.toHaveBeenCalled()
    expect(errors).toEqual([])
  })
})

describe('所有权跟着句柄走', () => {
  it('el 上一份没 dispose 就再挂:前一份被收掉;它的句柄此后是哑的,晚到的 render / dispose 碰不到后来那份', async () => {
    const warn = vi.spyOn(console, 'error')
    let first!: HostReactMount, second!: HostReactMount
    await act(async () => { first = mountHostReact(el, h(Probe, { name: 'a' })) })
    await act(async () => { second = mountHostReact(el, h(Probe, { name: 'b' })) })
    const node = probe('b')
    expect(node?.isConnected).toBe(true)
    expect(probe('a')).toBeNull()
    expect(log.unmounted).toEqual(['a'])
    expect(el.childElementCount).toBe(1)

    await act(async () => { first.render(h(Probe, { name: 'a', label: 'late' })) }) // 宿主异步重画晚到(对话:加载中 → 接上)
    await act(async () => { first.dispose() })
    expect(probe('b')).toBe(node)
    expect(probe('a')).toBeNull()
    expect(el.childElementCount).toBe(1)
    expect(log.mounted).toEqual(['a', 'b'])

    await act(async () => { second.dispose() })
    expect(log.unmounted).toEqual(['a', 'b'])
    expect(el.childElementCount).toBe(0)
    expect(warn).not.toHaveBeenCalled()
    expect(errors).toEqual([])
  })
})

describe('历史教训:同容器双 root / 旧 dispose 清掉新挂载', () => {
  it('dispose 后同一拍重挂(React effect 的 cleanup → setup,不清 el):旧树恰好卸一次,新挂载留着,el 里只有一层', async () => {
    const warn = vi.spyOn(console, 'error')
    let first!: HostReactMount, second!: HostReactMount, third!: HostReactMount
    await act(async () => { first = mountHostReact(el, h(Probe, { name: 'a' })) })
    await act(async () => {
      first.dispose()
      second = mountHostReact(el, h(Probe, { name: 'b' }))
    })
    expect(log.unmounted).toEqual(['a'])
    expect(probe('b')?.isConnected).toBe(true)
    expect(el.childElementCount).toBe(1)
    expect(warn).not.toHaveBeenCalled() // React 对「同一个容器第二次 createRoot」会 console.error

    await act(async () => { first.dispose() }) // 旧句柄晚到 / 被重复调用
    const node = probe('b')
    expect(node?.isConnected).toBe(true)
    expect(log.unmounted).toEqual(['a'])
    await act(async () => { second.render(h(Probe, { name: 'b', label: 'again' })) }) // 新句柄的原地更新照常
    expect(probe('b')).toBe(node)
    expect(node!.textContent).toBe('again0')

    // 登记没被旧句柄抹掉:el 上再挂第三份,第二份照样被收掉,不会叠成两层
    await act(async () => { third = mountHostReact(el, h(Probe, { name: 'c' })) })
    expect(log.unmounted).toEqual(['a', 'b'])
    expect(el.childElementCount).toBe(1)
    await act(async () => { third.dispose() })
    expect(log.unmounted).toEqual(['a', 'b', 'c'])
    expect(el.childElementCount).toBe(0)
    expect(errors).toEqual([])
  })
})
