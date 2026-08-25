/** 主题选择卡片(preview 数据驱动,机制对齐 AI Studio ThemeCard)。 */
import React from 'react'
import { Check } from 'lucide-react'
import type { ThemeEntry } from '../theme/registry'

export const ThemeCard: React.FC<{
  entry: ThemeEntry
  active: boolean
  onSelect: () => void
}> = ({ entry, active, onSelect }) => {
  const { preview } = entry.manifest
  const shape = preview.shape || 'paper'
  // 语言卡只预览结构，颜色完整取当前 skin。旧实现读 manifest 的硬编码色板，导致切到珊瑚后
  // “知/Soft/Glass”卡片仍各画各的蓝/紫/灰，用户在设置里看到的就已经不是双轴模型。
  const previewStyle = {
    background: 'var(--glow, none), var(--bg)',
    '--theme-preview-accent': 'var(--accent-ink)',
    '--theme-preview-surface': 'var(--bg-card)',
    '--theme-preview-text': 'var(--text)',
  } as React.CSSProperties
  return (
    <button className={`theme-card${active ? ' active' : ''}`} onClick={onSelect}>
      <div className="theme-preview" data-shape={shape} style={previewStyle}>
        <div className="theme-preview-window">
          <span className="theme-preview-rail"><i>F</i><i /><i /></span>
          <span className="theme-preview-sheet"><small>Forsion</small><strong>Aa</strong><i /></span>
        </div>
      </div>
      <div className="theme-meta">
        <div className="theme-name">{preview.title?.text || entry.manifest.name}</div>
        <div className="theme-tagline">{preview.tagline || entry.manifest.description}</div>
      </div>
      {active && <span className="theme-card-check" aria-hidden="true"><Check size={11} /></span>}
    </button>
  )
}
