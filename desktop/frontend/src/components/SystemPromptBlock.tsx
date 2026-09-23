/** 可折叠 system prompt 块(开发者「显示 system prompt」开启时,AI 回复前显示本条消息的完整系统提示)。
 *  复用 .thinking-block 外观;正文用等宽 + pre-wrap + 限高滚动,便于检查内容与结构。 */
import React, { useState } from 'react'
import { ChevronRight, ChevronDown, ScrollText } from 'lucide-react'
import { AnimatedCollapse } from './AnimatedUI'
import { useI18n } from '../i18n'

export const SystemPromptBlock: React.FC<{ content: string }> = ({ content }) => {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  if (!content) return null
  return (
    <div className="thinking-block">
      <button className="thinking-toggle" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <ScrollText size={12} />
        {t('chat.systemPrompt')}
        <span style={{ opacity: 0.7 }}>{t('thinking.charCount', { count: content.length })}</span>
      </button>
      <AnimatedCollapse open={open}>
        <pre
          className="thinking-content"
          style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 360, overflow: 'auto', fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 'var(--ui-font-meta, 12px)', margin: 0 }}
        >
          {content}
        </pre>
      </AnimatedCollapse>
    </div>
  )
}
