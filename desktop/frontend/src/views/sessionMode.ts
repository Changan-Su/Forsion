/**
 * 侧栏 Chat / Work 模式(用户 09-07 拍板:新对话行右侧的胶囊切换;两种模式的会话列表分开——
 * Chat 会话全部住在「不在项目中工作」这一个无根项目里;Work 模式列出全部项目(含无根组),Chat 模式只列它)。
 * 这里只放纯函数;状态与持久化在 appStore(sessionMode / setSessionMode)。
 */
import type { WorkspaceDescriptor } from '../types'

export type SessionMode = 'chat' | 'work'

/** null = 用户没手选过 → 全端默认 Work；显式选择仍持久并优先。保留 platform 参数以维持调用契约。 */
export function effectiveSessionMode(mode: SessionMode | null | undefined, _platform: 'desktop' | 'web' | 'mobile'): SessionMode {
  return mode ?? 'work'
}

/** chat 模式只看无根会话(chat 会话都住那,**不分本地/云端侧**;存量的无根 work 会话也在,打开即锁定的 work 会话,如实);
 *  work 模式全部——桌面左栏还有一层本地/云端侧过滤(inSide),叠加时无根会话恒在(用户拍板:Work 模式显示无根项目)。 */
export function sessionsInMode<T extends { projectless?: boolean }>(list: T[], mode: SessionMode, inSide?: (x: T) => boolean): T[] {
  if (mode === 'chat') return list.filter((x) => !!x.projectless)
  return inSide ? list.filter((x) => !!x.projectless || inSide(x)) : list
}

/** chat 模式只剩无根组(平铺渲染);work 模式全部工作区(含无根组),叠加侧过滤时无根组恒在。 */
export function workspacesInMode(list: WorkspaceDescriptor[], mode: SessionMode, sideKeep?: (w: WorkspaceDescriptor) => boolean): WorkspaceDescriptor[] {
  if (mode === 'chat') return list.filter((w) => w.kind === 'rootless')
  return sideKeep ? list.filter((w) => w.kind === 'rootless' || sideKeep(w)) : list
}
