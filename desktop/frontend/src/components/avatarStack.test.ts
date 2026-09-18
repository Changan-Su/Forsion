// @vitest-environment happy-dom
// 组合头像的纯几何(方案 §3.3 那张表)+ 一层渲染冒烟。
//
// 为什么值得单测:这四档几何是「看起来对不对」的唯一可断言的那半 —— 真实渲染要到
// check:orbitside 的真 Electron 里才量得到,而那道闸跑一次以分钟计。这里钉死数,
// 那边只需确认 DOM 真按这些数落位。
//
// 不变式(比具体数字更耐改):每一档都**填满内区** —— max(x+size) === max(y+size) === inner。
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AvatarStack, avatarColorIndex, avatarStackLayout } from './AvatarStack'

const extent = (cells: Array<{ x: number; y: number; size: number }>) => ({
  right: Math.max(...cells.map((c) => c.x + c.size)),
  bottom: Math.max(...cells.map((c) => c.y + c.size)),
})

describe('avatarStackLayout', () => {
  it('n=1:单圆铺满 26 内区', () => {
    expect(avatarStackLayout(1)).toEqual([{ x: 0, y: 0, size: 26 }])
  })

  it('n=2:两枚 17px 沿对角错开 9px,第二枚压在第一枚上', () => {
    const cells = avatarStackLayout(2)
    expect(cells).toEqual([
      { x: 0, y: 0, size: 17 },
      { x: 9, y: 9, size: 17 },
    ])
    // 第二枚在 DOM 里必须排在后面才压得住(渲染靠文档序,不靠 z-index)。
    expect(cells[1].x).toBeGreaterThan(cells[0].x)
  })

  it('n=3:三枚 13px,下面那枚居中于 6.5', () => {
    expect(avatarStackLayout(3)).toEqual([
      { x: 0, y: 0, size: 13 },
      { x: 13, y: 0, size: 13 },
      { x: 6.5, y: 13, size: 13 },
    ])
  })

  it('n=4:2×2 格、12px、格距 2,四格都是脸、没有 +N', () => {
    const cells = avatarStackLayout(4)
    expect(cells).toEqual([
      { x: 0, y: 0, size: 12 },
      { x: 14, y: 0, size: 12 },
      { x: 0, y: 14, size: 12 },
      { x: 14, y: 14, size: 12 },
    ])
    // 恰好 4 人不许出徽章:键本身都不该存在(`more: undefined` 会被 toEqual 放过,所以另钉一条)。
    expect(cells.every((c) => !('more' in c))).toBe(true)
    expect(cells[1].x - (cells[0].x + cells[0].size)).toBe(2)
  })

  it('n=5:前三格是脸,第四格换成 +2 徽章', () => {
    const cells = avatarStackLayout(5)
    expect(cells).toHaveLength(4)
    expect(cells[3]).toEqual({ x: 14, y: 14, size: 12, more: 2 })
    expect(cells.slice(0, 3).every((c) => !('more' in c))).toBe(true)
  })

  it('人再多也只有四格,徽章数 = n - 3(画出来的永远是 3 张脸)', () => {
    expect(avatarStackLayout(9)).toHaveLength(4)
    expect(avatarStackLayout(9)[3].more).toBe(6)
    expect(avatarStackLayout(128)[3].more).toBe(125)
  })

  it('n ≤ 0 / 非法值返回空布局:0 成员的团队不画假头像', () => {
    expect(avatarStackLayout(0)).toEqual([])
    expect(avatarStackLayout(-3)).toEqual([])
    expect(avatarStackLayout(0.6)).toEqual([])
    expect(avatarStackLayout(Number.NaN)).toEqual([])
  })

  it('每一档都填满内区(换外框边长也成立)', () => {
    for (const inner of [26, 40]) {
      for (const n of [1, 2, 3, 4, 5]) {
        const cells = avatarStackLayout(n, inner)
        const { right, bottom } = extent(cells)
        expect({ n, inner, right, bottom }).toEqual({ n, inner, right: inner, bottom: inner })
        expect(cells.every((c) => c.x >= 0 && c.y >= 0 && c.size > 0)).toBe(true)
      }
    }
  })

  it('inner 可参数化:40 内区下各档按比例重算,不是把 26 那套硬搬', () => {
    expect(avatarStackLayout(1, 40)).toEqual([{ x: 0, y: 0, size: 40 }])
    expect(avatarStackLayout(2, 40)).toEqual([
      { x: 0, y: 0, size: 27 },
      { x: 13, y: 13, size: 27 },
    ])
    expect(avatarStackLayout(4, 40).map((c) => c.size)).toEqual([19, 19, 19, 19])
  })
})

