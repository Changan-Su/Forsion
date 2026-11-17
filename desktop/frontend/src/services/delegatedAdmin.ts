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
  'delegatedAdmin.agentsDescription': { zh: '管理这台设备上的 Agent 名册。', en: 'Manage the agent roster on this device.' },
  'delegatedAdmin.skillsReadOnly': {
    zh: '远程管理时这里只能查看。要给某个 Agent 启用或停用技能，请到该 Agent 的「技能」页',
    en: 'Remote admins can only view this list. To turn a skill on or off for an agent, use that agent’s Skills tab',
  },
})

export type ApprovalCap = 'readonly' | 'auto-edit' | 'full-auto'

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

/** 那台设备给远端定的审批档上限(引擎在委托管理员的 Agent 名册回包里带 approvalCap)。没读到 = null(编辑器按最严的理解)。
 *  stores/appStore 把它镜像成 delegatedApprovalCap 给 Tangu 界面读;下拉的过滤规则在 tangu/delegatedRole.ts。 */
export const useDelegatedApprovalCap = create<{ cap: ApprovalCap | null }>(() => ({ cap: null }))

/** Agent 名册回包到手时记下上限;只在这个角色下记(别的来路回包里本来就没有这个字段)。 */
export function noteApprovalCap(value: unknown): void {
  if (!isDelegatedAdmin()) return
  if (value === 'readonly' || value === 'auto-edit' || value === 'full-auto') {
    if (useDelegatedApprovalCap.getState().cap !== value) useDelegatedApprovalCap.setState({ cap: value })
  }
}

/** 这个角色下设置里只留的页(其余页的数据面全在白名单外)。 */
export const DELEGATED_SETTINGS_TABS = ['agents', 'skills'] as const
