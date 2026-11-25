// @vitest-environment happy-dom
// 折叠过程行的失败口径(11-23):后来同一个目标又做成了 = 重试(灰字、不挂红叉);你拒绝的 = 已拒绝;插话时没来得及跑的 = 已跳过;
// 只有最后仍没做成的才写「N 个失败」并挂红叉;「编辑 N 文件」这类计数只算做成了的步。
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolEvent } from '../types'
import { translateFor } from '../i18n'
import '../tangu/store/tanguSlice' // appstore.steerDiscardedCall 那句在这里登记(插话收尾时由它写进调用)
import { ToolGroup, isSteerDiscarded, retryTarget, stepOutcomes } from './ToolGroup'
import { BRIDGE_USER_REJECT_REASON, PARKED_USER_REJECT_REASON, USER_REJECT_REASON, isUserRejectedToolResult } from '../../../../tangu-agent/src/contracts/toolRejection'

const edit = (id: string, path: string, extra: Partial<ToolEvent> = {}): ToolEvent => ({
  id, name: 'edit_file', arguments: JSON.stringify({ path, old_string: 'a', new_string: 'b' }), done: true, result: 'edited', startedAt: 1, ...extra,
})
const fail = (msg = 'Error: old_string not found'): Partial<ToolEvent> => ({ isError: true, result: msg })
const bash = (id: string, command: string, extra: Partial<ToolEvent> = {}): ToolEvent => ({
  id, name: 'run_bash', arguments: JSON.stringify({ command }), done: true, result: 'ok', startedAt: 1, ...extra,
})
const read = (id: string, path: string, extra: Partial<ToolEvent> = {}): ToolEvent => ({
  id, name: 'read_file', arguments: JSON.stringify({ path }), done: true, result: '…', startedAt: 1, ...extra,
})
const steerDiscarded = (locale: 'zh' | 'en'): Partial<ToolEvent> => ({ isError: true, startedAt: undefined, result: translateFor(locale, 'appstore.steerDiscardedCall') })

describe('stepOutcomes', () => {
  it('a failed edit followed by a successful edit of the same file is a retry; a different file stays a failure', () => {
    expect(stepOutcomes([edit('e1', 'src/a.ts', fail()), edit('e2', 'src/a.ts')], false)).toEqual(['retried', 'ok'])
    expect(stepOutcomes([edit('e1', 'src/a.ts', fail()), edit('e2', 'lib/a.ts')], false)).toEqual(['failed', 'ok']) // 同名不同目录不算
  })

  it('a retry only counts when the later call actually succeeded, came later, and used the same tool', () => {
    expect(stepOutcomes([edit('e1', 'a.ts', fail()), edit('e2', 'a.ts', fail())], false)).toEqual(['failed', 'failed'])
    expect(stepOutcomes([edit('e1', 'a.ts'), edit('e2', 'a.ts', fail())], false)).toEqual(['ok', 'failed']) // 成功在前不算
    expect(stepOutcomes([edit('e1', 'a.ts', fail()), { ...edit('e2', 'a.ts'), name: 'write_file' }], false)).toEqual(['failed', 'ok'])
    expect(stepOutcomes([edit('e1', 'a.ts', fail()), edit('e2', 'a.ts', { done: false, result: undefined })], true)).toEqual(['failed', 'ok']) // 还在跑
    expect(stepOutcomes([edit('e1', 'a.ts', fail()), edit('e2', 'a.ts', { parked: true })], true)).toEqual(['failed', 'ok']) // 挂起等批准不是做成
  })

  it('commands match on the whole command, not only its first line', () => {
    expect(stepOutcomes([bash('b1', 'npm test', fail('exit 1')), bash('b2', 'npm test')], false)).toEqual(['retried', 'ok'])
    expect(stepOutcomes([bash('b1', 'cd a\nnpm test', fail('exit 1')), bash('b2', 'cd a\nnpm run build')], false)).toEqual(['failed', 'ok'])
    expect(retryTarget(bash('x', 'cd a\nnpm test'))).not.toBe(retryTarget(bash('y', 'cd a\nnpm run build')))
  })

  it('a different rename destination, search scope or working directory is not the same target', () => {
    const patch = (to: string): ToolEvent => ({ id: to, name: 'apply_patch', arguments: JSON.stringify({ patch: `*** Begin Patch\n*** Update File: old.ts\n*** Move to: ${to}\n*** End Patch` }), done: true, result: 'ok', startedAt: 1 })
    expect(stepOutcomes([{ ...patch('first.ts'), ...fail() }, patch('second.ts')], false)).toEqual(['failed', 'ok'])
    expect(stepOutcomes([{ ...patch('first.ts'), ...fail() }, patch('first.ts')], false)).toEqual(['retried', 'ok'])
    const search = (id: string, include: string, extra: Partial<ToolEvent> = {}): ToolEvent => ({ id, name: 'search_files', arguments: JSON.stringify({ query: 'boot', include }), done: true, result: 'ok', startedAt: 1, ...extra })
    expect(stepOutcomes([search('s1', 'src', fail()), search('s2', 'lib')], false)).toEqual(['failed', 'ok'])
    const inDir = (id: string, cwd: string, extra: Partial<ToolEvent> = {}): ToolEvent => ({ ...bash(id, 'npm test'), arguments: JSON.stringify({ command: 'npm test', cwd }), ...extra })
    expect(stepOutcomes([inDir('b1', 'a', fail('exit 1')), inDir('b2', 'b')], false)).toEqual(['failed', 'ok'])
  })

  it('user rejections are recognised from the result text in every wording the engine writes, live and after reload alike', () => {
    for (const text of [USER_REJECT_REASON, PARKED_USER_REJECT_REASON, BRIDGE_USER_REJECT_REASON]) {
      expect(isUserRejectedToolResult(text)).toBe(true)
      expect(stepOutcomes([edit('e1', 'a.ts', fail(text))], false)).toEqual(['rejected'])
    }
    // 规则 / hook / 无人值守挡下的不是「你拒绝的」,照旧算失败
    expect(isUserRejectedToolResult('Denied by approval rule: no-writes')).toBe(false)
    expect(isUserRejectedToolResult(undefined)).toBe(false)
  })

  it('a rejected call is never upgraded to a retry, even when the same edit later succeeded', () => {
    expect(stepOutcomes([edit('e1', 'a.ts', fail(USER_REJECT_REASON)), edit('e2', 'a.ts')], false)).toEqual(['rejected', 'ok'])
  })

  it('steer-discarded calls (never started, desktop-written sentence in either language) are skipped', () => {
    for (const loc of ['zh', 'en'] as const) {
      const ev = edit('e1', 'a.ts', steerDiscarded(loc))
      expect(isSteerDiscarded(ev)).toBe(true)
      expect(stepOutcomes([ev], false)).toEqual(['skipped'])
    }
    // 同一句话但引擎开始过它(有 startedAt)= 不是插话丢掉的;没有 startedAt 的普通报错(外部引擎)也不是
    expect(isSteerDiscarded({ ...steerDiscarded('zh'), startedAt: 5 })).toBe(false)
    expect(isSteerDiscarded({ isError: true, startedAt: undefined, result: 'Error: boom' })).toBe(false)
  })

  it('interrupted placeholders stay their own bucket once the reply is no longer running', () => {
    const cutEv = { ...edit('e1', 'a.ts'), result: undefined, isError: false, inflight: { state: 'started' } } as ToolEvent
    expect(stepOutcomes([cutEv], false)).toEqual(['cut'])
    expect(stepOutcomes([cutEv], true)).toEqual(['ok'])
  })
})

