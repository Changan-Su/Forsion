// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { create } from 'zustand'

const send = vi.fn()
vi.mock('../stores/appStore', () => {
  // desktopConfig 故意是旧值:组件必须以检测那一刻的宿主配置为准。
  const useApp = create(() => ({ connState: 'ok', modelsResp: { models: [{ id: 'm' }] }, desktopConfig: { mirror: 'default', mode: 'managed' }, send }))
  return { useApp }
})
vi.mock('@lcl/engine', () => ({ useWorkspace: { getState: () => ({ openView: vi.fn() }) } }))
vi.mock('../i18n', () => ({ registerMessages: () => {}, useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('./envProbe.css', () => ({}))
const { EnvProbeSection } = await import('./EnvProbeSection')

let container: HTMLDivElement, root: Root
const probes = [
  { tool: 'node', found: true, version: 'v22.23.1', installId: null, installCommand: null },
  { tool: 'git', found: false, version: null, installId: 'env_git_1', installCommand: 'brew install git' },
  { tool: 'tangu', found: false, version: null, installId: null, installCommand: null },
]
async function render(config: { mode: string; mirror: string }) {
  window.tangu = { envCheck: vi.fn().mockResolvedValue(probes), getConfig: vi.fn().mockResolvedValue(config) } as any
  await act(async () => root.render(React.createElement(EnvProbeSection)))
}
const askButtons = () => [...container.querySelectorAll('button')].filter((b) => b.textContent?.includes('env.askTangu'))
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  send.mockReset()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); delete window.tangu; vi.unstubAllGlobals() })

it('hands installs to Tangu only for the local managed backend, using the mirror saved at check time', async () => {
  await render({ mode: 'managed', mirror: 'china' })
  const row = container.querySelector('[data-tool="git"]')!
  expect(row.getAttribute('data-state')).toBe('missing')
  expect(askButtons()).toHaveLength(1) // git 一行;tangu CLI 由启动自愈,只报告
  expect(container.querySelector('[data-tool="tangu"] .env-probe-actions')).toBeNull()
  await act(async () => askButtons()[0].click())
  expect(send.mock.calls[0][0]).toContain('国内镜像源')
})

it('offers only the host install command when connected to an external backend', async () => {
  await render({ mode: 'external', mirror: 'default' })
  expect(askButtons()).toHaveLength(0)
  expect(container.querySelector('[data-tool="git"] .env-probe-actions')?.textContent).toContain('onboarding.env.install')
})

it('reports a failed check instead of rendering an empty list', async () => {
  window.tangu = { envCheck: vi.fn().mockRejectedValue(new Error('probe crashed')), getConfig: vi.fn() } as any
  await act(async () => root.render(React.createElement(EnvProbeSection)))
  expect(container.querySelector('.env-probe-summary.is-error')?.textContent).toContain('env.checkFailed')
  expect(container.querySelector('.env-probe-list')).toBeNull()
})
