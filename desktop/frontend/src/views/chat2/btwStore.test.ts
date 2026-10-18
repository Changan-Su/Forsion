import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useApp } from '../../stores/appStore'
import { useChildChat } from '../../stores/childChatStore'
import { btwSeedOf, consumeSeed, openBtw, useBtw } from './btwStore'

const sse = (...events: object[]): Response => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
const initialApp = useApp.getState()
const initialBtw = useBtw.getState()
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  useApp.setState({ cfg: { ...initialApp.cfg, backendUrl: 'http://engine', token: 'tok' }, activeId: 's1' })
  useBtw.setState({ threads: {}, webOpen: null, anchors: {}, saved: {} })
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { useApp.setState(initialApp, true); useBtw.setState(initialBtw, true); vi.unstubAllGlobals() })

describe('旁聊 store', () => {
  it('流式拼回答;第二问把第一轮往返带上,出错 / 未完成的轮不带', async () => {
    fetchMock.mockResolvedValueOnce(sse({ type: 'delta', text: 'AZURE' }, { type: 'delta', text: '-FALCON' }, { type: 'done', content: 'AZURE-FALCON' }))
    await useBtw.getState().ask('s1', 'codename?', 'excerpt', 'm1')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://engine/agent/sessions/s1/aside')
    expect(JSON.parse(init.body)).toMatchObject({ question: 'codename?', quote: 'excerpt', thread: [], model_id: 'm1', app_id: 'tangu' })
    expect(useBtw.getState().threads.s1).toEqual([expect.objectContaining({ question: 'codename?', answer: 'AZURE-FALCON', status: 'done' })])

    fetchMock.mockResolvedValueOnce(sse({ type: 'error', error: 'upstream 500' }))
    await useBtw.getState().ask('s1', 'second', undefined, 'm1')
    expect(useBtw.getState().threads.s1[1]).toMatchObject({ status: 'error', error: 'upstream 500' })

    fetchMock.mockResolvedValueOnce(sse({ type: 'done', content: 'ok' }))
    await useBtw.getState().ask('s1', 'third')
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).thread).toEqual([{ question: 'codename?', quote: 'excerpt', answer: 'AZURE-FALCON' }])
    expect(useBtw.getState().threads.s2).toBeUndefined() // 线程按会话分开
  })

  it('老引擎没有这条路由(非 JSON 404)→ 提示更新;流断在半路 → 标成不完整', async () => {
    fetchMock.mockResolvedValueOnce(new Response('Cannot POST /agent/sessions/s1/aside', { status: 404 }))
    await useBtw.getState().ask('s1', 'q1')
    expect(useBtw.getState().threads.s1[0]).toMatchObject({ status: 'error', error: '当前引擎还不支持旁聊，请更新 Forsion' })
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'Session not found' }), { status: 404 }))
    await useBtw.getState().ask('s1', 'q2')
    expect(useBtw.getState().threads.s1[1]).toMatchObject({ status: 'error', error: 'Session not found' })
    fetchMock.mockResolvedValueOnce(sse({ type: 'delta', text: 'half' }))
    await useBtw.getState().ask('s1', 'q3')
    expect(useBtw.getState().threads.s1[2]).toMatchObject({ status: 'error', answer: 'half', error: '连接中断，回答不完整' })
  })

  it('停止 = stopped(不是报错);流着的时候不接第二问', async () => {
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
    const pending = useBtw.getState().ask('s1', 'long one')
    await useBtw.getState().ask('s1', 'impatient')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    useBtw.getState().stop('s1')
    await pending
    expect(useBtw.getState().threads.s1).toEqual([expect.objectContaining({ question: 'long one', status: 'stopped' })])
  })

  it('指令:缺会话或 nonce 不认;同一 nonce 只消费一次', () => {
    expect(btwSeedOf({ sessionId: 's1' })).toBeNull()
    expect(btwSeedOf({ nonce: 'n' })).toBeNull()
    const seed = btwSeedOf({ sessionId: 's1', nonce: 'n1', quote: 'q', scope: 5 })!
    expect(seed).toMatchObject({ sessionId: 's1', nonce: 'n1', quote: 'q', scope: undefined })
    expect(consumeSeed(seed)).toBe(true)
    expect(consumeSeed(seed)).toBe(false)
  })

  it('主窗(桌面 / Web)开在对话右边的子会话面板;手机挂 webOpen;卫星窗开 btw:<会话> 浮窗', () => {
    vi.stubGlobal('window', {})
    openBtw({ sessionId: 'child', title: null, quote: 'sel', messageId: 'm1' })
    expect(useChildChat.getState().selected.s1?.aside).toMatchObject({ sessionId: 'child', scope: 's1', quote: 'sel', messageId: 'm1' })
    expect(useBtw.getState().webOpen).toBeNull()

    vi.stubGlobal('window', { tangu: { mobile: true } })
    openBtw({ sessionId: 'child', title: null, quote: 'sel' })
    expect(useBtw.getState().webOpen).toMatchObject({ sessionId: 'child', scope: 's1', quote: 'sel' })

    const openFloatingPanel = vi.fn(async () => ({ id: 'x' }))
    vi.stubGlobal('window', { tangu: { openFloatingPanel } })
    vi.stubGlobal('location', { search: '?window=detached&id=d1' })
    openBtw({ sessionId: 's1', title: 'Parser work', question: 'why?' })
    expect(openFloatingPanel).toHaveBeenCalledWith(expect.objectContaining({
      id: 'btw:s1', builtin: 'btw', title: '顺便问 · Parser work',
      params: expect.objectContaining({ sessionId: 's1', question: 'why?', nonce: expect.any(String) }),
    }))
  })

  it('问的时候带上挂点和记录 id;第一问答完记下引擎回的 asideId 并刷新存下来的列表', async () => {
    useBtw.setState({ anchors: { s1: { messageId: 'm7' } } })
    fetchMock.mockResolvedValueOnce(sse({ type: 'done', content: 'ok', asideId: 'a9', asideMessageId: 'm7' }))
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ asides: [{ id: 'a9', message_id: 'm7', turns: [{ question: 'q', answer: 'ok' }], created_at: '', updated_at: '' }] })))
    await useBtw.getState().ask('s1', 'q')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ message_id: 'm7' })
    expect(useBtw.getState().anchors.s1).toEqual({ messageId: 'm7', asideId: 'a9' })
    await vi.waitFor(() => expect(useBtw.getState().saved.s1?.[0]?.id).toBe('a9'))
    expect(String(fetchMock.mock.calls[1][0])).toBe('http://engine/agent/sessions/s1/asides')
  })

  it('换了挂点另起一段;重开存下来的那段载回往返', () => {
    useBtw.setState({ threads: { s1: [{ id: 't', question: 'old', answer: 'a', status: 'done' }] }, anchors: { s1: { messageId: 'm1', asideId: 'x1' } },
      saved: { s1: [{ id: 'x2', message_id: 'm2', turns: [{ question: 'q1', answer: 'a1' }, { question: 'q2', answer: 'a2' }], created_at: '', updated_at: '' }] } })
    useBtw.getState().applySeed({ sessionId: 's1', nonce: 'n1', messageId: 'm1' })
    expect(useBtw.getState().threads.s1).toHaveLength(1) // 同一个挂点:接着这段
    useBtw.getState().applySeed({ sessionId: 's1', nonce: 'n2', messageId: 'm3' })
    expect(useBtw.getState().threads.s1).toEqual([])
    expect(useBtw.getState().anchors.s1).toEqual({ messageId: 'm3' })
    useBtw.getState().applySeed({ sessionId: 's1', nonce: 'n3', asideId: 'x2' })
    expect(useBtw.getState().threads.s1.map((t) => t.question)).toEqual(['q1', 'q2'])
    expect(useBtw.getState().anchors.s1).toEqual({ asideId: 'x2', messageId: 'm2' })
  })
})
