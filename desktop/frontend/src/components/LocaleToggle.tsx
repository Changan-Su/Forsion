/**
 * 中/英语言切换(对齐 forsion-ui LocaleToggle 形态):一个分段小开关,点击切换并持久化。
 */
import React from 'react'
import { Languages } from 'lucide-react'
import { useI18n, type Locale } from '../i18n'
import { settingTelemetry } from '../telemetrySend'

export const LocaleToggle: React.FC<{ compact?: boolean }> = ({ compact }) => {
  const { locale, setLocale: apply, t } = useI18n()
  // 用户手选界面语言:真变了才报一次设置改动(匿名遥测;跨窗同步 / IP 校正走 setLocaleGlobal,不经这里)
  const setLocale = (l: Locale): void => { if (l !== locale) settingTelemetry('ui.language', l); apply(l) }
  if (compact) {
    // 紧凑形态:单按钮,点一下在中/英间切换(放侧栏页脚等窄处)。
    return (
      <button
        className="icon-btn"
        title={t('locale.toggleTitle')}
        onClick={() => setLocale(locale === 'zh' ? 'en' : 'zh')}
      >
        <Languages size={15} />
      </button>
    )
  }
  return (
    <div className="seg locale-seg">
      <button className={locale === 'zh' ? 'active' : ''} onClick={() => setLocale('zh')}>
        {t('locale.zh')}
      </button>
      <button className={locale === 'en' ? 'active' : ''} onClick={() => setLocale('en')}>
        {t('locale.en')}
      </button>
    </div>
  )
}
