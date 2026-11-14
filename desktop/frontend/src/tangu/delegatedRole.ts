/**
 * Tangu 界面这一侧的委托管理员(Unit 网页经云端中转进来、只管 Agent 的那种来路)。
 *
 * 角色经宿主桥 window.tangu 读:宿主(web/src/unitShim.ts)只在这个角色下设 `delegatedAdmin`,判定与宿主
 * services/delegatedAdmin.ts 的 isDelegatedAdmin() 同一条(unitPage 与 delegatedAdmin 两键都在),
 * services/delegatedAdmin.test.ts 逐格对过两边一致。审批档上限经 app store 的 delegatedApprovalCap 读(宿主镜像进去)。
 * 不直接 import 宿主模块:Tangu 界面包能单独热更新,包里每多一个宿主依赖,就要求宿主同版本带着它
 * (scripts/tangu-boundary.check.cjs 的接缝面只许减)。老宿主没有这些键 → 恒 false / null,行为不变。
 */
import { registerMessages } from '../i18n'

registerMessages({
  'delegatedAdmin.role': { zh: '管理员', en: 'Admin' },
  'delegatedAdmin.signedInAs': { zh: '管理员 · {name}', en: 'Admin · {name}' },
  'delegatedAdmin.approvalCapHint': {
    zh: '远程管理时审批最高到「{mode}」，更宽的档只能在那台设备上设置',
    en: 'Remote admins can set approval up to “{mode}”. Wider modes can only be set on that device',
  },
})

export type ApprovalCap = 'readonly' | 'auto-edit' | 'full-auto'
const RANK: Record<ApprovalCap, number> = { readonly: 0, 'auto-edit': 1, 'full-auto': 2 }

/** 当前页面是不是委托管理员。 */
export function tanguDelegatedAdmin(): boolean {
  if (typeof window === 'undefined') return false
  const t = window.tangu
  return !!t?.unitPage && !!t.delegatedAdmin
}

/** 操作者的显示名(hub 签发的声明里带的,只作界面显示)。 */
export function tanguDelegatedAdminName(): string {
  return (tanguDelegatedAdmin() && window.tangu?.delegatedAdmin?.name) || ''
}

/**
 * 审批档选项在这个角色下能不能选:只收三档,且不超过上限。'' (跟随会话)与 'custom' 远端写不进去(引擎不收),一律不可选。
 * 上限没读到时只放 readonly(引擎的缺省上限是 auto-edit,宁可少给)。
 */
export function approvalModeSelectable(mode: string, cap: ApprovalCap | null | undefined): boolean {
  if (mode !== 'readonly' && mode !== 'auto-edit' && mode !== 'full-auto') return false
  return RANK[mode] <= RANK[cap ?? 'readonly']
}

/**
 * 委托管理员编辑器里的审批档下拉:可选项严格按上限过滤(不给「跟随会话」—— 引擎把远端的空值落成上限本身,不是空)。
 * 存值为空 → 选中态显示成上限那一档(只是显示,不写回;下拉只在用户真的换档时 onChange)。
 * 当前值超出上限(上限没读到 / 后来降了)或是 custom → 照列这一项但 disabled(只作展示,选不回去);custom 时整个字段只读。
 */
export function delegatedApprovalField<O extends { value: string }>(stored: string | undefined, cap: ApprovalCap | null | undefined, options: O[]): { value: string; options: Array<O & { disabled?: boolean }>; disabled: boolean } {
  const shown = stored || cap || 'readonly'
  return {
    value: shown,
    options: options.flatMap((o) => approvalModeSelectable(o.value, cap) ? [o]
      : o.value === shown && o.value !== '' ? [{ ...o, disabled: true }] : []),
    disabled: stored === 'custom',
  }
}
