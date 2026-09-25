/** 主题选择卡片(preview 数据驱动,机制对齐 AI Studio ThemeCard)。 */
import React from 'react'
import { Check } from 'lucide-react'
import type { ThemeEntry, ThemeManifest } from '../theme/registry'
import { useI18n } from '../i18n'

type PreviewShape = NonNullable<ThemeManifest['preview']['shape']>
type PreviewFont = NonNullable<ThemeManifest['preview']['font']>

const hasTag = (m: ThemeManifest, tag: string): boolean => (m.tags ?? []).some((x) => x.toLowerCase() === tag)

/**
 * 缩略图的结构语言(U-16)。以前缺省一律 'paper' —— 磁盘主题(kami、用户自己改的 soft)的 manifest
 * 大多没写 preview.shape,几张卡画得一模一样。显式 shape 优先,其次看 tags,最后看浮卡信号 panelGap>0
 * (seedThemes 注释里写明的「面板间距 = 浮卡」)。
 */
export function inferShape(m: ThemeManifest): PreviewShape {
  if (m.preview?.shape) return m.preview.shape
  if (hasTag(m, 'glass')) return 'glass'
  if (hasTag(m, 'compact')) return 'compact'
  if (hasTag(m, 'soft') || (m.panelGap ?? 0) > 0) return 'soft'
  return 'paper'
}

/**
 * 缩略图字形:显式 preview.font 优先,否则 tags 含 serif 即衬线,缺省无衬线。
 * ⚠️ 不从 'mono' 推等宽:内置 Genesis 的 tags 'mono' 指的是「单色」配色,不是等宽字体。
 */
export function inferFont(m: ThemeManifest): PreviewFont {
  if (m.preview?.font) return m.preview.font
  if (hasTag(m, 'serif')) return 'serif'
  return 'sans'
}

export const ThemeCard: React.FC<{
  entry: ThemeEntry
  active: boolean
  onSelect: () => void
}> = ({ entry, active, onSelect }) => {
  const { preview } = entry.manifest
  const { locale } = useI18n()
  const shape = inferShape(entry.manifest)
  const font = inferFont(entry.manifest)
  // 语言卡只预览结构，颜色完整取当前 skin。旧实现读 manifest 的硬编码色板，导致切到珊瑚后
  // “知/Soft/Glass”卡片仍各画各的蓝/紫/灰，用户在设置里看到的就已经不是双轴模型。
  const previewStyle = {
    background: 'var(--glow, none), var(--bg)',
    '--theme-preview-accent': 'var(--accent-ink)',
    '--theme-preview-surface': 'var(--bg-card)',
    '--theme-preview-text': 'var(--text)',
  } as React.CSSProperties
  const name = preview.title?.text || (locale === 'en' && entry.manifest.nameEn ? entry.manifest.nameEn : entry.manifest.name)
  return (
    // 单选语义(U-44):外层 .theme-grid 是 radiogroup;可访问名只取主题名 + 标语,预览里的「F Forsion Aa」不进名字。
    <button type="button" role="radio" aria-checked={active} className={`theme-card${active ? ' active' : ''}`} onClick={onSelect}>
      <div className="theme-preview" data-shape={shape} data-font={font} style={previewStyle} aria-hidden="true">
        <div className="theme-preview-window">
          <span className="theme-preview-rail"><i>F</i><i /><i /></span>
          <span className="theme-preview-sheet"><small>Forsion</small><strong>Aa</strong><i /></span>
        </div>
      </div>
      <div className="theme-meta">
        <div className="theme-name">{name}</div>
        <div className="theme-tagline">{locale === 'en' ? (preview.taglineEn || entry.manifest.descriptionEn || preview.tagline || entry.manifest.description) : (preview.tagline || entry.manifest.description)}</div>
      </div>
      {active && <span className="theme-card-check" aria-hidden="true"><Check size={11} /></span>}
    </button>
  )
}
