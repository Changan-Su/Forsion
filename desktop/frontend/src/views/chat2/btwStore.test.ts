import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useApp } from '../../stores/appStore'
import { useChildChat } from '../../stores/childChatStore'
import type { SavedAside } from '../../services/backendService'
import { BTW_MAX_ATTACHMENTS, BTW_MAX_ATTACH_CHARS, asidesOnMessage, btwSeedOf, consumeSeed, mergeBtwAttachments, openBtw, readBtwFiles, useBtw, type BtwAttachment } from './btwStore'

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

  it('流着的时候点了别的一段 → 流完再切过去(Codex 10-18 #3)', async () => {
    let finish!: (r: Response) => void
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => { finish = r }))
    useBtw.setState({ saved: { s1: [{ id: 'x2', message_id: 'm2', turns: [{ question: 'q1', answer: 'a1' }], created_at: '', updated_at: '' }] } })
    const asking = useBtw.getState().ask('s1', 'q')
    useBtw.getState().applySeed({ sessionId: 's1', nonce: 'n1', asideId: 'x2' })
    expect(useBtw.getState().anchors.s1).toBeUndefined()
    finish(sse({ type: 'done', content: 'ok' }))
    await asking
    expect(useBtw.getState().anchors.s1).toEqual({ asideId: 'x2', messageId: 'm2' })
    expect(useBtw.getState().threads.s1.map((t) => t.question)).toEqual(['q1'])
  })

  it('新开的浮窗里还没取过存下来的 → 先取再载回(Codex 10-18 #4)', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ asides: [{ id: 'x2', message_id: 'm2', turns: [{ question: 'q1', answer: 'a1' }], created_at: '', updated_at: '' }] })))
    useBtw.getState().applySeed({ sessionId: 's1', nonce: 'n1', asideId: 'x2' })
    await vi.waitFor(() => expect(useBtw.getState().anchors.s1).toEqual({ asideId: 'x2', messageId: 'm2' }))
    expect(useBtw.getState().threads.s1.map((t) => t.question)).toEqual(['q1'])
  })
})

