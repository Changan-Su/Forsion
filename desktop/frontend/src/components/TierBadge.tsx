/** 会员等级徽章:配色由后台按方案配置(tierBadgeStyles),free 不显示。 */
import React from 'react'
import { useTierBadge } from './tierBadgeStyles'

const Badge: React.FC<{ tier: string }> = ({ tier }) => {
  const b = useTierBadge(tier)
  return <span className="tier-badge" style={{ background: `linear-gradient(135deg, ${b.from}, ${b.to})`, color: b.text, border: 'none' }}>{tier}</span>
}

export const TierBadge: React.FC<{ tier?: string | null }> = ({ tier }) => {
  const t = (tier || 'free').toLowerCase()
  if (t === 'free') return null // free 不显示徽章(对齐 AI Studio)
  return <Badge tier={t} />
}
