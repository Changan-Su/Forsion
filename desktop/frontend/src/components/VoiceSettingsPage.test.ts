// @vitest-environment happy-dom
/**
 * 语音页换成设置卡片(10-25 走查续 4.5)是纯排法迁移:这里钉「写的键与时机没变」和卡头动作的三态,
 * 真 Electron 里的排版 / 深链 / 窄屏由 check:settingspolish 管。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLocaleGlobal } from '../i18n'
import '../i18n.generated' // 宿主在入口处注册的那批词条(朗读 / 识别的旧文案在这里)
import { VoiceSettingsPage } from './VoiceSettingsPage'
import type { StoredDesktopConfig } from '../types'

let el: HTMLDivElement
let root: Root
const w = window as unknown as { tangu?: Record<string, unknown> }
let progressCb: ((e: { received: number; total: number }) => void) | null = null
let finishDownload: (r: { ready: boolean }) => void = () => {}

function installTangu(over: { ready?: boolean; backend?: 'local' | 'cloud' } = {}) {
  const state = { ready: !!over.ready, backend: over.backend ?? 'cloud' }
  const setConfig = vi.fn(async (patch: Partial<StoredDesktopConfig>) => {
    if (patch.asrBackend) state.backend = patch.asrBackend as 'local' | 'cloud'
    return { ...patch } as StoredDesktopConfig
  })
  w.tangu = {
    setConfig,
    getConfig: vi.fn(async () => ({ asrBackend: state.backend })),
    asrLocalStatus: vi.fn(async () => ({ ready: state.ready, sizeBytes: 230 * 1048576 })),
    onAsrLocalProgress: (cb: typeof progressCb) => { progressCb = cb; return () => { progressCb = null } },
    asrLocalDownload: vi.fn(() => new Promise<{ ready: boolean }>((r) => { finishDownload = (x) => { state.ready = x.ready; r(x) } })),
    asrLocalRemove: vi.fn(async () => { state.ready = false }),
  }
  return { setConfig, state }
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const click = (node: Element | null | undefined) => act(async () => { (node as HTMLElement).click() })
const btn = (scope: ParentNode, text: string) => [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
const panel = (cls: string) => el.querySelector(`.${cls}`) as HTMLElement

async function render(stored: Partial<StoredDesktopConfig> | null, over: Partial<Parameters<typeof VoiceSettingsPage>[0]> = {}) {
  const props = {
    cfg: {} as never,
    stored: stored as StoredDesktopConfig | null,
    setStored: vi.fn(),
    providers: [],
    cloudModel: null,
    cloudAccount: false,
    signedIn: false,
    edit: vi.fn(),
    commitEdits: vi.fn(async () => {}),
    commitErrorHint: () => null,
    onOpen: vi.fn(),
    remoteExternal: false,
    ...over,
  }
  await act(async () => { root.render(createElement(VoiceSettingsPage, props)) })
  return props
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  setLocaleGlobal('zh')
  el = document.createElement('div'); document.body.append(el)
  root = createRoot(el)
})
afterEach(async () => {
  await act(async () => { root.unmount() })
  el.remove(); delete w.tangu; progressCb = null
  vi.unstubAllGlobals(); vi.restoreAllMocks()
})

describe('语音页(设置卡片)', () => {
  it('三张卡,每行都声明窄屏排法;没选朗读模型时音色照样能看,「去选模型」/「添加提供方」交给 onOpen', async () => {
    installTangu()
    const p = await render({ mode: 'external', backendUrl: 'http://127.0.0.1:1' })
    await flush()
    expect([...el.querySelectorAll('.settings-panel-head strong')].map((s) => s.textContent)).toEqual(['语音通话', '本地语音识别', '朗读'])
    expect(el.querySelectorAll('.settings-sec, .field').length).toBe(0)
    const rows = [...el.querySelectorAll<HTMLElement>('.settings-control-row')]
    expect(rows.every((r) => r.dataset.fit === 'inline' || r.dataset.fit === 'wrap')).toBe(true)
    const read = panel('settings-voice-read')
    expect(read.querySelector('.voice-gallery')).not.toBeNull()
    await click(btn(read, '去选模型'))
    expect(p.onOpen).toHaveBeenLastCalledWith('tts-model')
    await click(btn(panel('settings-voice-call'), '添加提供方'))
    expect(p.onOpen).toHaveBeenLastCalledWith('providers')
    expect(read.querySelector('.voice-tile-new')).toBeNull() // 没有百炼提供方:不给新建
  })

  it('写的键和时机照旧:音色走草稿 + 失焦提交,语速即时写,自动朗读即时写', async () => {
    const { setConfig } = installTangu()
    const p = await render({ ttsModelId: 'mine/foo-speech', ttsVoice: '', ttsSpeed: 1 })
    await flush()
    const read = panel('settings-voice-read')
    expect(btn(read, '去选模型')).toBeUndefined()
    expect(read.querySelector('.voice-link')?.textContent).toContain('mine/foo-speech')
    const voice = read.querySelector('input.settings-voice-tts') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(voice, 'alloy')
      voice.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(p.edit).toHaveBeenLastCalledWith({ ttsVoice: 'alloy' })
    await act(async () => { voice.focus(); voice.blur() })
    expect(p.commitEdits).toHaveBeenCalledWith(['ttsVoice'], expect.any(Function))
    const speed = read.querySelector('input.settings-voice-speed') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(speed, '1.5')
      speed.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(setConfig).toHaveBeenCalledWith({ ttsSpeed: 1.5 })
    await click(read.querySelector('[role="switch"]'))
    expect(setConfig).toHaveBeenCalledWith({ ttsAutoSpeak: true })
  })

  it('有百炼提供方:「新建音色」打开共用弹层;非本地 external 后端不给新建', async () => {
    installTangu()
    const ds = { providerId: 'bailian', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'k' } as never
    await render({ mode: 'managed' }, { providers: [ds] })
    await flush()
    await click(panel('settings-voice-read').querySelector('.voice-tile-new'))
    expect(document.body.querySelector('.voice-create select.voice-create-model')).not.toBeNull()
    await click(document.body.querySelector('.voice-create .icon-btn'))
    expect(document.body.querySelector('.voice-create')).toBeNull()
    await render({ mode: 'external', backendUrl: 'https://remote.example' }, { providers: [ds], remoteExternal: true })
    await flush()
    expect(panel('settings-voice-read').querySelector('.voice-tile-new')).toBeNull()
  })

  it('本地语音识别:下载 → 进度 → 已下载 · 在用(下完自动选它)→ 删除退回云端', async () => {
    const { setConfig, state } = installTangu()
    await render(null)
    await flush()
    const asr = () => panel('settings-voice-asr')
    await click(btn(asr(), '下载'))
    await act(async () => { progressCb?.({ received: 42, total: 100 }) })
    expect(asr().querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('42')
    await act(async () => { finishDownload({ ready: true }) })
    await flush()
    expect(setConfig).toHaveBeenCalledWith({ asrBackend: 'local' })
    expect(asr().querySelector('.settings-voice-ready')?.textContent).toContain('已下载 · 在用')
    expect(btn(asr(), '使用')).toBeUndefined()
    await click(asr().querySelector('button[title="删除"]'))
    await flush()
    expect(setConfig).toHaveBeenLastCalledWith({ asrBackend: 'cloud' })
    expect(state.ready).toBe(false)
    expect(btn(asr(), '下载')).toBeDefined()
  })

  it('本地语音识别:已下载但没在用 →「使用」写 asrBackend=local', async () => {
    const { setConfig } = installTangu({ ready: true, backend: 'cloud' })
    await render(null)
    await flush()
    const asr = panel('settings-voice-asr')
    expect(asr.querySelector('.settings-voice-ready')?.textContent?.trim()).toBe('已下载')
    await click(btn(asr, '使用'))
    expect(setConfig).toHaveBeenCalledWith({ asrBackend: 'local' })
  })
})
