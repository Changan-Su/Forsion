/** 会员等级徽章:配色与中英文名由后台按方案配置(tierBadgeStyles),free 不显示。 */
import React from 'react'
import { useI18n } from '../i18n'
import { badgeLabel, useTierBadge } from './tierBadgeStyles'

const Badge: React.FC<{ tier: string }> = ({ tier }) => {
  const b = useTierBadge(tier)
  const { locale } = useI18n()
  return <span className="tier-badge" style={{ background: `linear-gradient(135deg, ${b.from}, ${b.to})`, color: b.text, border: 'none' }}>{badgeLabel(tier, b, locale)}</span>
}

export const TierBadge: React.FC<{ tier?: string | null }> = ({ tier }) => {
  const t = (tier || 'free').toLowerCase()
  if (t === 'free') return null // free 不显示徽章(对齐 AI Studio)
  return <Badge tier={t} />
}
