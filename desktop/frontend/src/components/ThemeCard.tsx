/** 主题选择卡片(preview 数据驱动,机制对齐 AI Studio ThemeCard)。 */
import React from 'react'
import { Check } from 'lucide-react'
import type { ThemeEntry } from '../theme/registry'

export const ThemeCard: React.FC<{
  entry: ThemeEntry
  mode: 'light' | 'dark'
  active: boolean
  onSelect: () => void
}> = ({ entry, mode, active, onSelect }) => {
  const { preview } = entry.manifest
  const bg = typeof preview.background === 'string' ? preview.background : preview.background[mode]
  const swatches = preview.swatches || []
  const previewStyle = {
    background: bg,
    '--theme-preview-accent': swatches[0] || 'var(--accent-ink)',
    '--theme-preview-surface': swatches[1] || 'var(--bg-card)',
    '--theme-preview-text': swatches[2] || 'var(--text)',
  } as React.CSSProperties
  return (
    <button className={`theme-card${active ? ' active' : ''}`} onClick={onSelect}>
      <div className="theme-preview" style={previewStyle}>
        <div className="theme-preview-window">
          <span className="theme-preview-rail"><i>F</i><i /><i /></span>
          <span className="theme-preview-sheet"><small>Forsion</small><strong>Aa</strong><i /></span>
        </div>
      </div>
      <div className="theme-meta">
        <div className="theme-name">{preview.title?.text || entry.manifest.name}</div>
        <div className="theme-tagline">{preview.tagline || entry.manifest.description}</div>
        {preview.swatches?.length ? (
          <div className="theme-swatches">
            {preview.swatches.map((c, i) => (
              <i key={i} style={{ background: c }} />
            ))}
          </div>
        ) : null}
      </div>
      {active && <span className="theme-card-check" aria-hidden="true"><Check size={11} /></span>}
    </button>
  )
}
