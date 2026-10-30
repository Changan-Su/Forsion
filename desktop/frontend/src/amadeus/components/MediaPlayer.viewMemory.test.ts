// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { fileViewKey, flushFileViews, writeFileView } from '../lib/fileViewMemory'
import { MediaPlayer } from './MediaPlayer'
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
vi.mock('../store/pageStore', () => ({ usePageStore: (s: any) => s({ files: ['clip.mp4'] }) }))
vi.mock('../lib/vaultFiles', () => ({ resolveFileName: () => 'clip.mp4', isAmbiguousFileRef: () => false }))
vi.mock('../lib/attachments', () => ({ getAttachmentPrefs: vi.fn() }))
vi.mock('../api', () => ({ amadeus: {} }))
vi.mock('../../i18n', () => ({ registerMessages: () => {}, useI18n: () => ({ t: (s: string) => s }) }))
afterEach(() => { flushFileViews(); localStorage.clear() })

it('restores media time/rate only after metadata and gives an explicit timestamp priority', async () => {
  const key = fileViewKey('media', '/vault', 'clip.mp4')
  writeFileView('media', key, { time: 7, rate: 1.5 })
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  const props = { kind: 'video' as const, url: 'http://localhost/clip.mp4', name: 'clip.mp4', pagePath: '', memoryKey: key, loc: null }
  await act(async () => root.render(createElement(MediaPlayer, props)))
  const media = host.querySelector('video')!
  expect(media.currentTime).toBe(0)
  Object.defineProperty(media, 'readyState', { value: 1, configurable: true })
  Object.defineProperty(media, 'duration', { value: 30, configurable: true })
  await act(async () => media.dispatchEvent(new Event('loadedmetadata')))
  expect(media.currentTime).toBe(7); expect(media.playbackRate).toBe(1.5)
  await act(async () => root.render(createElement(MediaPlayer, { ...props, loc: { at: 2, to: 4 } })))
  expect(media.currentTime).toBe(2)
  await act(async () => root.unmount()); host.remove()
})

it('plain-open clears a previously consumed timestamp range without moving playback', async () => {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(createElement(MediaPlayer, { kind: 'video', url: 'http://localhost/clip.mp4', name: 'clip.mp4', pagePath: '', loc: { at: 2, to: 4 } })))
  const media = host.querySelector('video')!
  const pause = vi.spyOn(media, 'pause').mockImplementation(() => {})
  Object.defineProperty(media, 'readyState', { value: 1, configurable: true })
  await act(async () => media.dispatchEvent(new Event('loadedmetadata')))
  await act(async () => window.dispatchEvent(new CustomEvent('amadeus:media-goto', { detail: { path: 'clip.mp4', clear: true } })))
  await act(async () => { media.currentTime = 5; media.dispatchEvent(new Event('timeupdate')) })
  expect(pause).not.toHaveBeenCalled(); expect(media.currentTime).toBe(5)
  await act(async () => root.unmount()); host.remove()
})
