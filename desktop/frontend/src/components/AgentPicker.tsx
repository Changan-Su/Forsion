/**
 * 新会话「Agent」选择条 —— 复用 EnginePicker 的 pill bar 形态(同一套 .engine-pill 动画/选中态)。
 * 仅在 Agent 引擎为 Tangu 自有(非外部 ACP 引擎)且无消息的新会话出现;默认选中 Xyra。
 * 有头像显示圆形头像,否则显示名字首字母/首字。
 */
import React from 'react'
import { useI18n } from '../i18n'
import { PillBar } from './EnginePicker'
import { CompactChatPicker } from './CompactChatPicker'
import { DEFAULT_AGENT_SLUG } from '../types'
import type { NormalAgentDef } from '../types'

function firstChar(name: string): string {
  const s = (name || '').trim()
  return s ? Array.from(s)[0].toUpperCase() : '?'
}

export const AgentPicker: React.FC<{
  agents: NormalAgentDef[]
  selectedSlug: string // '' = 用默认
  defaultSlug?: string // 用户选定的默认 agent(selectedSlug 为空时高亮它)
  avatars: Record<string, string> // slug → object URL
  onSelect: (slug: string) => void
}> = ({ agents, selectedSlug, defaultSlug, avatars, onSelect }) => {
  const { t } = useI18n()
  if (!agents.length) return null
  const effective = selectedSlug || defaultSlug || DEFAULT_AGENT_SLUG
  const selected = agents.find((agent) => agent.slug === effective)
  return (
    <div className="engine-picker agent-picker">
      <CompactChatPicker
        label={t('chatPicker.agent')}
        value={effective}
        icon={avatars[effective]
          ? <img className="agent-pill-avatar" src={avatars[effective]} alt="" />
          : <span className="agent-pill-initial">{firstChar(selected?.name || '')}</span>}
        options={agents.map((agent) => ({ value: agent.slug, name: agent.name, description: agent.description }))}
        onChange={onSelect}
      />
      <PillBar label={t('agent.pickTitle')}>
        {agents.map((a) => {
          const selected = a.slug === effective
          const url = avatars[a.slug]
          return (
            <button
              key={a.slug}
              type="button"
              role="radio"
              aria-checked={selected}
              className={`engine-pill${selected ? ' selected' : ''}`}
              title={a.description ? `${a.name} — ${a.description}` : a.name}
              onClick={() => onSelect(a.slug)}
            >
              <span className="engine-pill-icon">
                {url
                  ? <img className="agent-pill-avatar" src={url} alt="" />
                  : <span className="agent-pill-initial">{firstChar(a.name)}</span>}
              </span>
              <span className="engine-pill-label">{a.name}</span>
              {a.createdBy === 'system' && <span className="agent-badge-system">{t('agent.badge.system')}</span>}
            </button>
          )
        })}
      </PillBar>
      <div className="engine-picker-hint">{t('agent.pickTitle')}</div>
    </div>
  )
}
