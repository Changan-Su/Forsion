// @vitest-environment happy-dom
// 胶囊把转写交回主进程时,文字只能记在**开始录这段音的那次会话**头上。
// useVoiceInput 换了 scope 也会让已经按了「停」的那段继续转写完(回调在开始录音时定格),所以上一次的结果可能在下一次已经开录之后才到;
// 那时它必须被丢掉,不能当成新会话的结果交上去(主进程会把它写进新会话的目标)。
// 负对照(已实跑红):onResult 改回读 recordingFor.current(不按会话定格)→「late result」那条红。
import { act } from 'react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { DictationState } from '../../../shared/dictation'

const started: Array<(text: string) => void> = []
vi.mock('../hooks/useVoiceInput', () => ({
  useVoiceInput: (onResult: (text: string) => void) => ({
    recording: false, busy: false, error: null, supported: true, analyser: null, preview: null,
    toggle: () => { started.push(onResult) },
    cancel: () => {},
  }),
}))

const sent: Array<[string, string]> = []
let push: (s: DictationState) => void = () => {}
const base: Omit<DictationState, 'phase' | 'sessionId'> = { enabled: true, hotkey: 'alt+shift+space', registered: true, accessibility: true, platform: 'darwin', locale: 'en' }

beforeAll(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  document.body.innerHTML = '<div id="root"></div>'
  ;(window as unknown as { forsionDictation: unknown }).forsionDictation = {
    onState: (cb: (s: DictationState) => void) => { push = cb; return () => {} },
    result: (id: string, text: string) => { sent.push([id, text]) },
    error: () => {},
    action: () => {},
  }
  await act(async () => { await import('./capsule') })
})

describe('dictation capsule', () => {
  it('a late result from the previous session is dropped, not handed to the next one', async () => {
    await act(async () => { push({ ...base, phase: 'listening', sessionId: 'A' }) })
    expect(started).toHaveLength(1)
    await act(async () => { push({ ...base, phase: 'finishing', sessionId: 'A' }) })
    await act(async () => { push({ ...base, phase: 'idle', sessionId: 'A' }) }) // cancelled while A was still transcribing
    await act(async () => { push({ ...base, phase: 'listening', sessionId: 'B' }) })
    expect(started).toHaveLength(2)
    const [resultA, resultB] = started
    await act(async () => { resultA('what was said in A') })
    expect(sent).toEqual([])
    await act(async () => { resultB('what was said in B') })
    expect(sent).toEqual([['B', 'what was said in B']])
  })
})
