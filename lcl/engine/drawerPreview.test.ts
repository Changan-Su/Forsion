// @vitest-environment happy-dom
/**
 * 系统返回手势的预览(SingleColumnHost 的 drawerPreview)在落定那一下的收尾。
 * 病史(2026-11-15 安卓真壳):落定 = flushSync(toggleSidebar),开合同步跑 workspace 的订阅;其中一个抛错
 * (插件 claimHeader 的 toList 回调里 view.setParams 抛「View has been disposed」)把后面的 release / 下一帧清理跳过,
 * .mb-body 一直留着 data-drag、左栏停在屏外、主区停在 0,之后返回、切 Space 都回不来,只能重开 App。
 * 负对照(2026-11-15 实跑):end() 里的 try/finally 拿掉 → 第一条红(data-drag 还在)。
 */
import { act, createElement as h, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useWorkspace } from './singleColumnStore'
import { drawerPreview, useDrawerDrag } from './SingleColumnHost'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
const offs: Array<() => void> = []

function Body() {
  const ref = useRef<HTMLDivElement | null>(null)
  useDrawerDrag(ref, false, true, false)
  return h('div', { ref, className: 'mb-body' },
    h('div', { className: 'mb-drawer mb-drawer--left' }), h('div', { className: 'mb-main' }), h('div', { className: 'mb-push-dim' }))
}
const body = (): HTMLElement => document.querySelector<HTMLElement>('.mb-body')!
const panel = (): HTMLElement => document.querySelector<HTMLElement>('.mb-drawer--left')!
const main = (): HTMLElement => document.querySelector<HTMLElement>('.mb-main')!
const frame = (): Promise<void> => act(async () => { await new Promise<void>((r) => requestAnimationFrame(() => r())); await new Promise((r) => setTimeout(r, 0)) })

beforeEach(async () => {
  useWorkspace.setState({ leftVisible: false, rightVisible: false })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root.render(h(Body)) })
  // happy-dom 不排版:面板要量得出宽度,预览才认它(arm 拿宽度判「面板挂上了没有」)
  panel().getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 412, bottom: 800, width: 412, height: 800, toJSON() {} }) as DOMRect
})
afterEach(async () => {
  offs.splice(0).forEach((off) => off())
  await act(async () => { root.unmount() })
  host.remove()
})

it('落定时 workspace 的订阅抛错:错照样往上抛,但预览收尾(下一帧摘 data-drag、清内联位移)照做', async () => {
  expect(drawerPreview.begin('left')).toBe(true)
  drawerPreview.move(0.4)
  expect(body().dataset.drag).toBe('left')
  expect(main().style.transform).not.toBe('')
  offs.push(useWorkspace.subscribe((s, prev) => { if (s.leftVisible && !prev.leftVisible) throw new Error('View has been disposed') }))
  expect(() => drawerPreview.end(true)).toThrow('View has been disposed')
  expect(useWorkspace.getState().leftVisible).toBe(true) // 开合本身已经发生
  await frame()
  expect(body().hasAttribute('data-drag')).toBe(false)
  expect(panel().style.transform).toBe('')
  expect(main().style.transform).toBe('')
  // 之后的返回还起得了手(sys 没留着)
  expect(drawerPreview.begin('left')).toBe(true)
  expect(drawerPreview.end(false)).toBe(true)
  await frame()
  expect(body().hasAttribute('data-drag')).toBe(false)
})

it('没人抛错时照旧:落定开合、下一帧摘 data-drag', async () => {
  expect(drawerPreview.begin('left')).toBe(true)
  expect(drawerPreview.end(true)).toBe(true)
  expect(useWorkspace.getState().leftVisible).toBe(true)
  await frame()
  expect(body().hasAttribute('data-drag')).toBe(false)
  expect(main().style.transform).toBe('')
})
