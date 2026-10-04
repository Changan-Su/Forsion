import type { ToolEvent } from '../types'

/** 引擎 manage_harness 回执里的一次改动(tangu-agent `tools/builtin/manageHarness.ts` 的 HarnessChange;字段只增不改)。
 *  rev = 这次改动在本机编辑史里的那一行:撤销时原样带回,引擎对不上就拒绝(409),不会撤掉后来的修改。 */
export interface HarnessChange {
  rev: string; at: string; agent: string; entryId: string
  action: 'create' | 'revise' | 'delete' | 'rollback'
  kind: string; title: string; body: string; evidence: string; version: number
}
export const HARNESS_CHANGED_EVENT = 'forsion:harness-changed'
const ACTIONS = new Set(['create', 'revise', 'delete', 'rollback'])

/** 只认 manage_harness 自己落库的成功回执(重开历史会话照样还原出卡片);助手正文与别的工具输出一律不算。 */
export function harnessChanges(events: ToolEvent[] = []): HarnessChange[] {
  const changes = new Map<string, HarnessChange>()
  for (const ev of events) {
    if (ev.name !== 'manage_harness' || !ev.done || ev.isError || !ev.result) continue
    try {
      const result = JSON.parse(ev.result), c = result.change
      if (result.kind !== 'harness_update' || !c || typeof c.rev !== 'string' || !/^[a-f0-9-]{36}$/.test(c.rev) ||
        typeof c.agent !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(c.agent) ||
        typeof c.entryId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(c.entryId) || !ACTIONS.has(c.action) ||
        typeof c.title !== 'string' || typeof c.body !== 'string' || typeof c.evidence !== 'string' ||
        typeof c.kind !== 'string' || typeof c.at !== 'string' || typeof c.version !== 'number') continue
      changes.set(c.rev, c)
    } catch { /* list / propose / 报错的回执是纯文本,不出卡 */ }
  }
  return [...changes.values()]
}

export type HarnessChangeState = 'current' | 'undone' | 'superseded'
/** 卡片状态从本机编辑史推出:这条改动仍是该条目的最后一笔 → 可撤;它后面紧跟的唯一一笔是恢复 → 已撤销;
 *  其余(又改过、编辑史里找不到这一行 —— 换了设备或被截断)→ 不能从卡片撤,去笔记里改。 */
export function harnessChangeState(journal: Array<{ entryId: string; action: string; rev?: string }>, change: HarnessChange): HarnessChangeState {
  const lines = journal.filter((l) => l.entryId === change.entryId)
  const i = lines.findIndex((l) => l.rev === change.rev)
  if (i < 0) return 'superseded'
  if (i === lines.length - 1) return 'current'
  return i === lines.length - 2 && lines[i + 1].action === 'rollback' ? 'undone' : 'superseded'
}
