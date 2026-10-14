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
  vi.stubGlobal('tangu', { backendStatus: () => {} }) // 桌面宿主:开关只在这儿算数
})
afterEach(() => { useApp.setState(initialApp, true); vi.unstubAllGlobals() })

describe('输入建议', () => {
  it('缺省开(10-14 用户定):没存过就去拉;关掉存成 0,再开回到「没存」', async () => {
    expect(isPromptSuggestOn()).toBe(true)
    fetchMock.mockResolvedValueOnce(json({ suggestion: '跑一下测试' }))
    await requestSuggestion('s1', 'r1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    setPromptSuggest(false)
    expect(localStorage.getItem(PROMPT_SUGGEST_KEY)).toBe('0')
    await requestSuggestion('s1', 'r2')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    setPromptSuggest(true)
    expect(localStorage.getItem(PROMPT_SUGGEST_KEY)).toBeNull()
    localStorage.setItem(PROMPT_SUGGEST_KEY, '1') // 10-14 之前开着存下的值
    expect(isPromptSuggestOn()).toBe(true)
  })

  it('不是桌面宿主(网页版 / 手机 / 设备页):缺省开也不拉', async () => {
    for (const host of [undefined, { cloudWeb: true }, { backendStatus: () => {}, mobile: true }, { backendStatus: () => {}, unitPage: true }]) {
      vi.stubGlobal('tangu', host)
      expect(isPromptSuggestOn()).toBe(false)
      await requestSuggestion('s1', 'r1')
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('没有 window(Node 里跑的 store 测试收到 done):不抛,当作没有', async () => {
    vi.stubGlobal('window', undefined)
    expect(isPromptSuggestOn()).toBe(false)
    await expect(requestSuggestion('s1', 'r1')).resolves.toBeUndefined()
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

  it('常驻:输入框里有字也照拉照存(有字时只是藏着,删空就显示);不是眼前的会话也一样', async () => {
    setPromptSuggest(true)
    setDraftField('s1', 'text', '我自己写')
    fetchMock.mockResolvedValueOnce(json({ suggestion: '跑一下测试' }))
    await requestSuggestion('s1', 'r1')
    expect(shown()).toBe('跑一下测试')
    fetchMock.mockResolvedValueOnce(json({ suggestion: '后台那句' }))
    await requestSuggestion('s2', 'r9') // 眼前是 s1
    expect(shown('s2')).toBe('后台那句')
    expect(shown()).toBe('跑一下测试')
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
    clearSuggestion('s1') // 用户发了新消息,新一轮起跑
    release(json({ suggestion: '迟到的' }))
    await pending
    expect(shown()).toBeUndefined()
  })

  it('请求在路上时用户打了字:回来的那句照样落地;关了开关:不落地', async () => {
    for (const [interrupt, landed] of [[() => setDraftField('s1', 'text', '我自己写'), '迟到的'], [() => localStorage.setItem(PROMPT_SUGGEST_KEY, '0'), undefined]] as const) {
      setPromptSuggest(true)
      usePromptSuggest.setState({ bySession: {} })
      let release: (r: Response) => void = () => {}
      fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve }))
      const pending = requestSuggestion('s1', 'r1')
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
      interrupt()
      release(json({ suggestion: '迟到的' }))
      await pending
      expect(shown()).toBe(landed)
      fetchMock.mockClear()
      useComposerDrafts.setState({}, true)
    }
  })

  it('新一轮起跑(appStore.subscribeRun)就作废上一句 —— 不靠这个会话的输入框挂没挂着', async () => {
    setPromptSuggest(true)
    fetchMock.mockResolvedValueOnce(json({ suggestion: '旧的' }))
    await requestSuggestion('s1', 'r1')
    expect(shown()).toBe('旧的')
    fetchMock.mockImplementation(() => new Promise<Response>(() => {})) // 事件流挂住
    vi.useFakeTimers() // subscribeRun 会挂一个 30 秒一次的看门狗,用完清掉
    try {
      useApp.getState().subscribeRun('s1', 'r2', 'a2')
      expect(shown()).toBeUndefined()
    } finally { vi.clearAllTimers(); vi.useRealTimers() }
  })

  it('关掉开关:已有的建议一并清空', async () => {
    setPromptSuggest(true)
    fetchMock.mockResolvedValueOnce(json({ suggestion: '跑吧' }))
    await requestSuggestion('s1', 'r1')
    setPromptSuggest(false)
    expect(shown()).toBeUndefined()
    expect(localStorage.getItem(PROMPT_SUGGEST_KEY)).toBe('0')
  })
})
