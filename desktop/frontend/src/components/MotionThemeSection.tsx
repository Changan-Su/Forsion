/**
 * 设置 → 外观 →「动效主题」一节(动效主题方案 A2,2026-11-06):四张卡(Genesis / 水滴 / 拉伸 / 平移)+ 最后一行「只淡入淡出」。
 * 偏好在 theme/motionTheme.tsx(本机 localStorage,不进设置草稿、不跨设备);别的窗口经 storage 事件跟上,这里订阅同一个源。
 * 卡片是静态示意:上半「按钮 → 面板」、下半分段胶囊的选中块;悬停 / 键盘焦点时在卡里放一遍(styles/motionTheme.css,
 * 减少动态效果 / 只淡入淡出下 forsion-guard 层把关键帧压成 0,不放)。
 * 「只淡入淡出」:系统开了减少动态效果时打开且灰掉,小字说明;不改系统设置。
 */
import React from 'react'
import { Check, Wind, Feather } from 'lucide-react'
import { useI18n } from '../i18n'
import { MOTION_THEME_IDS, setFadeOnly, setMotionTheme, useMotionPrefs, type MotionThemeId } from '../theme/motionTheme'
import { onRadioGroupKeyDown, radioTabIndex } from './radioGroupKeys'
import { SettingsSwitch } from './SettingsPrimitives'
import '../styles/motionTheme.css'

function MotionThemeCard({ id, active, tabIndex, onSelect }: { id: MotionThemeId; active: boolean; tabIndex: number; onSelect: () => void }): React.ReactElement {
  const { t } = useI18n()
  const previewStyle = {
    background: 'var(--glow, none), var(--bg)',
    '--theme-preview-surface': 'var(--bg-card)',
    '--theme-preview-text': 'var(--text)',
  } as React.CSSProperties
  return (
    <button type="button" role="radio" aria-checked={active} tabIndex={tabIndex} className={`theme-card motion-card${active ? ' active' : ''}`} data-motion-card={id} onClick={onSelect}>
      <div className="theme-preview motion-preview" data-motion-preview={id} style={previewStyle} aria-hidden="true">
        <span className="mp-btn" />
        <span className="mp-panel"><i /><i /><i /></span>
        <span className="mp-seg"><span className="mp-thumb" /></span>
      </div>
      <div className="theme-meta">
        <div className="theme-name">{t(`settings.motionTheme.${id}`)}</div>
        <div className="theme-tagline">{t(`settings.motionTheme.${id}Hint`)}</div>
      </div>
      {active && <span className="theme-card-check" aria-hidden="true"><Check size={11} /></span>}
    </button>
  )
}

/** anchor 由 SettingsModal 传字面量(设置搜索的落点测试只认 SettingsModal 里的字面量);最后一行「只淡入淡出」作为 children 传进来。 */
export function MotionThemeSection({ anchor, children }: { anchor: string; children?: React.ReactNode }): React.ReactElement {
  const { t } = useI18n()
  const { theme } = useMotionPrefs()
  return (
    <section className="settings-panel settings-motion-theme" data-setting-anchor={anchor}>
      <div className="settings-panel-head">
        <span className="settings-panel-icon"><Wind size={16} /></span>
        <div><strong>{t('settings.motionTheme.title')}</strong><p>{t('settings.motionTheme.description')}</p></div>
      </div>
      <div className="theme-grid motion-theme-grid" role="radiogroup" aria-label={t('settings.motionTheme.title')} onKeyDown={onRadioGroupKeyDown}>
        {MOTION_THEME_IDS.map((id, i) => (
          <MotionThemeCard key={id} id={id} active={theme === id} tabIndex={radioTabIndex(theme === id, i, true)} onSelect={() => setMotionTheme(id)} />
        ))}
      </div>
      {children}
    </section>
  )
}

/** 「只淡入淡出」:系统开了减少动态效果时打开且灰掉,小字换成说明。 */
export function MotionFadeRow({ anchor }: { anchor: string }): React.ReactElement {
  const { t } = useI18n()
  const { fadeChosen, systemReduce } = useMotionPrefs()
  return (
    <div className="settings-control-row" data-setting-anchor={anchor}>
      <div className="settings-control-copy">
        <Feather size={14} />
        <span>
          <strong>{t('settings.motionTheme.fadeOnly')}</strong>
          <small>{systemReduce ? t('settings.motionTheme.fadeOnlyLocked') : t('settings.motionTheme.fadeOnlyHint')}</small>
        </span>
      </div>
      <SettingsSwitch checked={fadeChosen || systemReduce} disabled={systemReduce} label={t('settings.motionTheme.fadeOnly')} onChange={(next) => setFadeOnly(next)} />
    </div>
  )
}
