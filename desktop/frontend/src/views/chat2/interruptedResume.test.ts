// @vitest-environment happy-dom
/**
 * 中断任务续跑方案 B 第 7、8 节的界面:
 *  - 带原因的中断行 <turn_interrupted>[reason] → 「⏸ <原因>」+(最后一行、没在跑时)「继续生成」,发的续写行带同一个原因;
 *  - 自动续跑行 <turn_resume>[auto-resume] → 「↻ <原因>，已接着做」;
 *  - 在线收到的中断(stopped + interrupted 标记)不画「⏹ 已停止」与它下面的「继续生成」;
 *  - 断在半截的工具调用(占位结果 inflight)画成灰色的「被打断」一步,从不当成功、不出结果卡、不崩。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocaleProvider, translateFor } from '../../i18n'
import { EditorialMessage, autoResumedLineKey, interruptedLineKey, partitionToolSegment, type MessageHandlers } from './EditorialMessage'
import { ToolGroup, labelPhase } from '../../components/ToolGroup'
import { useApp } from '../../stores/appStore'
import { recordToUi, sketchFromToolEvent } from '../../tangu/store/tanguSlice'
import { cardEligible } from '../../amadeus/plugins/toolResultCards'
import { collectStudioWrites } from '../coding/studioModel'
import { summarizeTask } from './taskFacts'
import { inflightOf, inflightFromResult, inflightTextKey } from '../../tangu/inflightTool'
import { autoResumeMarker, interruptedNoticeMarker, turnResumeMarker, INTERRUPT_REASONS, type InterruptReason } from '../../../../../tangu-agent/src/contracts/turnResume'
import type { ToolEvent, UiMessage } from '../../types'
import '../../tangu/store/standalone'

const SID = 's-resume'
let host: HTMLDivElement
let root: Root
const initial = useApp.getState()
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); useApp.setState(initial, true) })

const user = (id: string, content: string): UiMessage => ({ id, role: 'user', content, status: 'done', timestamp: 1 })
const answer = (id: string, extra: Partial<UiMessage> = {}): UiMessage => ({ id, role: 'assistant', content: 'merged weeks 1 and 2', status: 'done', timestamp: 2, ...extra })
async function render(msg: UiMessage, list: UiMessage[], handlers?: MessageHandlers, running = false): Promise<void> {
  useApp.setState({ messagesBySession: { [SID]: list }, runningBySession: running ? { [SID]: 'r' } : {} })
  await act(async () => root.render(React.createElement(LocaleProvider, {
    children: React.createElement(EditorialMessage, { msg, handlers, fileCtx: { cfg: useApp.getState().cfg, sessionId: SID, onOpenPreview: () => {} } as never }),
  })))
}
const text = (): string => host.textContent || ''
const button = (id: string): HTMLButtonElement | null => host.querySelector(`[data-testid="${id}"]`)

describe('interrupted-notice row (no automatic resume)', () => {
  const notice = user('n', interruptedNoticeMarker('app_quit'))
  it('says why, and the latest one offers Continue that tells the model the user did not stop it', async () => {
    const onContinue = vi.fn(), onRetry = vi.fn()
    await render(notice, [user('u', 'merge notes'), answer('a'), notice], { onContinue, onRetry })
    expect(text()).toContain('⏸ 应用退出时这一轮还没做完')
    expect(text()).not.toContain('⏹')
    expect(button('msg-retry')).toBeNull()
    await act(async () => button('msg-continue')!.click())
    expect(onContinue).toHaveBeenCalledWith('app_quit')
    expect(turnResumeMarker('app_quit')).toContain('the user did not stop it')
  })
  // 评审 #7 之后冷开对话,说明前面的回答行是 stopped + interrupted:<原因>(不再是 done):按钮与那一行的画法都不能变
  it('with the answer restored as quietly stopped (cold open): still Continue, and the answer shows no Stopped line', async () => {
    const restored = answer('a', { status: 'stopped', error: 'interrupted:app_quit' })
    const onContinue = vi.fn(), onRetry = vi.fn()
    await render(notice, [user('u', 'merge notes'), restored, notice], { onContinue, onRetry })
    expect(button('msg-continue')).not.toBeNull()
    expect(button('msg-retry')).toBeNull()
    await render(restored, [user('u', 'merge notes'), restored, notice], { onContinue, onRetry })
    expect(text()).toContain('merged weeks 1 and 2')
    expect(text()).not.toContain('⏹')
    expect(button('msg-continue')).toBeNull()
    expect(button('msg-retry')).toBeNull()
  })
  it('no button while the session runs or once a newer row follows', async () => {
    const h = { onContinue: vi.fn(), onRetry: vi.fn() }
    await render(notice, [user('u', 'merge notes'), answer('a'), notice], h, true)
    expect(button('msg-continue')).toBeNull()
    await render(notice, [user('u', 'merge notes'), answer('a'), notice, user('u2', 'something else')], h)
    expect(button('msg-continue')).toBeNull()
    await render(notice, [user('u', 'merge notes'), answer('a'), notice, user('c', turnResumeMarker('app_quit'))], h)
    expect(button('msg-continue')).toBeNull()
  })
  it('nothing produced yet → Retry instead of Continue; read-only views get no button', async () => {
    const onRetry = vi.fn()
    const bare = user('n2', interruptedNoticeMarker('crash'))
    await render(bare, [user('u', 'merge notes'), bare], { onContinue: vi.fn(), onRetry })
    expect(text()).toContain('⏸ 引擎意外退出，这一轮还没做完')
    expect(button('msg-continue')).toBeNull()
    await act(async () => button('msg-retry')!.click())
    expect(onRetry).toHaveBeenCalledOnce()
    await render(notice, [user('u', 'merge notes'), answer('a'), notice], undefined)
    expect(button('msg-continue')).toBeNull()
  })
  it('the old user-stop marker is unchanged', async () => {
    const stop = user('s', '<turn_interrupted>\nThe user interrupted this turn on purpose.\n</turn_interrupted>')
    await render(stop, [user('u', 'x'), answer('a'), stop], { onContinue: vi.fn() })
    expect(text()).toContain('⏹')
    expect(button('msg-continue')).toBeNull()
  })
})

describe('auto-resume row', () => {
  it.each([
    ['app_quit', '↻ 应用退出时这一轮还没做完，已接着做'],
    ['app_update', '↻ 更新打断了这一轮，已接着做'],
    ['engine_restart', '↻ 引擎重启打断了这一轮，已接着做'],
    ['crash', '↻ 引擎意外退出，已接着做'],
    ['worker_restart', '↻ 服务重启打断了这一轮，已接着做'],
  ] as const)('%s', async (reason, line) => {
    const row = user('r', autoResumeMarker(reason))
    await render(row, [row])
    expect(text()).toBe(line)
  })
  it('reasons without approved copy and the user-clicked Continue keep today\'s line', async () => {
    for (const content of [autoResumeMarker('account_change'), autoResumeMarker('engine_stop'), turnResumeMarker('app_quit'), turnResumeMarker('stopped')]) {
      const row = user('r', content)
      await render(row, [row])
      expect(text()).toBe('↻ 从这里继续生成')
    }
  })
})

describe('copy (zh / en, sentence case)', () => {
  it('every interrupt reason has both languages', () => {
    const en: Record<InterruptReason, string> = {
      app_quit: 'This task was cut off when the app quit', app_update: 'An update interrupted this task',
      engine_restart: 'The engine restarted mid-task', account_change: 'Switching accounts interrupted this task',
      engine_stop: 'The engine was stopped before this task finished', crash: 'The engine stopped unexpectedly before this task finished',
      worker_restart: 'A server restart interrupted this task',
    }
    for (const r of INTERRUPT_REASONS) expect(translateFor('en', interruptedLineKey(r))).toBe(en[r])
    expect(translateFor('en', autoResumedLineKey('app_update'))).toBe('An update interrupted this task — picked up where it left off')
    expect(translateFor('en', autoResumedLineKey('crash'))).toBe('The engine stopped unexpectedly — picked up where it left off')
  })
})

describe('a live interruption on the answer itself', () => {
  it('stopped + interrupted marker: no "Stopped" line, no Continue (that one says the user stopped it)', async () => {
    const a = answer('a', { status: 'stopped', error: 'interrupted:app_update' })
    await render(a, [user('u', 'merge notes'), a], { onContinue: vi.fn(), onRetry: vi.fn() })
    expect(host.querySelector('[data-halt]')).toBeNull()
    expect(button('msg-continue')).toBeNull()
    expect(host.querySelector('.t2-status-err')).toBeNull()
  })
  it('control: a real user stop keeps "Stopped" and its Continue', async () => {
    const a = answer('a', { status: 'stopped' })
    await render(a, [user('u', 'merge notes'), a], { onContinue: vi.fn(), onRetry: vi.fn() })
    expect(host.querySelector('[data-halt="stopped"]')).not.toBeNull()
    expect(button('msg-continue')).not.toBeNull()
  })
})

describe('placeholder tool results (cut off mid-call)', () => {
  const row = {
    id: 'm', role: 'model', content: 'working', timestamp: 2,
    tool_calls: [
      { id: 'w', function: { name: 'write_file', arguments: '{"path":"/tmp/report.md","content":"x"}' } },
      { id: 'p', function: { name: 'web_fetch', arguments: '{"url":"https://example.com"}' } },
      { id: 'r', function: { name: 'read_file', arguments: '{"path":"/tmp/a.md"}' } },
      { id: 'ok', function: { name: 'read_file', arguments: '{"path":"/tmp/b.md"}' } },
      { id: 'h', function: { name: 'sketch', arguments: '{"html":"<p>x</p>"}' } },
    ],
    tool_results: [
      { tool_call_id: 'w', inflight: { state: 'started', sideEffect: 'write' } },
      { tool_call_id: 'p', inflight: { state: 'pending', sideEffect: 'network' } },
      { tool_call_id: 'r', inflight: { state: 'started', sideEffect: 'read' } },
      { tool_call_id: 'ok', content: 'file body' },
      { tool_call_id: 'h', inflight: { state: 'started' } },
    ],
  }
  const events = (): ToolEvent[] => recordToUi(row).toolEvents!

  it('normalises to "no result", never success, never error', () => {
    const [w, p, r, ok, h] = events()
    expect(w).toMatchObject({ done: true, result: undefined, isError: false })
    expect(inflightOf(w)).toEqual({ state: 'started', sideEffect: 'write' })
    expect(inflightOf(p)).toEqual({ state: 'pending', sideEffect: 'network' })
    expect(inflightOf(r)).toEqual({ state: 'started', sideEffect: 'read' })
    expect(ok).toMatchObject({ done: true, result: 'file body' })
    expect(inflightOf(ok)).toBeUndefined()
    expect([w, p, r, h].map(inflightTextKey as never)).toBeDefined()
    expect(inflightTextKey(inflightOf(w)!)).toBe('tool.inflight.unknown')
    expect(inflightTextKey(inflightOf(p)!)).toBe('tool.inflight.notRun')
    expect(inflightTextKey(inflightOf(r)!)).toBe('tool.inflight.readCut')
  })

  it('no result card, no artifact, no written file counts it', () => {
    const list = events()
    const [w, , , , h] = list
    expect(sketchFromToolEvent(h)).toBeUndefined()
    expect(cardEligible(w)).toBe(false)
    expect(collectStudioWrites([{ ...answer('a'), toolEvents: list }], '/tmp')).toEqual([])
    const facts = summarizeTask([user('u', 'x'), { ...answer('a'), toolEvents: list }], false, '/tmp')
    expect(JSON.stringify(facts)).not.toContain('report.md')
    // 只进通用过程行:不切出 sketch / web / 插件卡
    expect(partitionToolSegment(list, [], false, () => ({}) as never, () => ({ kind: 'local', path: '/tmp/x.html' }))
      .filter((p) => p.t !== 'tools' && p.t !== 'web' && p.t !== 'pluginCard')).toEqual([])
    const parts = partitionToolSegment([w], [], false, () => ({}) as never, () => ({ kind: 'local', path: '/tmp/x.html' }))
    expect(parts).toEqual([{ t: 'tools', events: [w] }])
  })

  it('git steps that finished before a cut-off one still get their card', () => {
    const status: ToolEvent = { id: 'g1', name: 'git_status', done: true, result: 'clean' }
    const commit = { id: 'g2', name: 'git_commit', done: true, isError: false, inflight: { state: 'started' } } as ToolEvent
    const parts = partitionToolSegment([status, commit])
    expect(parts.map((p) => p.t)).toEqual(['tools', 'git', 'tools'])
  })

  it('renders as a muted interrupted step with the right sentence', async () => {
    await act(async () => root.render(React.createElement(LocaleProvider, { children: React.createElement(ToolGroup, { events: events().slice(0, 3) }) })))
    await act(async () => (host.querySelector('.tool-group-head') as HTMLButtonElement).click())
    expect(host.querySelectorAll('[data-inflight]')).toHaveLength(3)
    for (const head of host.querySelectorAll('.tool-row-head')) await act(async () => (head as HTMLButtonElement).click())
    expect(text()).toContain('结果未知：这一步执行到一半引擎停了，可能已经部分或全部生效。')
    expect(text()).toContain('没有执行：引擎在这一步开始前停了。')
    expect(text()).toContain('被打断：引擎在这一步做完前停了。这一步只读取，不改动任何东西。')
    expect(host.innerHTML).not.toContain('var(--danger)')
  })

  // 评审 #9:折叠着看,没跑成的 write_file 不能说成「写入 1 文件」;折叠头直接说有几步被打断;插件描述器拿不到 done 阶段
  it('the folded head counts only finished steps and says how many were interrupted; a never-run write shows no +N', async () => {
    const [w, , , ok] = events()
    const head = (): string => (host.querySelector('.tool-group-sum-long')?.textContent || '')
    const short = (): string => (host.querySelector('.tool-group-sum-short')?.textContent || '')
    await act(async () => root.render(React.createElement(LocaleProvider, { children: React.createElement(ToolGroup, { events: [w, ok] }) })))
    expect(head()).toBe(`${translateFor('zh', 'tool.sum.read', { n: 1 })} · 1 步被打断`)
    expect(head()).not.toContain(translateFor('zh', 'tool.sum.wrote', { n: 1 }))
    expect(short()).toBe(`${translateFor('zh', 'tool.sumN', { n: 1 })} · 1 步被打断`)
    // 整组都没跑成:头上也有话说,不是空的
    await act(async () => root.render(React.createElement(LocaleProvider, { children: React.createElement(ToolGroup, { events: [w] }) })))
    expect(head()).toBe('1 步被打断')
    expect(short()).toBe('1 步被打断')
    await act(async () => (host.querySelector('.tool-group-head') as HTMLButtonElement).click())
    expect(host.querySelector('[data-inflight] .tool-row-stat')).toBeNull() // 内容 1 行,但写没写成不知道:不报 +1
    // 还在跑(接上在跑的 run、回放还没换掉占位):照旧按普通的一步算,不说被打断
    await act(async () => root.render(React.createElement(LocaleProvider, { children: React.createElement(ToolGroup, { events: [w], running: true }) })))
    expect(host.textContent).not.toContain('被打断')
  })

  it('English head copy', () => {
    expect(translateFor('en', 'tool.sum.interrupted', { n: 2 })).toBe('2 step(s) interrupted')
  })

  it('plugin tool labels never get the done phase for a placeholder', () => {
    const [w, , , ok] = events()
    expect(labelPhase(w, false)).toBe('error') // 和「没做完而消息已经停了」同一个阶段
    expect(labelPhase(w, true)).toBe('running')
    expect(labelPhase(ok, false)).toBe('done')
  })

  it('odd shapes never crash and never count as a placeholder by accident', () => {
    expect(inflightFromResult({ inflight: 'x' })).toBeUndefined()
    expect(inflightFromResult({ inflight: null })).toBeUndefined()
    expect(inflightFromResult(undefined)).toBeUndefined()
    expect(inflightFromResult({ inflight: {} })).toEqual({ state: 'started' })
    const odd = recordToUi({ ...row, tool_results: [{ tool_call_id: 'w', inflight: { state: 42, sideEffect: 7 } }] }).toolEvents![0]
    expect(inflightOf(odd)).toEqual({ state: 'started' })
  })
})
