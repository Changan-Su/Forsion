// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

let root: Root, host: HTMLElement
let mod: typeof import('./WhatsNewDialog')
const download = vi.fn(async (_opts?: { auto?: boolean }) => {})
const dialog = () => host.querySelector('.wn-modal')

beforeEach(async () => {
  vi.resetModules()
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear(); download.mockClear()
  window.tangu = { downloadUpdate: download } as any
  mod = await import('./WhatsNewDialog')
  const { LocaleProvider } = await import('../i18n')
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(React.createElement(LocaleProvider, { children: React.createElement(mod.WhatsNewHost) })))
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); delete window.tangu })

const emit = (st: any) => act(async () => mod.maybeAutoOpenWhatsNew(st))
const available = { phase: 'available', version: '2.14.4', source: 'github', manualInstall: false }

it('a GitHub update downloads in the background and only pops once it is downloaded', async () => {
  await emit({ ...available, autoDownload: true })
  expect(download).toHaveBeenCalledWith({ auto: true, version: '2.14.4' })
  expect(dialog()).toBeNull()
  await emit({ ...available, autoDownload: true, phase: 'downloading', percent: 40 })
  expect(dialog()).toBeNull()
  await emit({ ...available, autoDownload: true, phase: 'downloaded' })
  expect(dialog()).not.toBeNull()
  expect(download).toHaveBeenCalledTimes(1)
})

it('a failed background download falls back to asking, and a later check retries it', async () => {
  await emit({ ...available, autoDownload: true })
  await emit({ ...available, autoDownload: false })
  expect(dialog()).not.toBeNull()
  expect(download).toHaveBeenCalledTimes(1)
  await emit({ ...available, autoDownload: true }) // 6 小时后再查:又能自动下了
  expect(download).toHaveBeenCalledTimes(2)
})

it('website-source updates, manual-install macs and skipped versions are never downloaded automatically', async () => {
  await emit({ ...available, source: 'website' })
  expect(download).not.toHaveBeenCalled()
  expect(dialog()).not.toBeNull()
  await emit({ ...available, version: '2.14.5', autoDownload: true, manualInstall: true })
  expect(download).not.toHaveBeenCalled()
  localStorage.setItem('forsion_update_skipped_version', '2.14.6')
  await emit({ ...available, version: '2.14.6', autoDownload: true })
  expect(download).not.toHaveBeenCalled()
})

it('after a failed background download was shown, a later successful retry still pops when it is ready', async () => {
  await emit({ ...available, autoDownload: true })
  await emit({ ...available, autoDownload: false }) // 没下成:照常弹,用户点了「稍后」
  expect(dialog()).not.toBeNull()
  const later = [...host.querySelectorAll<HTMLButtonElement>('.wn-modal button')].find((b) => /稍后|Later/.test(b.textContent || ''))
  await act(async () => later!.click())
  expect(dialog()).toBeNull()
  await emit({ ...available, autoDownload: true }) // 6 小时后重试
  await emit({ ...available, autoDownload: true, phase: 'downloaded' })
  expect(dialog()).not.toBeNull()
})
