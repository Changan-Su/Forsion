// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useApp } from '../../stores/appStore'
import { useComposerDrafts, setDraftField } from './composerDrafts'
import { PROMPT_SUGGEST_KEY, clearSuggestion, isPromptSuggestOn, requestSuggestion, setPromptSuggest, usePromptSuggest } from './promptSuggest'

const initialApp = useApp.getState()
const json = (body: object, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const shown = (sid = 's1'): string | undefined => usePromptSuggest.getState().bySession[sid]
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  useApp.setState({ cfg: { ...initialApp.cfg, backendUrl: 'http://engine', token: 'tok' }, activeId: 's1' })
  usePromptSuggest.setState({ bySession: {} })
  useComposerDrafts.setState({}, true)
  localStorage.removeItem(PROMPT_SUGGEST_KEY)
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { useApp.setState(initialApp, true); vi.unstubAllGlobals() })

describe('输入建议', () => {
  it('默认关:一轮结束不发任何请求', async () => {
    expect(isPromptSuggestOn()).toBe(false)
    await requestSuggestion('s1', 'r1')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(shown()).toBeUndefined()
  })

  it('开着:按会话拉一次,带上刚结束的 run;拿到的那句按会话存', async () => {
    setPromptSuggest(true)
    fetchMock.mockResolvedValueOnce(json({ suggestion: ' 跑一下测试 ' }))
    await requestSuggestion('s1', 'r1')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://engine/agent/sessions/s1/suggest')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toMatchObject({ run_id: 'r1' })
    expect(shown()).toBe('跑一下测试')
    expect(shown('s2')).toBeUndefined()
  })

  it('空串 / 老引擎 404 / 请求失败 → 就是没有,不抛', async () => {
    setPromptSuggest(true)
    fetchMock.mockResolvedValueOnce(json({ suggestion: '' }))
    await requestSuggestion('s1', 'r1')
    fetchMock.mockResolvedValueOnce(new Response('Cannot POST /agent/sessions/s1/suggest', { status: 404 }))
    await requestSuggestion('s1', 'r2')
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    await requestSuggestion('s1', 'r3')
    expect(shown()).toBeUndefined()
  })

  it('已经在打字了 → 不拉(灰字只在空输入框里出现)', async () => {
    setPromptSuggest(true)
    setDraftField('s1', 'text', '我自己写')
    await requestSuggestion('s1', 'r1')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('新的一轮结束先作废上一句;在飞时被作废的那句回来也不要', async () => {
    setPromptSuggest(true)
    fetchMock.mockResolvedValueOnce(json({ suggestion: '旧的' }))
    await requestSuggestion('s1', 'r1')
    let release: (r: Response) => void = () => {}
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve }))
    const pending = requestSuggestion('s1', 'r2')
    expect(shown()).toBeUndefined() // 一发起就清掉旧的
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2)) // 请求真的发出去了(engineFetch 内部先过几个微任务)
    clearSuggestion('s1') // 用户发了新消息 / 开始打字
    release(json({ suggestion: '迟到的' }))
    await pending
    expect(shown()).toBeUndefined()
  })

  it('关掉开关:已有的建议一并清空', async () => {
    setPromptSuggest(true)
    fetchMock.mockResolvedValueOnce(json({ suggestion: '跑吧' }))
    await requestSuggestion('s1', 'r1')
    setPromptSuggest(false)
    expect(shown()).toBeUndefined()
    expect(localStorage.getItem(PROMPT_SUGGEST_KEY)).toBeNull()
  })
})
