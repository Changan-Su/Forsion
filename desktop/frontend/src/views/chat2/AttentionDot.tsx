/**
 * 会话行「等你处理」点(设备能力 MCP 方案 P1 · K3):有审批 / 询问在等人。优先级高于「运行中」「未读」(SidebarPane)。
 * 沿用 .t2s-dot 的尺寸与贴角定位(sidebar2.css),只换警示色;K7 的跨设备分组行经 rowBadge 复用同一个组件。
 */
import React from 'react'
import { registerMessages, useI18n } from '../../i18n'

registerMessages({
  'sidebar.attention': { zh: '{n} 项等你处理', en: '{n} waiting for you' },
  'sidebar.attentionLocalOnly': { zh: '{n} 项等你处理 · 含只能在那台电脑上批准的操作', en: '{n} waiting for you · includes actions that can only be approved on that computer' },
})

export const AttentionDot: React.FC<{ n: number; localOnly?: boolean }> = ({ n, localOnly }) => {
  const { t } = useI18n()
  return <span className="t2s-dot attention" data-attention={n} title={t(localOnly ? 'sidebar.attentionLocalOnly' : 'sidebar.attention', { n })} />
}
