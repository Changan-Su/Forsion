import { describe, expect, it } from 'vitest'
import type { BackgroundSessionInfo } from '../../services/backendService'
import type { SubChat } from '../../types'
import { subChatRows } from './subChatRows'

const bg = (o: Partial<BackgroundSessionInfo> & { sessionId: string; kind: string }): BackgroundSessionInfo =>
  ({ title: null, createdAt: '2026-09-25', runId: null, runStatus: null, ...o })
const HIST = bg({ sessionId: 'h1', kind: 'historian', title: 'Historian', runId: 'hr1', runStatus: 'done' })
const DISC = bg({ sessionId: 'd1', kind: 'discussion', title: '讨论', runId: 'dr1', runStatus: 'running' })
const TEAM = bg({ sessionId: 't1', kind: 'teamwork', title: '成员', runId: 'tr1' })
// RightViews 的 subchats 视图把 /background 的行并进 live 时的形状:id=runId,没有 sessionId,带后台 kind
const merged = (runId: string, title: string, bgKind = title === 'Historian' ? 'historian' : 'discussion'): SubChat =>
  ({ id: runId, kind: 'discussion', title, runId, bgKind, streaming: false, segs: [] })

describe('subChatRows(U-04 右栏去重)', () => {
  it('Historian 开:不列 historian 子会话,teamwork 永不列', () => {
    expect(subChatRows([HIST, DISC, TEAM], [], true).map((r) => r.sessionId)).toEqual(['d1'])
  })
  it('Historian 关:旧记录照旧列出(HistorianStatus 不挂载,入口只剩这里)', () => {
    expect(subChatRows([HIST, DISC], [], false).map((r) => r.title)).toEqual(['Historian', '讨论'])
  })
  it('⚠️ live 里并回来的 historian(同 runId)不能从 live 那头漏回来', () => {
    const rows = subChatRows([HIST, DISC], [merged('hr1', 'Historian'), merged('dr1', '讨论')], true)
    expect(rows.map((r) => r.title)).toEqual(['讨论'])
  })
  it('⚠️ Historian 跑过新 run 后,live 里残留的旧 run(无 sessionId、后台 kind=historian)也不漏回来', () => {
    const rows = subChatRows([HIST, DISC], [merged('hr0-old', 'Historian'), merged('dr1', '讨论')], true)
    expect(rows.map((r) => r.title)).toEqual(['讨论'])
    // Historian 关:旧 run 照旧列出(与改动前一致)
    expect(subChatRows([HIST], [merged('hr0-old', 'Historian')], false).map((r) => r.id)).toEqual(['h1', 'hr0-old'])
  })
  it('负对照:Historian 关时同一条 live 按 runId 与 saved 合并,不重复', () => {
    expect(subChatRows([HIST], [merged('hr1', 'Historian')], false)).toHaveLength(1)
  })
  it('⚠️ 负例:同名「Historian」的普通子会话(实时 subagent / 讨论)不因标题被藏(Codex 第一轮 B1-2)', () => {
    const liveSub: SubChat = { id: 'sub-h', kind: 'subagent', title: 'Historian', streaming: true, segs: [] }
    const disc = merged('dr-h', 'Historian', 'discussion')
    expect(subChatRows([HIST], [liveSub], true).map((r) => r.id)).toEqual(['sub-h'])
    expect(subChatRows([HIST], [disc], true).map((r) => r.id)).toEqual(['dr-h'])
  })
  it('saved 里没有的 live 委派照常追加', () => {
    const sub: SubChat = { id: 's9', kind: 'subagent', title: 'Sub', sessionId: 's9', streaming: true, segs: [] }
    expect(subChatRows([HIST], [sub], true).map((r) => r.id)).toEqual(['s9'])
  })
})
