// @vitest-environment happy-dom
/** 只钉一件事:卡片真的挂在壳里。去掉壳时别的单测都不红,只有不进 CI 的 check:visualize 能发现(那等于卡片又能导航出去)。 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
vi.mock('./sketch.css?raw', () => ({ default: '' }))
import { SketchCards } from './SketchCard'
import { SKETCH_SANDBOX, SKETCH_SHELL_CSP } from './sketchWrapper'

describe('SketchCards', () => {
  it('mounts model HTML inside the navigation shell, never directly under the host', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => { root.render(createElement(SketchCards, { items: [{ callId: 'card', html: '<b id="model">x</b>' }] })) })
    const frame = host.querySelector('iframe')
    expect(frame?.getAttribute('sandbox')).toBe(SKETCH_SANDBOX)
    const srcdoc = frame?.getAttribute('srcdoc') ?? ''
    expect(srcdoc).toContain(`content="${SKETCH_SHELL_CSP}"`)
    expect(srcdoc).toContain(`<iframe sandbox="${SKETCH_SANDBOX}"`)
    expect(srcdoc).not.toContain('<b id="model">')
    await act(async () => { root.unmount() })
  })
})
