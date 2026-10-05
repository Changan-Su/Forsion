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
 * 评审后补的三条(同日实跑红):render 不把游离的那一层接回去 → 「清空过 el」红;dispose 不调 onDispose → 「onDispose」红;
 * 落地的挂载不登记认领 → 「认领」红;先收前一份再登记新的(收尾回调重入时登记被盖)→ 「重入」红。
 */
import { act, createElement as h, useEffect, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { claimHostMount, mountHostReact, type HostReactMount } from '@lcl/components'

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

describe('原地更新:调用方没 dispose 就清空过 el', () => {
  it('句柄的 render 把那一层接回去,组件实例和状态都还在', async () => {
    let mount!: HostReactMount
    await act(async () => { mount = mountHostReact(el, h(Probe, { name: 'a' })) })
    const node = probe('a')!
    await act(async () => { node.click() })
    el.replaceChildren()
    expect(node.isConnected).toBe(false)
    await act(async () => { mount.render(h(Probe, { name: 'a', label: 'n=' })) })
    expect(probe('a')).toBe(node)
    expect(node.isConnected).toBe(true)
    expect(node.textContent).toBe('n=1')
    expect(el.childElementCount).toBe(1)
    await act(async () => { mount.dispose() })
    expect(el.childElementCount).toBe(0)
    expect(errors).toEqual([])
  })
})

describe('onDispose:这次挂载结束时恰好一次', () => {
  it('自己 dispose 的、被后来的挂载收掉的都调;重复 dispose 不重复调;回调抛错不拦住后来的挂载', async () => {
    const ended: string[] = []
    let a!: HostReactMount, b!: HostReactMount
    await act(async () => { a = mountHostReact(el, h(Probe, { name: 'a' }), () => { ended.push('a') }) })
    await act(async () => { a.dispose(); a.dispose() })
    expect(ended).toEqual(['a'])

    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => { b = mountHostReact(el, h(Probe, { name: 'b' }), () => { ended.push('b'); throw new Error('cleanup blew up') }) })
    await act(async () => { mountHostReact(el, h(Probe, { name: 'c' }), () => { ended.push('c') }).dispose() })
    expect(ended).toEqual(['a', 'b', 'c'])
    expect(logged).toHaveBeenCalledTimes(1)
    await act(async () => { b.dispose() })
    expect(ended).toEqual(['a', 'b', 'c'])
    expect(log.unmounted).toEqual(['a', 'b']) // c 同一拍就卸了,组件没来得及挂上
    expect(errors).toEqual([])
  })
})

describe('onDispose 里又往同一个 el 上挂(重入)', () => {
  it('只留最后调用的那一份,登记没乱:之后再挂照样收得掉它', async () => {
    let inner: HostReactMount | null = null
    let outer!: HostReactMount, last!: HostReactMount
    await act(async () => { mountHostReact(el, h(Probe, { name: 'a' }), () => { inner = mountHostReact(el, h(Probe, { name: 'c' })) }) })
    await act(async () => { outer = mountHostReact(el, h(Probe, { name: 'b' })) }) // 收掉 a → a 的收尾回调里挂了 c
    expect(el.childElementCount).toBe(1)
    expect(probe('c')?.isConnected).toBe(true) // c 是最后调用的
    expect(probe('b')).toBeNull()
    await act(async () => { outer.dispose() }) // 外层那份已经被 c 收掉,它的句柄是哑的
    expect(probe('c')?.isConnected).toBe(true)

    await act(async () => { last = mountHostReact(el, h(Probe, { name: 'd' })) })
    expect(el.childElementCount).toBe(1)
    expect(probe('d')?.isConnected).toBe(true)
    await act(async () => { inner!.dispose(); last.dispose() })
    expect(el.childElementCount).toBe(0)
    expect(errors).toEqual([])
  })
})

describe('认领(claimHostMount):真正挂载要等动态 import 的调用,落地时问一句 el 还归不归自己', () => {
  it('后来的认领、后来落地的挂载都让先前的认领作废;换一个 el 互不相干', async () => {
    const first = claimHostMount(el)
    expect(first()).toBe(true)
    const second = claimHostMount(el)
    expect([first(), second()]).toEqual([false, true]) // 请求顺序说了算:先请求的那份就算后落地也不能挂

    const elsewhere = claimHostMount(document.createElement('div'))
    let mount!: HostReactMount
    await act(async () => { mount = mountHostReact(el, h(Probe, { name: 'a' })) }) // 一次同步的挂载也是一次认领
    expect([second(), elsewhere()]).toEqual([false, true])
    await act(async () => { mount.dispose() })
    expect(second()).toBe(false) // 那份挂载卸了,先前的请求也不会复活
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