describe('旁聊附件(10-24 方案 A)', () => {
  const IMG: BtwAttachment = { name: 'shot.png', mimeType: 'image/png', data: 'iVBORw0K', size: 6, thumb: 'data:image/jpeg;base64,AAAA' }
  const TXT: BtwAttachment = { name: 'notes.md', mimeType: 'text/markdown', data: 'IyBOb3Rlcw==', size: 7 }

  it('附件随这一问整份发出(含缩略图);线程里只留记录;追问只带名字 / 类型 / 大小,内容和缩略图都不再发', async () => {
    useApp.setState({ cfg: { ...useApp.getState().cfg, visionModelId: 'vis-1', visionMode: 'auto' } })
    fetchMock.mockResolvedValueOnce(sse({ type: 'done', content: 'A dot.', attached: { images: 1, files: ['notes.md'], transcribed: false } }))
    await useBtw.getState().ask('s1', 'what is this?', undefined, 'm1', { attachments: [IMG, TXT], thinkingLevel: 'medium' })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.attachments).toEqual([
      { name: 'shot.png', mimeType: 'image/png', data: 'iVBORw0K', size: 6, thumb: 'data:image/jpeg;base64,AAAA' },
      { name: 'notes.md', mimeType: 'text/markdown', data: 'IyBOb3Rlcw==', size: 7 },
    ])
    expect(body).toMatchObject({ thinking_level: 'medium', vision_model_id: 'vis-1', vision_mode: 'auto' })
    const turn = useBtw.getState().threads.s1[0]
    expect(turn.attachments).toEqual([{ name: 'shot.png', mimeType: 'image/png', size: 6, thumb: 'data:image/jpeg;base64,AAAA' }, { name: 'notes.md', mimeType: 'text/markdown', size: 7 }])
    expect(JSON.stringify(useBtw.getState().threads)).not.toContain('iVBORw0K') // 内容不留在线程里
    expect(turn.attachNote).toBeUndefined()

    fetchMock.mockResolvedValueOnce(sse({ type: 'done', content: 'Red.' }))
    await useBtw.getState().ask('s1', 'colour?', undefined, 'm1')
    const second = JSON.parse(fetchMock.mock.calls[1][1].body)
    expect(second.attachments).toBeUndefined()
    expect(second.thinking_level).toBeUndefined()
    expect(second.vision_mode).toBeUndefined() // 没附图就不带图像识别档
    expect(second.thread).toEqual([{ question: 'what is this?', answer: 'A dot.', attachments: [{ name: 'shot.png', mimeType: 'image/png', size: 6 }, { name: 'notes.md', mimeType: 'text/markdown', size: 7 }] }])
  })

  it('老引擎没认附件(done 不报 attached)→ 标「没收到」;转写过 → 标「先转成了文字」;转写中显示状态', async () => {
    fetchMock.mockResolvedValueOnce(sse({ type: 'done', content: 'ok' }))
    await useBtw.getState().ask('s1', 'q1', undefined, undefined, { attachments: [IMG] })
    expect(useBtw.getState().threads.s1[0].attachNote).toBe('ignored')
    let finish!: (r: Response) => void
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => { finish = r }))
    const asking = useBtw.getState().ask('s1', 'q2', undefined, undefined, { attachments: [IMG] })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    finish(sse({ type: 'status', phase: 'describing_images', stage: 'start', count: 1 }, { type: 'done', content: 'ok', attached: { images: 1, files: [], transcribed: true } }))
    await asking
    expect(useBtw.getState().threads.s1[1]).toMatchObject({ attachNote: 'transcribed', describing: false, status: 'done' })
  })

  it('附件合计过大:引擎 400 带 code → 人话;网关 413 同一句', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'Attachments too large', code: 'aside_attachments_too_large' }), { status: 400 }))
    await useBtw.getState().ask('s1', 'q', undefined, undefined, { attachments: [IMG] })
    expect(useBtw.getState().threads.s1[0].error).toContain('附件太大')
    fetchMock.mockResolvedValueOnce(new Response('Payload Too Large', { status: 413 }))
    await useBtw.getState().ask('s1', 'q', undefined, undefined, { attachments: [IMG] })
    expect(useBtw.getState().threads.s1[1].error).toContain('附件太大')
  })

  it('没答成(出错 / 停了)→ 附件放回草稿(问题也放回空草稿);用户已经挂了新附件就不覆盖(Codex 10-24 #1)', async () => {
    fetchMock.mockResolvedValueOnce(sse({ type: 'error', error: 'upstream 500' }))
    await useBtw.getState().ask('s1', 'what is this?', undefined, undefined, { attachments: [IMG, TXT] })
    expect(useBtw.getState().compose.s1).toMatchObject({ draft: 'what is this?', attachments: [IMG, TXT] })
    // 放回的是同一批对象(磁贴按对象认 key)
    expect(useBtw.getState().compose.s1.attachments![0]).toBe(IMG)
    const fresh = { ...TXT, name: 'next.md' }
    useBtw.setState({ compose: { s1: { draft: 'next', attachments: [fresh] } } })
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }))
    await useBtw.getState().ask('s1', 'again', undefined, undefined, { attachments: [IMG] })
    expect(useBtw.getState().compose.s1).toEqual({ draft: 'next', attachments: [fresh] })
    fetchMock.mockResolvedValueOnce(sse({ type: 'done', content: 'ok', attached: { images: 1, files: [], transcribed: false } }))
    useBtw.setState({ compose: {} })
    await useBtw.getState().ask('s1', 'fine', undefined, undefined, { attachments: [IMG] })
    expect(useBtw.getState().compose.s1).toBeUndefined() // 答成了不放回
  })

  it('并进草稿前按最新的草稿再查上限:两批同时读完也不超 8 个(Codex 10-24 #3)', () => {
    const seven = Array.from({ length: 7 }, (_, i) => ({ ...IMG, name: `p${i}.png` }))
    const { merged, skipped } = mergeBtwAttachments(seven, [{ ...IMG, name: 'a.png' }, { ...IMG, name: 'b.png' }])
    expect(merged.map((a) => a.name)).toEqual([...seven.map((a) => a.name), 'a.png'])
    expect(skipped).toEqual(['b.png（一问最多 8 个）'])
    const big = { ...TXT, name: 'big.txt', data: 'A'.repeat(BTW_MAX_ATTACH_CHARS - 10) }
    expect(mergeBtwAttachments([big], [{ ...TXT, name: 'more.txt', data: 'A'.repeat(20) }]).skipped).toEqual(['more.txt（附件合计超 13MB）'])
  })

  it('重开存下来的那段:附件记录(含缩略图)一起载回;「新的一段」清空线程、留挂点、不删记录', () => {
    useBtw.setState({ saved: { s1: [{ id: 'x2', message_id: 'm2', turns: [{ question: 'q1', answer: 'a1', attachments: [{ name: 'a.png', mimeType: 'image/png', thumb: 'data:image/jpeg;base64,AAAA' }] }], created_at: '', updated_at: '' }] } })
    useBtw.getState().applySeed({ sessionId: 's1', nonce: 'n1', asideId: 'x2' })
    expect(useBtw.getState().threads.s1[0].attachments).toEqual([{ name: 'a.png', mimeType: 'image/png', thumb: 'data:image/jpeg;base64,AAAA' }])
    useBtw.getState().startNew('s1')
    expect(useBtw.getState().threads.s1).toEqual([])
    expect(useBtw.getState().anchors.s1).toEqual({ messageId: 'm2' })
    expect(useBtw.getState().saved.s1).toHaveLength(1)
    expect(fetchMock).not.toHaveBeenCalled() // 不是 clear:不去引擎删
  })

  it('面板头的列表:按挂点筛存下来的那几段(与「从这里分出」同源);没挂点 / 没有就空', () => {
    const rows = [{ id: 'a', message_id: 'm1' }, { id: 'b', message_id: 'm2' }, { id: 'c', message_id: 'm1' }] as SavedAside[]
    expect(asidesOnMessage(rows, 'm1').map((a) => a.id)).toEqual(['a', 'c'])
    expect(asidesOnMessage(rows, undefined)).toEqual([])
    expect(asidesOnMessage(undefined, 'm1')).toEqual([])
  })

  it('读文件:图片 / 文本 / PDF 收,压缩包之类跳过;超大、超个数跳过并说明', async () => {
    const f = (name: string, type: string, body = 'x') => new File([body], name, { type })
    const { added, skipped } = await readBtwFiles([
      f('a.png', 'image/png', 'PNGDATA'), f('main.ts', 'video/mp2t', 'const a = 1'), f('doc.pdf', 'application/pdf'), f('pack.zip', 'application/zip'),
    ], [])
    expect(added.map((a) => [a.name, a.mimeType])).toEqual([['a.png', 'image/png'], ['main.ts', 'video/mp2t'], ['doc.pdf', 'application/pdf']])
    expect(added[0].data).toBe(btoa('PNGDATA'))
    expect(skipped).toEqual(['pack.zip（不支持的类型）'])
    const big = new File([new Uint8Array(6 * 1024 * 1024)], 'big.png', { type: 'image/png' })
    const many = Array.from({ length: BTW_MAX_ATTACHMENTS }, (_, i) => ({ ...IMG, name: `p${i}.png` }))
    const r2 = await readBtwFiles([big, f('one-more.txt', 'text/plain')], many)
    expect(r2.added).toEqual([])
    expect(r2.skipped).toEqual(['big.png（超 5MB）', 'one-more.txt（一问最多 8 个）'])
  })
})
