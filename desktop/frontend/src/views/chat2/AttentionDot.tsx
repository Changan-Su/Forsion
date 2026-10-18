/**
 * 会话行「等你处理」点(设备能力 MCP 方案 P1 · K3):有审批 / 询问在等人。优先级高于「运行中」「未读」(SidebarPane)。
 * 画在行尾(.t2s-st,sidebar2.css);K7 的跨设备分组行经 rowBadge 复用同一个组件。
 */
import React from 'react'
import { registerMessages, useI18n } from '../../i18n'
import type { RowStatus } from './sessionTree'

registerMessages({
  'sidebar.attention': { zh: '{n} 项等你处理', en: '{n} waiting for you' },
  'sidebar.attentionLocalOnly': { zh: '{n} 项等你处理 · 含只能在那台电脑上批准的操作', en: '{n} waiting for you · includes actions that can only be approved on that computer' },
  'sidebar.st.run': { zh: '正在运行', en: 'Running' },
  'sidebar.st.wait': { zh: '在等你回复', en: 'Waiting for your reply' },
  'sidebar.st.done': { zh: '做完了，还没看', en: 'Finished, not viewed yet' },
})

export const AttentionDot: React.FC<{ n: number; localOnly?: boolean }> = ({ n, localOnly }) => {
  const { t } = useI18n()
  return <span className="t2s-st wait" data-attention={n} title={t(localOnly ? 'sidebar.attentionLocalOnly' : 'sidebar.attention', { n })} />
}

/** 会话行尾的状态(10-17 起状态从图标角挪到行尾):在跑 = 转圈;等你 = 警示色点带一圈淡晕;做完了没看 = 主题色淡点;看过了 = 不画。
 *  「等你」有两个来源:审批 / 询问(上面的 AttentionDot,带个数)和模型说它在等用户回答(awaiting_user)。 */
export const StatusMark: React.FC<{ status: RowStatus; title?: string }> = ({ status, title }) => {
  const { t } = useI18n()
  if (!status) return null
  return <span className={`t2s-st ${status}`} title={title || t(`sidebar.st.${status}`)} />
}
