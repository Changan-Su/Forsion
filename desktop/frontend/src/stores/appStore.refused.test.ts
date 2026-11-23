// 被模型的安全审核拦下的回答(借鉴 DeepSeek chat-demo ④):done 带 refused → 流出的正文被终稿换掉、思考清掉、标 refused;
// 重载时 origin = refused 的行同样还原出 refused(云端落库不带 origin 时就没有,固定文案照普通正文显示)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useApp } from './appStore'
import '../tangu/store/standalone'
import { recordToUi } from '../tangu/store/tanguSlice'

const NOTICE = '这条回答被模型的安全审核拦下了。'
const initial = useApp.getState()
const event = (type: string, payload: any = {}) => useApp.getState().reduceEvent('s', 'r', { current: 'a' }, { seq: 1, type, payload })
beforeEach(() => {
  vi.useFakeTimers()
  useApp.setState(initial, true)
  vi.stubGlobal('window', {})
  useApp.setState({ activeId: 's', tr: (key) => key, toast: vi.fn(),
    messagesBySession: { s: [{ id: 'a', role: 'assistant', content: '不该留下的半截', reasoning: 'thinking', timestamp: 1, status: 'streaming' }] },
    runningBySession: { s: 'r' }, stoppingBySession: {},
  })
})
afterEach(() => { useApp.setState(initial, true); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('safety-check refusal', () => {
  it('done with refused replaces the streamed text and drops reasoning', () => {
    event('done', { content: NOTICE, toolOffsets: [], refused: true })
    const m = useApp.getState().messagesBySession.s[0]
    expect(m).toMatchObject({ status: 'done', content: NOTICE, refused: true })
    expect(m.reasoning).toBeUndefined()
  })
  it('a normal done carries no refused flag', () => {
    event('done', { content: 'ok', toolOffsets: [] })
    expect(useApp.getState().messagesBySession.s[0].refused).toBeUndefined()
  })
  it('history rows with origin refused restore the flag', () => {
    expect(recordToUi({ id: 'x', role: 'model', content: NOTICE, timestamp: 1, origin: 'refused' }).refused).toBe(true)
    expect(recordToUi({ id: 'y', role: 'model', content: 'hi', timestamp: 1 }).refused).toBeUndefined()
  })
})
