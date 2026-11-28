/**
 * 演示舞台的脚本回放引擎(stageEngine.ts):剧本校验是纯函数直测;服务一律走真 HTTP(真端口、真 SSE),
 * 断言渲染层会看到的东西 —— 事件按序带 seq、末尾补 done、挂住等回答、答完续播,以及刷新后对话还在。
 */
import { get } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { parseStageCalendar, parseStageScript, pickStageRun, startStageEngine, STAGE_CALENDAR_MAX_BYTES, STAGE_SCRIPT_MAX_BYTES, type StageRun, type StageScript } from './stageEngine'

type Frame = { seq: number; type: string; payload: Record<string, any> }

function script(raw: unknown): StageScript {
  const r = parseStageScript(raw)
  if ('error' in r) throw new Error(r.error)
  return r.script
}
const errorOf = (raw: unknown): string => {
  const r = parseStageScript(raw)
  return 'error' in r ? r.error : ''
}

/** 订一条 run 的事件流:frames 随到随记;waitFor 等到某条帧(已到的也算);ended = 服务端关了这条流。 */
function stream(url: string) {
  const frames: Frame[] = []
  const waiters: Array<{ pred: (f: Frame) => boolean; resolve: (f: Frame) => void }> = []
  let buf = ''
  let req: ReturnType<typeof get> | null = null
  const ended = new Promise<void>((resolve, reject) => {
    req = get(url, (res) => {
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        buf += chunk
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          const f = JSON.parse(line.slice(5).trim()) as Frame
          frames.push(f)
          for (const w of [...waiters]) if (w.pred(f)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(f) }
        }
      })
      res.on('end', () => resolve())
      res.on('error', reject)
    })
    req.on('error', reject)
  })
  return {
    frames,
    ended,
    waitFor(pred: (f: Frame) => boolean, ms = 3000): Promise<Frame> {
      const hit = frames.find(pred)
      if (hit) return Promise.resolve(hit)
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timed out; got ${JSON.stringify(frames.map((f) => f.type))}`)), ms)
        waiters.push({ pred, resolve: (f) => { clearTimeout(t); resolve(f) } })
      })
    },
    close: () => req?.destroy(),
  }
}

let engines: Array<{ close(): Promise<void> }> = []
afterEach(async () => {
  await Promise.all(engines.map((e) => e.close()))
  engines = []
})

async function start(raw: unknown) {
  const e = await startStageEngine(script(raw))
  engines.push(e)
  const call = async (path: string, init?: { method?: string; body?: unknown }) => {
    const r = await fetch(`${e.url}${path}`, {
      method: init?.method || 'GET',
      headers: { Authorization: 'Bearer sandbox', 'Content-Type': 'application/json' },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    })
    return { status: r.status, body: await r.json() as any }
  }
  const run = async (sessionId: string, message: string) => (await call('/agent/runs', { method: 'POST', body: { session_id: sessionId, message, model_id: 'demo' } })).body as { runId: string; assistantMessageId: string; userMessageId: string }
  const events = (runId: string, fromSeq = 0) => stream(`${e.url}/agent/runs/${runId}/events?fromSeq=${fromSeq}`)
  return { ...e, call, run, events }
}

const SESSION = { id: 's1', title: 'Launch notes', model_id: 'demo', project_path: '/tmp/demo', project_name: 'demo' }

describe('parseStageScript', () => {
  it('fills defaults for an empty script and ignores unknown keys', () => {
    const s = script({ whatever: 1 })
    expect(s.models).toEqual([{ id: 'demo', name: 'Demo model', provider: 'demo', contextWindow: 128_000 }])
    expect(s.runs).toEqual([])
    expect(s.sessions).toEqual([])
    expect((s as unknown as Record<string, unknown>).whatever).toBeUndefined()
  })

  it('accepts JSON text and bytes (with a BOM) as well as parsed values', () => {
    const raw = { runs: [{ events: [{ type: 'token', payload: { delta: 'hi' } }] }] }
    expect(script(JSON.stringify(raw)).runs[0].events[0]).toEqual({ type: 'token', payload: { delta: 'hi' }, delay: 0 })
    expect(script(Buffer.from('﻿' + JSON.stringify(raw), 'utf8')).runs).toHaveLength(1)
    expect(errorOf('{nope')).toMatch(/not valid JSON/)
    expect(errorOf([1, 2])).toBe('the script must be a JSON object')
    expect(errorOf(undefined)).toBe('the script must be a JSON object')
  })

  it('caps the size at 2 MB for text and for parsed values', () => {
    const big = { agents: ['x'.repeat(STAGE_SCRIPT_MAX_BYTES)] }
    expect(errorOf(big)).toMatch(/limit is 2097152 bytes/)
    expect(errorOf(JSON.stringify(big))).toMatch(/limit is 2097152 bytes/)
  })

  it('reports wrong types with the path that is wrong', () => {
    expect(errorOf({ models: [] })).toBe('models must list at least one model')
    expect(errorOf({ models: [{ name: 'x' }] })).toBe('models[0].id must be a non-empty string of at most 200 characters')
    expect(errorOf({ models: [{ id: 'a', contextWindow: -1 }] })).toBe('models[0].contextWindow must be a positive number')
    expect(errorOf({ sessions: [{ id: 'a' }, { id: 'a' }] })).toBe('sessions[1].id "a" is used twice')
    expect(errorOf({ sessions: [{ id: 'a', archived: 'yes' }] })).toBe('sessions[0].archived must be boolean')
    expect(errorOf({ sessions: [{ id: 'a' }], messages: [{ id: 'm', role: 'robot' }] })).toBe('messages[0].role must be "user", "assistant" or "model"')
    expect(errorOf({ sessions: [{ id: 'a' }], messages: [{ id: 'm', role: 'user', session_id: 'b' }] })).toBe('messages[0].session_id "b" is not one of the script\'s sessions')
    expect(errorOf({ messages: [{ id: 'm', role: 'user' }] })).toMatch(/has no session_id and the script has no sessions/)
    expect(errorOf({ runs: {} })).toBe('runs must be an array')
    expect(errorOf({ runs: [{ events: [{ type: 'token' }, { type: 'token', delay: '5' }] }] })).toBe('runs[0].events[1].delay must be a number of milliseconds')
    expect(errorOf({ runs: [{ events: [{ type: '' }] }] })).toMatch(/runs\[0\]\.events\[0\]\.type/)
    expect(errorOf({ runs: [{ events: [{ type: 'token', payload: [] }] }] })).toBe('runs[0].events[0].payload must be an object')
    expect(errorOf({ runs: [{ match: '', events: [] }] })).toMatch(/runs\[0\]\.match/)
    expect(errorOf({ sessionConfigs: { s1: 3 } })).toBe('sessionConfigs.s1 must be an object')
    expect(errorOf({ agents: {} })).toBe('agents must be an array')
  })

  it('clamps delays and caps runs, events and total delay', () => {
    const s = script({ runs: [{ events: [{ type: 'a', delay: -5 }, { type: 'b', delay: 25_000 }, { type: '__hold', delay: 900 }] }] })
    expect(s.runs[0].events.map((e) => e.delay)).toEqual([0, 10_000, 0])
    expect(errorOf({ runs: [{ events: Array.from({ length: 13 }, () => ({ type: 't', delay: 10_000 })) }] })).toBe('runs[0] adds up to 130000 ms of delay; the limit is 120000 ms')
    expect(errorOf({ runs: Array.from({ length: 201 }, () => ({ events: [] })) })).toBe('runs has 201 entries; the limit is 200')
    expect(errorOf({ runs: [{ events: Array.from({ length: 2001 }, () => ({ type: 't' })) }] })).toBe('runs[0].events has 2001 entries; the limit is 2000')
    expect(script({ runs: Array.from({ length: 200 }, () => ({ events: [] })) }).runs).toHaveLength(200)
  })
})

describe('pickStageRun', () => {
  const runs: StageRun[] = [{ events: [] }, { match: 'deploy', events: [] }, { match: 'hello', events: [] }, { events: [] }]
  it('prefers the first unused matching run, then the first unused run without match', () => {
    expect(pickStageRun(runs, new Set(), 'hello world')).toBe(2)
    expect(pickStageRun(runs, new Set(), 'deploy, then hello')).toBe(1)
    expect(pickStageRun(runs, new Set(), 'nothing special')).toBe(0)
    expect(pickStageRun(runs, new Set([0]), 'nothing special')).toBe(3)
    expect(pickStageRun(runs, new Set([0, 3]), 'nothing special')).toBe(-1)
    expect(pickStageRun(runs, new Set([2]), 'hello')).toBe(0)
    expect(pickStageRun(runs, new Set(), 'Hello')).toBe(0) // 区分大小写
  })
})

describe('startStageEngine', () => {
  it('serves models and sessions, creates sessions and filters archived ones', async () => {
    const e = await start({
      models: [{ id: 'demo', name: 'GPT 6.2 Sol', provider: 'openai', contextWindow: 400_000 }],
      sessions: [SESSION, { id: 's2', title: 'Old', archived: true }],
      agents: [{ slug: 'xyra', name: 'Xyra' }],
    })
    expect(e.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const models = await e.call('/agent/models')
    expect(models.body).toMatchObject({ models: [{ id: 'demo', name: 'GPT 6.2 Sol' }], defaultModelId: 'demo', directProviders: [] })
    expect((await e.call('/agent/agents')).body).toEqual({ agents: [{ slug: 'xyra', name: 'Xyra' }] })
    const list = await e.call('/agent/sessions?archived=false&app_id=tangu')
    expect(list.body.sessions.map((s: any) => s.id)).toEqual(['s1'])
    expect(list.body.sessions[0]).toMatchObject({ title: 'Launch notes', archived: false, busy: false, agent_config: null })
    expect((await e.call('/agent/sessions?archived=true')).body.sessions.map((s: any) => s.id)).toEqual(['s2'])

    const created = await e.call('/agent/sessions', { method: 'POST', body: { app_id: 'tangu', project_path: '/tmp/demo', agent_config: { execMode: 'host' } } })
    expect(created.body.session).toMatchObject({ title: 'New Chat', model_id: 'demo', project_path: '/tmp/demo', archived: false })
    const sid = created.body.session.id
    expect((await e.call('/agent/sessions?archived=false')).body.sessions[0].id).toBe(sid)
    expect((await e.call(`/agent/sessions/${sid}/config`)).body).toEqual({ agent_config: { execMode: 'host' } })
    expect((await e.call(`/agent/sessions/${sid}/messages`)).body).toEqual({ messages: [], failed_runs: [] })
  })

  it('replays a run in order with seq numbers and a trailing done, and keeps the transcript', async () => {
    const e = await start({
      sessions: [SESSION],
      runs: [{ events: [
        { type: 'reasoning', payload: { delta: 'Thinking.' } },
        { type: 'token', payload: { delta: 'Let me look. ' } },
        { type: 'tool_call', payload: { id: 'c1', name: 'read_file', arguments: { path: 'README.md' } } },
        { type: 'tool_result', payload: { id: 'c1', name: 'read_file', result: '# Demo', elapsedMs: 12 } },
        { type: 'token', payload: { delta: 'It is a demo.' } },
      ] }],
    })
    const r = await e.run('s1', 'What is in the readme?')
    const s = e.events(r.runId)
    await s.ended
    expect(s.frames.map((f) => [f.seq, f.type])).toEqual([[1, 'reasoning'], [2, 'token'], [3, 'tool_call'], [4, 'tool_result'], [5, 'token'], [6, 'done']])
    // 剧本里写成对象的工具参数,流上也是 JSON 字符串(同真引擎;HTML 卡要 JSON.parse 它)
    expect(s.frames[2].payload).toEqual({ id: 'c1', name: 'read_file', arguments: '{"path":"README.md"}' })

    const msgs = (await e.call('/agent/sessions/s1/messages?limit=200')).body.messages
    expect(msgs.map((m: any) => [m.id, m.role])).toEqual([[r.userMessageId, 'user'], [r.assistantMessageId, 'model']])
    expect(msgs[0]).toMatchObject({ content: 'What is in the readme?', model_id: 'demo' })
    expect(msgs[1]).toMatchObject({
      content: 'Let me look. It is a demo.', reasoning: 'Thinking.', is_error: false, model_id: 'demo',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' }, ui_content_offset: 13 }],
      tool_results: [{ tool_call_id: 'c1', name: 'read_file', content: '# Demo', isError: false, elapsedMs: 12 }],
    })
    expect(msgs[1].timestamp).toBeGreaterThan(msgs[0].timestamp)
    expect((await e.call('/agent/runs?session_id=s1')).body.runs).toEqual([expect.objectContaining({ id: r.runId, status: 'done', assistant_message_id: r.assistantMessageId })])
    // 续订:只补 seq 之后的
    const again = e.events(r.runId, 4)
    await again.ended
    expect(again.frames.map((f) => f.seq)).toEqual([5, 6])
  })

  it('paces events by their delay', async () => {
    const e = await start({ sessions: [SESSION], runs: [{ events: [{ type: 'token', delay: 150, payload: { delta: 'a' } }, { type: 'token', delay: 150, payload: { delta: 'b' } }] }] })
    const t0 = Date.now()
    const r = await e.run('s1', 'go')
    const s = e.events(r.runId)
    await s.waitFor((f) => f.type === 'token')
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140)
    expect(s.frames.some((f) => f.type === 'done')).toBe(false)
    await s.ended
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290)
    expect(s.frames.map((f) => f.type)).toEqual(['token', 'token', 'done'])
  })

  it('picks runs by match, falls back to unmatched ones, and replies with done when none are left', async () => {
    const e = await start({ sessions: [SESSION], runs: [{ match: 'chart', events: [{ type: 'token', payload: { delta: 'chart!' } }] }, { events: [{ type: 'token', payload: { delta: 'plain' } }] }] })
    const texts: string[] = []
    for (const prompt of ['say hi', 'draw a chart', 'again']) {
      const s = e.events((await e.run('s1', prompt)).runId)
      await s.ended
      texts.push(s.frames.map((f) => f.type === 'token' ? f.payload.delta : f.type).join('|'))
    }
    expect(texts).toEqual(['plain|done', 'chart!|done', 'done'])
    const unknown = e.events('nope')
    await unknown.ended
    expect(unknown.frames).toEqual([{ seq: 1, type: 'done', payload: {} }])
  })

  it('holds on an inquiry and plays the rest after the answer', async () => {
    const e = await start({ sessions: [SESSION], runs: [{ events: [
      { type: 'token', payload: { delta: 'Pick one. ' } },
      { type: 'inquiry_request', payload: { question: 'Which?', options: ['A', 'B'] } },
      { type: '__hold' },
      { type: 'token', delay: 20, payload: { delta: 'You picked it.' } },
    ] }] })
    const r = await e.run('s1', 'ask me')
    const s = e.events(r.runId)
    const inq = await s.waitFor((f) => f.type === 'inquiry_request')
    expect(inq.payload.inquiryId).toMatch(/^inq-/)
    await new Promise((res) => setTimeout(res, 50))
    expect(s.frames.map((f) => f.type)).toEqual(['token', 'inquiry_request']) // 挂住:没有 done,连接还开着
    expect((await e.call('/agent/runs?session_id=s1')).body.runs[0].status).toBe('running')
    expect((await e.call('/agent/sessions')).body.sessions[0].busy).toBe(true)
    // 界面动作回执不算回答
    await e.call(`/agent/runs/${r.runId}/inquiries/ui_ack1`, { method: 'POST', body: { ok: true } })
    await new Promise((res) => setTimeout(res, 30))
    expect(s.frames).toHaveLength(2)
    await e.call(`/agent/runs/${r.runId}/inquiries/${inq.payload.inquiryId}`, { method: 'POST', body: { answer: 'A' } })
    await s.ended
    expect(s.frames.map((f) => [f.seq, f.type])).toEqual([[1, 'token'], [2, 'inquiry_request'], [3, 'inquiry_result'], [4, 'token'], [5, 'done']])
    expect(s.frames[2].payload).toEqual({ inquiryId: inq.payload.inquiryId, answer: 'A' })
    const msgs = (await e.call('/agent/sessions/s1/messages')).body.messages
    expect(msgs[1]).toMatchObject({ id: r.assistantMessageId, content: 'Pick one. You picked it.' })
  })

  it('a trailing __hold ends with inquiry_result + done after the answer (same as the test stub)', async () => {
    const e = await start({ sessions: [SESSION], runs: [{ events: [{ type: 'inquiry_request', payload: { inquiryId: 'q1', question: '?' } }, { type: '__hold' }] }] })
    const r = await e.run('s1', 'x')
    const s = e.events(r.runId)
    await s.waitFor((f) => f.type === 'inquiry_request')
    await e.call(`/agent/runs/${r.runId}/inquiries/q1`, { method: 'POST', body: { answer: 'yes' } })
    await s.ended
    expect(s.frames.map((f) => f.type)).toEqual(['inquiry_request', 'inquiry_result', 'done'])
  })

  it('holds on an approval and continues with approval_result after it is answered', async () => {
    const e = await start({ sessions: [SESSION], runs: [{ events: [
      { type: 'tool_call', payload: { id: 'c1', name: 'run_bash', arguments: '{"command":"npm publish"}' } },
      { type: 'approval_request', payload: { approvalId: 'a1', name: 'run_bash', arguments: '{"command":"npm publish"}', preview: 'npm publish', toolCallId: 'c1' } },
      { type: '__hold' },
      { type: 'tool_result', payload: { id: 'c1', name: 'run_bash', result: 'published 1.0.0' } },
      { type: 'token', payload: { delta: 'Published.' } },
    ] }] })
    const r = await e.run('s1', 'publish it')
    const s = e.events(r.runId)
    await s.waitFor((f) => f.type === 'approval_request')
    expect((await e.call(`/agent/runs/${r.runId}/approvals/a1`, { method: 'POST', body: { action: 'approve' } })).body).toEqual({ ok: true })
    await s.ended
    expect(s.frames.map((f) => f.type)).toEqual(['tool_call', 'approval_request', 'approval_result', 'tool_result', 'token', 'done'])
    expect(s.frames[2].payload).toEqual({ approvalId: 'a1', action: 'approve' })
    const model = (await e.call('/agent/sessions/s1/messages')).body.messages[1]
    expect(model).toMatchObject({ content: 'Published.', tool_calls: [{ id: 'c1', ui_content_offset: 0 }], tool_results: [{ tool_call_id: 'c1', content: 'published 1.0.0' }] })
  })

  it('stops a held run and a run that is still pacing', async () => {
    const e = await start({ sessions: [SESSION], runs: [
      { events: [{ type: 'token', payload: { delta: 'partial' } }, { type: '__hold' }] },
      { events: [{ type: 'token', payload: { delta: 'one' } }, { type: 'token', delay: 5000, payload: { delta: 'never' } }] },
    ] })
    const r1 = await e.run('s1', 'first')
    const s1 = e.events(r1.runId)
    await s1.waitFor((f) => f.type === 'token')
    expect((await e.call(`/agent/runs/${r1.runId}/abort`, { method: 'POST' })).body).toEqual({ success: true, settled: true, status: 'aborted' })
    await s1.ended
    expect(s1.frames.map((f) => f.type)).toEqual(['token', 'error'])
    expect(s1.frames[1].payload).toEqual({ error: 'aborted', aborted: true, content: '' })

    const r2 = await e.run('s1', 'second')
    const s2 = e.events(r2.runId)
    await s2.waitFor((f) => f.type === 'token')
    await e.call(`/agent/runs/${r2.runId}/abort`, { method: 'POST' })
    await s2.ended
    expect(s2.frames.map((f) => f.type)).toEqual(['token', 'error'])
    // 停止落半截,不算失败轮;已结束的 run 再停照实回它的终态
    const hist = (await e.call('/agent/sessions/s1/messages')).body
    expect(hist.messages.filter((m: any) => m.role === 'model').map((m: any) => m.content)).toEqual(['partial', 'one'])
    expect(hist.failed_runs).toEqual([])
    expect((await e.call(`/agent/runs/${r2.runId}/abort`, { method: 'POST' })).body.status).toBe('aborted')
    expect((await e.call('/agent/runs?session_id=s1')).body.runs.map((r: any) => r.status)).toEqual(['aborted', 'aborted'])
  })

  it('splits the transcript at turn_boundary and fills the engine-owned ids', async () => {
    const e = await start({ sessions: [SESSION], runs: [{ events: [
      { type: 'token', payload: { delta: 'First part.' } },
      { type: 'turn_boundary', payload: { userMessages: [{ content: 'Also check tests' }] } },
      { type: 'token', payload: { delta: 'Second part.' } },
    ] }] })
    const r = await e.run('s1', 'start')
    const s = e.events(r.runId)
    await s.ended
    const tb = s.frames.find((f) => f.type === 'turn_boundary')!.payload
    expect(tb.finalizedAssistantId).toBe(r.assistantMessageId)
    expect(tb.finalizedContent).toBe('First part.')
    expect(typeof tb.newAssistantId).toBe('string')
    const msgs = (await e.call('/agent/sessions/s1/messages')).body.messages
    expect(msgs.map((m: any) => [m.id, m.role, m.content])).toEqual([
      [r.userMessageId, 'user', 'start'],
      [r.assistantMessageId, 'model', 'First part.'],
      [tb.userMessages[0].id, 'user', 'Also check tests'],
      [tb.newAssistantId, 'model', 'Second part.'],
    ])
  })

  it('records failed runs, applies session_title, and honours done content', async () => {
    const e = await start({ sessions: [SESSION], runs: [
      { events: [{ type: 'session_title', payload: { title: 'Quarterly plan' } }, { type: 'token', payload: { delta: 'draft' } }, { type: 'done', payload: { content: 'Final answer.' } }, { type: 'token', payload: { delta: 'ignored' } }] },
      { events: [{ type: 'error', payload: { error: 'quota_exceeded' } }] },
    ] })
    const ok = e.events((await e.run('s1', 'plan')).runId)
    await ok.ended
    expect(ok.frames.map((f) => f.type)).toEqual(['session_title', 'token', 'done'])
    expect(ok.frames[0].payload).toEqual({ title: 'Quarterly plan', sessionId: 's1' })
    expect((await e.call('/agent/sessions')).body.sessions[0].title).toBe('Quarterly plan')
    const r = await e.run('s1', 'again')
    const bad = e.events(r.runId)
    await bad.ended
    expect(bad.frames.map((f) => f.type)).toEqual(['error'])
    const hist = (await e.call('/agent/sessions/s1/messages')).body
    expect(hist.messages.map((m: any) => m.content)).toEqual(['plan', 'Final answer.', 'again'])
    expect(hist.failed_runs).toEqual([{ assistant_message_id: r.assistantMessageId, user_message_id: r.userMessageId, error: 'quota_exceeded', timestamp: expect.any(Number) }])
  })

  it('a scripted title survives the client\'s auto placeholder title, but not a manual rename', async () => {
    const e = await start({ runs: [
      { events: [{ type: 'session_title', payload: { title: 'Trip to Kyoto' } }, { type: 'token', payload: { delta: 'ok' } }] },
      { events: [{ type: 'session_title', payload: { title: 'Ignored' } }] },
    ] })
    const sid = (await e.call('/agent/sessions', { method: 'POST', body: { app_id: 'tangu' } })).body.session.id
    const s = e.events((await e.run(sid, 'plan a trip to kyoto in spring')).runId)
    await s.ended
    // 渲染层发完第一句给 'New Chat' 会话补的占位标题,到得比剧本的标题晚
    await e.call(`/agent/sessions/${sid}`, { method: 'PATCH', body: { title: 'plan a trip to kyoto in spring', title_source: 'auto' } })
    expect((await e.call('/agent/sessions')).body.sessions[0].title).toBe('Trip to Kyoto')
    await e.call(`/agent/sessions/${sid}`, { method: 'PATCH', body: { title: 'My trip', title_source: 'user' } })
    await e.events((await e.run(sid, 'again')).runId).ended
    expect((await e.call('/agent/sessions')).body.sessions[0].title).toBe('My trip')
  })

  it('keeps renames, archive and deletes; an auto title does not override a manual one', async () => {
    const e = await start({ sessions: [SESSION, { id: 's2', title: 'Other' }] })
    expect((await e.call('/agent/sessions/s1', { method: 'PATCH', body: { title: 'Renamed', title_source: 'user' } })).body.session.title).toBe('Renamed')
    expect((await e.call('/agent/sessions/s1', { method: 'PATCH', body: { title: 'auto guess', title_source: 'auto' } })).body.session.title).toBe('Renamed')
    expect((await e.call('/agent/sessions/s2', { method: 'PATCH', body: { title: 'auto guess', title_source: 'auto' } })).body.session.title).toBe('auto guess')
    expect((await e.call('/agent/sessions/s2', { method: 'PATCH', body: {} })).status).toBe(400)
    await e.call('/agent/sessions/s2', { method: 'PATCH', body: { archived: true } })
    expect((await e.call('/agent/sessions?archived=false')).body.sessions.map((s: any) => [s.id, s.title])).toEqual([['s1', 'Renamed']])
    expect((await e.call('/agent/sessions/s2', { method: 'DELETE' })).body).toEqual({ ok: true })
    expect((await e.call('/agent/sessions?archived=true')).body.sessions).toEqual([])
    expect((await e.call('/agent/sessions/nope', { method: 'PATCH', body: { title: 'x' } })).status).toBe(404)
    expect((await e.call('/agent/sessions/s1/detail')).body.session).toMatchObject({ id: 's1', title: 'Renamed' })
  })

  it('scopes scripted messages, paginates, deletes messages, and refuses deletes during a run', async () => {
    const e = await start({
      sessions: [SESSION, { id: 's2', title: 'Two' }],
      messages: [
        { id: 'm1', role: 'user', content: 'shared question', timestamp: 1000 },
        { id: 'm2', role: 'model', content: 'shared answer', timestamp: 2000 },
        { id: 'm3', role: 'user', content: 'only s2', timestamp: 3000, session_id: 's2' },
      ],
      runs: [{ events: [{ type: '__hold' }] }],
    })
    expect((await e.call('/agent/sessions/s1/messages')).body.messages.map((m: any) => m.id)).toEqual(['m1', 'm2'])
    expect((await e.call('/agent/sessions/s2/messages')).body.messages.map((m: any) => m.id)).toEqual(['m1', 'm2', 'm3'])
    expect((await e.call('/agent/sessions/s2/messages')).body.messages[2]).not.toHaveProperty('session_id')
    expect((await e.call('/agent/sessions/s2/messages?limit=1')).body.messages.map((m: any) => m.id)).toEqual(['m3'])
    expect((await e.call('/agent/sessions/s2/messages?before=3000')).body.messages.map((m: any) => m.id)).toEqual(['m1', 'm2'])
    const created = (await e.call('/agent/sessions', { method: 'POST', body: {} })).body.session
    expect((await e.call(`/agent/sessions/${created.id}/messages`)).body.messages).toEqual([])

    expect((await e.call('/agent/sessions/s2/messages/delete', { method: 'POST', body: { ids: ['m2', 'm3', 'x'] } })).body).toEqual({ ok: true, deleted: 2 })
    expect((await e.call('/agent/sessions/s2/messages')).body.messages.map((m: any) => m.id)).toEqual(['m1'])
    expect((await e.call('/agent/sessions/s1/messages')).body.messages.map((m: any) => m.id)).toEqual(['m1', 'm2'])
    const r = await e.run('s1', 'hold on')
    expect((await e.call('/agent/sessions/s1/messages/delete', { method: 'POST', body: { ids: ['m1'] } })).status).toBe(409)
    await e.call(`/agent/runs/${r.runId}/abort`, { method: 'POST' })
  })

  it('stores session config with PUT and PATCH', async () => {
    const e = await start({ sessions: [SESSION], sessionConfigs: { s1: { execMode: 'sandbox' } } })
    expect((await e.call('/agent/sessions/s1/config')).body).toEqual({ agent_config: { execMode: 'sandbox' } })
    expect((await e.call('/agent/sessions/zz/config')).body).toEqual({ agent_config: { execMode: 'host', approvalMode: 'auto-edit' } })
    expect((await e.call('/agent/sessions/s1/config', { method: 'PATCH', body: { thinkingLevel: 'low', execMode: null } })).body).toEqual({ agent_config: { thinkingLevel: 'low' } })
    expect((await e.call('/agent/sessions/s1/config', { method: 'PUT', body: { execMode: 'host', approvalMode: 'ask' } })).body).toEqual({ agent_config: { execMode: 'host', approvalMode: 'ask' } })
    expect((await e.call('/agent/sessions/s1/config')).body).toEqual({ agent_config: { execMode: 'host', approvalMode: 'ask' } })
  })

  it('answers the remaining stub routes with the same shapes', async () => {
    const e = await start({ searchHits: [{ id: 's1', title: 'Launch notes' }], checkpoints: [{ id: 'cp1' }] })
    expect((await e.call('/agent/sessions/search?q=launch')).body).toEqual({ hits: [{ id: 's1', title: 'Launch notes' }] })
    expect((await e.call('/agent/sessions/search?q=')).body).toEqual({ hits: [] })
    expect((await e.call('/agent/sessions/s1/checkpoints')).body).toEqual({ checkpoints: [{ id: 'cp1' }] })
    expect((await e.call('/agent/sessions/s1/checkpoints/restore', { method: 'POST', body: {} })).body).toEqual({ restored: [], deleted: [], skipped: [], conflicts: [], failed: [] })
    expect((await e.call('/agent/approval-rules', { method: 'PUT', body: { base: 'custom' } })).body.rules.base).toBe('custom')
    expect((await e.call('/agent/approval-rules')).body.base).toBe('custom')
    expect((await e.call('/agent/approvals/pending')).body).toEqual({ rev: 'stage:0', sessions: [] })
    expect((await e.call('/agent/approvals/pending?rev=stage:0')).body).toEqual({ rev: 'stage:0', unchanged: true })
    expect((await e.call('/agent/agents-meta')).body).toEqual({ defaultSlug: 'xyra', order: [] })
    expect((await e.call('/agent/channels')).body).toEqual({ channels: [], available: false })
    expect((await e.call('/agent/engines/x/capabilities')).body).toEqual({ models: [], commands: [] })
    expect((await e.call('/agent/sessions/s1/background')).body).toEqual({ background: [] })
    expect((await e.call('/agent/special/config')).body).toMatchObject({ ok: true, items: [], runs: [] })
    expect((await e.call('/agent/runs')).body).toEqual({ runs: [] })
  })

  it('close() ends open event streams and resolves', async () => {
    const e = await start({ sessions: [SESSION], runs: [{ events: [{ type: 'token', payload: { delta: 'x' } }, { type: '__hold' }] }] })
    const r = await e.run('s1', 'wait')
    const s = e.events(r.runId)
    await s.waitFor((f) => f.type === 'token')
    const approvals = stream(`${e.url}/agent/approvals/stream`)
    await new Promise((res) => setTimeout(res, 30))
    await e.close()
    await expect(Promise.race([s.ended.then(() => 'ended', () => 'ended'), new Promise((res) => setTimeout(() => res('hung'), 1000))])).resolves.toBe('ended')
    await approvals.ended.catch(() => {})
    await expect(fetch(`${e.url}/agent/models`)).rejects.toThrow()
  })
})

describe('stageEngine hardening (Codex 11-20)', () => {
  it('only answers requests carrying this stage\'s token', async () => {
    const e = await startStageEngine(script({}), { token: 'stage-secret' })
    engines.push(e)
    expect((await fetch(`${e.url}/agent/models`)).status).toBe(401)
    expect((await fetch(`${e.url}/agent/models`, { headers: { Authorization: 'Bearer sandbox' } })).status).toBe(401)
    expect((await fetch(`${e.url}/agent/models`, { headers: { Authorization: 'Bearer stage-secret' } })).status).toBe(200)
  })
  it('answers the CORS preflight before the token check, like the real engine, and sends no data with it', async () => {
    // dev 的舞台渲染层在 http://localhost(vite):带 Authorization 的跨源请求先发不带令牌的 OPTIONS。回 401 = 日历「暂时读不到」
    const e = await startStageEngine(script({}), { token: 'stage-secret', calendar: CAL })
    engines.push(e)
    const pre = await fetch(`${e.url}/agent/human/CALENDAR.db`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'authorization, content-type' },
    })
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-origin')).toBe('*')
    expect(pre.headers.get('access-control-allow-headers')).toMatch(/Authorization/)
    expect(pre.headers.get('access-control-allow-headers')).toMatch(/Content-Type/) // 日历的 PUT 带 JSON,少了它浏览器照样拦写
    expect(pre.headers.get('access-control-allow-methods')).toMatch(/PUT/)
    expect(await pre.text()).toBe('')
    // 预检放行不等于放行请求:不带令牌照旧 401,带令牌的回应也带 CORS 头(浏览器据此把响应交给页面)
    const denied = await fetch(`${e.url}/agent/human/CALENDAR.db`)
    expect(denied.status).toBe(401)
    expect(await denied.text()).not.toMatch(/Launch/)
    const ok = await fetch(`${e.url}/agent/human/CALENDAR.db`, { headers: { Authorization: 'Bearer stage-secret' } })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('access-control-allow-origin')).toBe('*')
    const { version } = await ok.json() as { version: string }
    const put = await fetch(`${e.url}/agent/human/CALENDAR.db`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer stage-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { ...CAL, rows: [] }, version }),
    })
    expect(put.status).toBe(200)
    expect(put.headers.get('access-control-allow-origin')).toBe('*')
  })
  it('refuses scripts whose shared messages expand past the cap', () => {
    const sessions = Array.from({ length: 200 }, (_, i) => ({ id: `s${i}` }))
    const messages = Array.from({ length: 150 }, (_, i) => ({ id: `m${i}`, role: 'user', content: 'hi' }))
    expect(errorOf({ sessions, messages })).toMatch(/expand to 30000 rows/)
    expect(errorOf({ sessions, messages: messages.map((m) => ({ ...m, session_id: 's1' })) })).toBe('')
  })
  it('an approval answered before playback reaches __hold is kept and used', async () => {
    const e = await start({ sessions: [SESSION], runs: [{ events: [
      { type: 'approval_request', payload: { approvalId: 'a1', name: 'run_bash', arguments: '{}', preview: 'ls', toolCallId: 'c1' } },
      { type: 'token', payload: { delta: 'Checking… ' }, delay: 300 },
      { type: '__hold' },
      { type: 'token', payload: { delta: 'Done.' } },
    ] }] })
    const r = await e.run('s1', 'go')
    const s = e.events(r.runId)
    await s.waitFor((f) => f.type === 'approval_request')
    await e.call(`/agent/runs/${r.runId}/approvals/a1`, { method: 'POST', body: { action: 'approve' } })
    await s.ended
    expect(s.frames.map((f) => f.type)).toEqual(['approval_request', 'token', 'approval_result', 'token', 'done'])
  })
  it('a delayed event that cannot be stored does not throw out of the timer', async () => {
    const circularish = { result: { toString: null } }
    const e = await start({ sessions: [SESSION], runs: [{ events: [
      { type: 'tool_result', payload: { id: 'c1', name: 'x', ...circularish }, delay: 20 },
      { type: 'token', payload: { delta: 'still here' }, delay: 20 },
    ] }] })
    const r = await e.run('s1', 'go')
    const s = e.events(r.runId)
    await s.ended
    expect(s.frames.map((f) => f.type).at(-1)).toMatch(/done|error/)
  })
})

// 个人日历 human/CALENDAR.db(11-21):演示插件拍日历,fixture 带一份,回放服务照真引擎 routes/human.ts 的报文回
const CAL = {
  version: 2, name: 'My calendar',
  columns: [{ id: 'name', name: 'Name', type: 'text' }, { id: 'date', name: 'Date', type: 'calendarDate' }, { id: 'done', name: 'Done', type: 'checkbox' }],
  rows: [{ id: 'ev1', cells: { name: 'Launch review', date: '2026-11-20T14:00/2026-11-20T15:00' } }],
}

describe('parseStageCalendar', () => {
  it('accepts text (with a BOM), bytes and parsed values of a classic database file', () => {
    expect(parseStageCalendar(JSON.stringify(CAL))).toEqual({ data: CAL })
    expect(parseStageCalendar(Buffer.from('\uFEFF' + JSON.stringify(CAL)))).toEqual({ data: CAL })
    expect(parseStageCalendar(CAL)).toEqual({ data: CAL })
  })
  it('refuses bad JSON, wrong shapes, note views and oversized files', () => {
    expect(parseStageCalendar('{nope')).toMatchObject({ error: expect.stringContaining('not valid JSON') })
    expect(parseStageCalendar({ name: 'x', columns: [], rows: [] })).toMatchObject({ error: expect.stringContaining('database file') })
    expect(parseStageCalendar({ ...CAL, source: { folder: 'Notes' } })).toMatchObject({ error: expect.stringContaining('database file') })
    expect(parseStageCalendar([CAL])).toMatchObject({ error: expect.any(String) })
    expect(parseStageCalendar({ ...CAL, rows: [{}] })).toMatchObject({ error: expect.stringContaining('rows[0]') })
    expect(parseStageCalendar({ ...CAL, columns: [{ id: 'name' }] })).toMatchObject({ error: expect.stringContaining('columns[0]') })
    expect(parseStageCalendar(JSON.stringify({ ...CAL, name: 'x'.repeat(STAGE_CALENDAR_MAX_BYTES) }))).toMatchObject({ error: expect.stringContaining('8 MB') })
  })
})

describe('stage engine personal calendar', () => {
  async function startCal(calendar?: Record<string, unknown>) {
    const e = await startStageEngine(script({}), calendar ? { calendar } : {})
    engines.push(e)
    return async (method: string, body?: unknown) => {
      const r = await fetch(`${e.url}/agent/human/CALENDAR.db`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
      return { status: r.status, body: await r.json() as any }
    }
  }
  it('serves the fixture calendar with a content version, like the real engine', async () => {
    const cal = await startCal(CAL)
    const r = await cal('GET')
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ status: 'ok', data: CAL, legacy: null })
    expect(r.body.version).toMatch(/^[0-9a-f]{64}$/)
  })
  it('writes compare-and-swap in memory: a stale version is a 409, the right one moves the version', async () => {
    const cal = await startCal(CAL)
    const v0 = (await cal('GET')).body.version
    const moved = { ...CAL, rows: [{ id: 'ev1', cells: { name: 'Launch review', date: '2026-11-20T16:00/2026-11-20T17:00' } }] }
    expect((await cal('PUT', { data: moved, version: 'stale' })).status).toBe(409)
    expect((await cal('PUT', { data: moved, version: null })).status).toBe(409)
    const w = await cal('PUT', { data: moved, version: v0 })
    expect(w.status).toBe(200)
    expect(w.body.version).not.toBe(v0)
    const again = await cal('GET')
    expect(again.body).toMatchObject({ status: 'ok', data: moved, version: w.body.version })
  })
  it('without a fixture calendar it is missing (an empty calendar the stage may create with version null)', async () => {
    const cal = await startCal()
    expect((await cal('GET')).body).toEqual({ status: 'missing', legacy: null })
    expect((await cal('PUT', { data: CAL, version: 'x' })).status).toBe(409)
    const w = await cal('PUT', { data: CAL, version: null })
    expect(w.status).toBe(200)
    expect((await cal('GET')).body).toMatchObject({ status: 'ok', data: CAL, version: w.body.version })
  })
  it('refuses writes that are not a database file', async () => {
    const cal = await startCal(CAL)
    expect((await cal('PUT', { data: { rows: [] }, version: null })).status).toBe(400)
    expect((await cal('PUT', { data: CAL, version: 3 })).status).toBe(400)
  })
})