describe('ToolGroup folded line', () => {
  let host: HTMLDivElement
  let root: Root
  beforeEach(() => {
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
  })
  const render = async (events: ToolEvent[]) => { await act(async () => root.render(React.createElement(ToolGroup, { events }))) }
  const longSum = () => host.querySelector('.tool-group-sum-long')?.textContent
  const shortSum = () => host.querySelector('.tool-group-sum-short')?.textContent
  const redCross = () => host.querySelector('.tool-group-status svg')

  it('a recovered retry is a grey note, the failed attempt is not counted, and there is no red cross', async () => {
    await render([edit('e1', 'desktop/electron/boot.ts', fail()), edit('e2', 'desktop/electron/boot.ts'), read('r1', 'a.ts')])
    expect(longSum()).toBe('编辑 1 文件 · 读取 1 项 · 重试 1 次')
    expect(host.querySelector('.tool-group-sum-long .tool-group-note')?.textContent).toBe('重试 1 次')
    expect(shortSum()).toBe('2 步')
    expect(redCross()).toBeNull()
  })

  it('an unrecovered failure is left out of the counts, says how many failed, and keeps the red cross', async () => {
    await render([edit('e1', 'a.ts', fail()), read('r1', 'b.ts')])
    expect(longSum()).toBe('读取 1 项 · 1 个失败')
    expect(shortSum()).toBe('1 步 · 1 个失败')
    expect(redCross()).not.toBeNull()
  })

  it('rejected and skipped calls get grey notes, not the red cross, and are not counted as edits', async () => {
    await render([edit('e1', 'a.ts', fail(USER_REJECT_REASON)), edit('e2', 'b.ts', steerDiscarded('zh')), read('r1', 'c.ts')])
    expect(longSum()).toBe('读取 1 项 · 已拒绝 1 · 已跳过 1')
    expect(shortSum()).toBe('1 步 · 已拒绝 1 · 已跳过 1')
    expect(redCross()).toBeNull()
  })

  it('the catch-all bucket reads 另 N 步 next to other buckets and N 步 when it is the only one', async () => {
    const todo = (id: string): ToolEvent => ({ id, name: 'todo_write', arguments: '{}', done: true, result: 'ok', startedAt: 1 })
    await render([edit('e1', 'a.ts'), todo('t1')])
    expect(longSum()).toBe('编辑 1 文件 · 另 1 步')
    await render([todo('t1'), todo('t2')])
    expect(longSum()).toBe('2 步')
  })
})
