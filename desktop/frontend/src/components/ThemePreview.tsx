/**
 * 「实时外观预览」小舞台(设置→外观 与 首启引导 共用)。整块都是死的假界面 —— 它不模拟任何真状态,
 * 只是让主题 token 落在一组有代表性的表面上(侧栏 / 纸面 / accent 高亮 / 输入区)。
 *
 * 引导里它比设置里更重要:用户还没进过应用,不给这块就是闭着眼选皮肤。
 */
import React from 'react'
import { ArrowUp, Bot, MessageCircle, Palette } from 'lucide-react'
import { useI18n } from '../i18n'
import { BrandLogo } from './BrandLogo'

export const ThemePreview: React.FC<{ /** 右上角那行小字,给个当前所在位置就行。 */ tabLabel?: string }> = ({ tabLabel }) => {
  const { t } = useI18n()
  return (
    <section className="settings-theme-live" aria-label={t('settings.theme.previewLabel')}>
      <div className="settings-theme-live-head">
        <span><i /><i /><i /></span>
        <strong>{t('settings.theme.previewLabel')}</strong>
        <small>{tabLabel}</small>
      </div>
      <div className="settings-theme-live-canvas">
        <div className="settings-theme-live-rail">
          <div className="settings-theme-live-brand"><BrandLogo size={18} /><strong>Forsion</strong></div>
          <div className="settings-theme-live-nav">
            <span><MessageCircle size={12} />{t('settings.theme.previewChat')}</span>
            <span className="active"><Palette size={12} />{t('settings.tab.theme')}</span>
            <span><Bot size={12} />{t('settings.tab.agents')}</span>
          </div>
        </div>
        <div className="settings-theme-live-paper">
          <span className="settings-theme-live-kicker">{t('settings.theme.previewWorkspace')}</span>
          <strong className="settings-theme-live-title">{t('settings.theme.previewTitle')}</strong>
          <div className="settings-theme-live-message">
            <span><Bot size={14} /></span>
            <p>{t('settings.theme.previewMessage')}</p>
          </div>
          <div className="settings-theme-live-composer">
            <span>{t('settings.theme.previewInput')}</span>
            <button type="button" tabIndex={-1}><ArrowUp size={12} /></button>
          </div>
        </div>
      </div>
    </section>
  )
}
