/**
 * 审批卡「这次为什么问你」:引擎 approval_request.reason 的清洗 + 文案 + 「总允许」按钮是否有效。
 * 审批事件会持久化重放,畸形 payload 不清洗 = 每次渲染都炸(同 context_info 纪律);kind 白名单外的一律丢掉。
 * 契约 C6:protected = 写凭据 / Forsion 本机配置(C4),引擎每次都问、「总允许」不落 —— 与 escalate 分开标注。
 */
import type { ApprovalReason } from './types'

const KINDS: ReadonlySet<string> = new Set<ApprovalReason['kind']>(['custom-ask', 'escalate', 'mode', 'protected'])
const MODES: ReadonlySet<string> = new Set(['readonly', 'auto-edit', 'full-auto'])

export function sanitizeApprovalReason(raw: unknown): ApprovalReason | undefined {
  const r = raw as { kind?: unknown; rule?: unknown; mode?: unknown } | null | undefined
  const kind = r?.kind
  if (typeof kind !== 'string' || !KINDS.has(kind)) return undefined
  return {
    kind: kind as ApprovalReason['kind'],
    ...(typeof r!.rule === 'string' && r!.rule ? { rule: r!.rule.slice(0, 200) } : {}),
    ...(typeof r!.mode === 'string' && MODES.has(r!.mode) ? { mode: r!.mode as ApprovalReason['mode'] } : {}),
  }
}

/** 引擎在这些情形下**不会**把工具记进「总允许」(approvals.ts:越界写 / 受保护路径每次都确认,custom 的 ask 是
 *  用户写死的「永远问我」)。按钮却照常显示 = 又一处「界面说一套引擎做一套」。 */
export const alwaysAllowWorks = (r: ApprovalReason | undefined): boolean =>
  r?.kind !== 'escalate' && r?.kind !== 'custom-ask' && r?.kind !== 'protected'

/** 档位 id 是连字符(引擎口径),i18n 键是驼峰(既有) —— 映射写一处,别两边各拼各的。 */
export const MODE_KEY: Record<string, string> = {
  readonly: 'approval.mode.readonly',
  'auto-edit': 'approval.mode.autoEdit',
  'full-auto': 'approval.mode.fullAuto',
}

export function approvalReasonText(r: ApprovalReason | undefined, t: (k: string, v?: Record<string, unknown>) => string): string {
  if (!r) return ''
  if (r.kind === 'custom-ask') return t('approval.why.customAsk', { rule: r.rule || '' })
  if (r.kind === 'escalate') return t('approval.why.escalate')
  if (r.kind === 'protected') return t('approval.why.protected')
  const m = r.mode && MODE_KEY[r.mode] ? t(MODE_KEY[r.mode]) : ''
  return m ? t('approval.why.mode', { mode: m }) : ''
}
