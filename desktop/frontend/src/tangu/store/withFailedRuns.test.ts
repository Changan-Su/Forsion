/** 重开对话时补回失败行:消息接口带来的 failed_runs 怎么并进历史(引擎侧见 tangu-agent/src/services/failedRuns.ts)。 */
import { describe, expect, it } from 'vitest'
import { withFailedRuns } from './tanguSlice'
import type { UiMessage } from '../../types'

const user: UiMessage = { id: 'u2', role: 'user', content: 'hi', status: 'done', timestamp: 100 }
const failed = { assistant_message_id: 'a2', user_message_id: 'u2', error: 'Model "x" has no API key.', timestamp: 101 }

describe('withFailedRuns', () => {
  it('没有回答行 → 按在线气泡的 id 补一行失败,排在用户那一句后面,带上引擎名', () => {
    const out = withFailedRuns([user], [failed], { agentName: 'DSH' })
    expect(out).toEqual([user, { id: 'a2', role: 'assistant', content: '', status: 'error', error: failed.error, timestamp: 101, agentName: 'DSH' }])
  })

  it('有半截回答落了库 → 在那一行上补失败状态与原因,正文不动', () => {
    const partial: UiMessage = { id: 'a2', role: 'assistant', content: 'half', status: 'done', timestamp: 150 }
    expect(withFailedRuns([user, partial], [failed])).toEqual([user, { ...partial, status: 'error', error: failed.error }])
  })

  it('没有原因 → 照在线的兜底写 error;老引擎不带 failed_runs → 原样返回', () => {
    expect(withFailedRuns([user], [{ ...failed, error: '' }])[1].error).toBe('error')
    const ui = [user]
    expect(withFailedRuns(ui, [])).toBe(ui)
  })
})
