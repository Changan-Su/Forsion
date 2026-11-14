/**
 * 委托管理员(Unit 网页的一种来路):经云端中转进来、带着已验签的管理员声明的人,只能管这台设备上的 Agent ——
 * 名册 / 新建 / 修改 / 删除 / 头像、按 Agent 启停技能、日程、模型与工具名单只读。别的面(会话、笔记库、收件箱、用量、
 * Hooks、MCP、同步、通道……)那台设备一律 403 LOCAL_ONLY(desktop/electron/unitWeb.ts 的白名单是真闸)。
 *
 * 壳在这个角色下**不发**白名单外的请求、只露 Agent 管理:所有门控都问这一个函数,不在各处另判来路。
 * 角色只由 web/src/unitShim.ts 按 `unit/whoami` 的回包设(window.tangu.delegatedAdmin);桌面窗口、手机包、
 * 普通网页版与别的 Unit 来路都不设这个键 → 恒 false,行为与改版前一致。
 */
import { create } from 'zustand'
import { registerMessages } from '../i18n'

registerMessages({
  'delegatedAdmin.role': { zh: '管理员', en: 'Admin' },
  'delegatedAdmin.signedInAs': { zh: '管理员 · {name}', en: 'Admin · {name}' },
  'delegatedAdmin.approvalCapHint': {
    zh: '远程管理时审批最高到「{mode}」，更宽的档只能在那台设备上设置',
    en: 'Remote admins can set approval up to “{mode}”. Wider modes can only be set on that device',
  },
  'delegatedAdmin.skillsReadOnly': {
    zh: '远程管理时这里只能查看。要给某个 Agent 启用或停用技能，请到该 Agent 的「技能」页',
    en: 'Remote admins can only view this list. To turn a skill on or off for an agent, use that agent’s Skills tab',
  },
})

export type ApprovalCap = 'readonly' | 'auto-edit' | 'full-auto'
const RANK: Record<ApprovalCap, number> = { readonly: 0, 'auto-edit': 1, 'full-auto': 2 }

/** 这个页面是不是委托管理员角色。 */
export function isDelegatedAdmin(): boolean {
  if (typeof window === 'undefined') return false
  const t = window.tangu
  return !!t?.unitPage && !!t.delegatedAdmin
}

/** 操作者的显示名(hub 签发的声明里带的,只作界面显示)。 */
export function delegatedAdminName(): string {
  return (isDelegatedAdmin() && window.tangu?.delegatedAdmin?.name) || ''
}

/** 那台设备给远端定的审批档上限(引擎在委托管理员的 Agent 名册回包里带 approvalCap)。没读到 = null(编辑器按最严的理解)。 */
export const useDelegatedApprovalCap = create<{ cap: ApprovalCap | null }>(() => ({ cap: null }))

/** Agent 名册回包到手时记下上限;只在这个角色下记(别的来路回包里本来就没有这个字段)。 */
export function noteApprovalCap(value: unknown): void {
  if (!isDelegatedAdmin()) return
  if (value === 'readonly' || value === 'auto-edit' || value === 'full-auto') {
    if (useDelegatedApprovalCap.getState().cap !== value) useDelegatedApprovalCap.setState({ cap: value })
  }
}

/**
 * 审批档选项在这个角色下能不能选:只收三档,且不超过上限。'' (跟随会话)与 'custom' 远端写不进去(引擎不收),一律不可选。
 * 上限没读到时只放 readonly(引擎的缺省上限是 auto-edit,宁可少给)。
 */
export function approvalModeSelectable(mode: string, cap: ApprovalCap | null): boolean {
  if (mode !== 'readonly' && mode !== 'auto-edit' && mode !== 'full-auto') return false
  return RANK[mode] <= RANK[cap ?? 'readonly']
}

/**
 * 委托管理员编辑器里的审批档下拉:只列不超过上限的三档(不给「跟随会话」—— 引擎把远端的空值落成上限本身,不是空)。
 * 存值为空 → 选中态显示成上限那一档(只是显示,不写回;下拉只在用户真的换档时 onChange)。
 * 存值 custom → 照列这一项且只读(引擎对远端既不收也不改写 custom)。
 */
export function delegatedApprovalField<O extends { value: string }>(stored: string | undefined, cap: ApprovalCap | null, options: O[]): { value: string; options: O[]; disabled: boolean } {
  const shown = stored || cap || 'readonly'
  return {
    value: shown,
    options: options.filter((o) => (stored === 'custom' && o.value === 'custom') || approvalModeSelectable(o.value, cap) || (o.value === shown && o.value !== '')),
    disabled: stored === 'custom',
  }
}

/** 这个角色下设置里只留的页(其余页的数据面全在白名单外)。 */
export const DELEGATED_SETTINGS_TABS = ['agents', 'skills'] as const
