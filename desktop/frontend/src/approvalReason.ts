/**
 * 审批卡「这次为什么问你」:引擎 approval_request.reason 的清洗 + 文案 + 「总允许」按钮是否有效。
 * 审批事件会持久化重放,畸形 payload 不清洗 = 每次渲染都炸(同 context_info 纪律);kind 白名单外的一律丢掉。
 * 契约 C6:protected = 写凭据 / Forsion 本机配置(C4),引擎每次都问、「总允许」不落 —— 与 escalate 分开标注。
 */
import type { ApprovalReason, ApprovalRemote } from './types'

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

// P1-K1
const VIAS: ReadonlySet<string> = new Set(['tunnel', 'p2p', 'lan'])
const CALLER_KINDS: ReadonlySet<string> = new Set(['phone', 'desktop'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** 名字是登记者自选的不可信串:剥控制符、零宽与双向覆写(防在审批卡上伪装成别的名字)。 */
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g

/**
 * approval_request.remote 的白名单清洗(P1 · K1;事件会持久化重放,同 sanitizeApprovalReason 纪律)。
 * 调用方三字段只在 via==='tunnel' 时收(与引擎「只在 marked && tunnel 时认调用方」同一个不变式);
 * callerUnit 过 uuid、callerKind 过枚举,二者缺一则调用方整组丢;callerName 截 120。不是对象 → undefined(卡上不写来源)。
 */
export function sanitizeApprovalRemote(raw: unknown): ApprovalRemote | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const via = typeof r.via === 'string' && VIAS.has(r.via) ? (r.via as ApprovalRemote['via']) : undefined
  const out: ApprovalRemote = via ? { via } : {}
  if (via === 'tunnel' && typeof r.callerUnit === 'string' && UUID_RE.test(r.callerUnit) && typeof r.callerKind === 'string' && CALLER_KINDS.has(r.callerKind)) {
    out.callerUnit = r.callerUnit.toLowerCase()
    out.callerKind = r.callerKind as ApprovalRemote['callerKind']
    const name = typeof r.callerName === 'string' ? r.callerName.replace(UNSAFE_CHARS, '').trim().slice(0, 120) : ''
    if (name) out.callerName = name
  }
  return out
}

/** 审批卡的来源行:有调用方名 → 「来自远程会话 · 名字」;否则按来路。remote 缺席(本机 run)→ ''(不显示)。
 *  名字是不可信串:调用方只许放进 React 文本节点,不进 dangerouslySetInnerHTML。 */
export function approvalRemoteText(r: ApprovalRemote | undefined, t: (k: string, v?: Record<string, unknown>) => string): string {
  if (!r) return ''
  if (r.callerName) return t('approval.remote.caller', { name: r.callerName })
  if (r.via === 'tunnel') return t('approval.remote.account')
  if (r.via === 'lan') return t('approval.remote.lan')
  if (r.via === 'p2p') return t('approval.remote.p2p')
  return t('approval.remote.unknown')
}