describe('avatarColorIndex', () => {
  it('恒落在 1..6(= --c1..--c6 六档色板)且对同一 slug 稳定', () => {
    const slugs = ['tangu-ario', 'muse', 'fio', '', 'a', '张三']
    for (const slug of slugs) {
      const idx = avatarColorIndex(slug)
      expect(idx).toBeGreaterThanOrEqual(1)
      expect(idx).toBeLessThanOrEqual(6)
      expect(avatarColorIndex(slug)).toBe(idx)
    }
  })

  it('不同 slug 会分到不同档(不是恒一档)', () => {
    const seen = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(avatarColorIndex))
    expect(seen.size).toBeGreaterThan(1)
  })
})

// 渲染冒烟:几何由 check:orbitside 在真 Electron 里量,这里只钉「渲得出来 + 属性没漏」。
// 最值钱的一条是 <img> 的 width/height **属性** —— 漏了不报错、不崩,只是在真侧栏里按原始
// 32/48px 撑爆行(check:listsrc 的老账),而套了容器的台架照样全绿。
describe('<AvatarStack> 渲染', () => {
  let host: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  const items = (n: number, withAvatar = false) =>
    Array.from({ length: n }, (_, i) => ({
      slug: `a${i}`,
      name: `Agent ${i}`,
      ...(withAvatar ? { avatarUrl: `blob:agent-${i}` } : null),
    }))

  const render = (node: React.ReactElement) => act(() => { root.render(node) })

  beforeEach(() => {
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(() => { act(() => root.unmount()); host.remove() })

  it('data-n 报的是传入人数,不是画出来的格数', async () => {
    await render(React.createElement(AvatarStack, { items: items(7) }))
    expect(host.querySelector('.t2o-avstack')?.getAttribute('data-n')).toBe('7')
    expect(host.textContent).toContain('+4')
  })

  it('有头像的格是 <img>,且 width/height 写成属性(不只是 style)', async () => {
    await render(React.createElement(AvatarStack, { items: items(3, true) }))
    const imgs = [...host.querySelectorAll('img')]
    expect(imgs).toHaveLength(3)
    for (const img of imgs) {
      expect(img.getAttribute('width')).toBe('13')
      expect(img.getAttribute('height')).toBe('13')
      expect(img.style.objectFit).toBe('cover')
      expect(img.style.borderRadius).toBe('50%')
    }
  })

  it('无头像退首字;外框吃 size 入参,className 与内置类并存', async () => {
    await render(React.createElement(AvatarStack, { items: items(1), size: 40, className: 't2o-team-avatar' }))
    const box = host.querySelector('.t2o-avstack') as HTMLElement
    expect(box.classList.contains('t2o-team-avatar')).toBe(true)
    expect(box.style.width).toBe('40px')
    expect(host.querySelector('img')).toBeNull()
    expect(host.textContent).toBe('A')
  })

  it('整体 emoji(团队 avatar):整格显示 emoji,不合成成员头像;与成员数无关', async () => {
    await render(React.createElement(AvatarStack, { items: [{ slug: 'muse', name: 'Muse' }], emoji: '✦' }))
    expect(host.textContent).toBe('✦')
    expect(host.querySelector('img')).toBeNull()
  })

  it('整体图片(团队上传头像)优先于 emoji 与成员头像:只画一张铺满外框的图,data-n 照旧', async () => {
    await render(React.createElement(AvatarStack, { items: items(3, true), emoji: '✦', imageUrl: 'blob:team', size: 30 }))
    const imgs = [...host.querySelectorAll('img')]
    expect(imgs).toHaveLength(1)
    expect(imgs[0].getAttribute('src')).toBe('blob:team')
    expect(imgs[0].getAttribute('width')).toBe('30')
    expect(imgs[0].getAttribute('height')).toBe('30')
    expect(host.textContent).toBe('')
    expect(host.querySelector('.t2o-avstack')?.getAttribute('data-n')).toBe('3')
  })

  it('空成员表不崩,也不画假头像', async () => {
    await render(React.createElement(AvatarStack, { items: [] }))
    const box = host.querySelector('.t2o-avstack') as HTMLElement
    expect(box.getAttribute('data-n')).toBe('0')
    expect(box.textContent).toBe('')
  })
})
