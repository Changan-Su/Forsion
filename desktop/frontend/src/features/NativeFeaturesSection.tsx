import { PRODUCT } from '../product'
import { registerMessages, useI18n } from '../i18n'
import { PluginLogo } from '../components/PluginLogo'

registerMessages({
  'features.unitTitle': { zh: 'Unit 已安装功能', en: 'Features installed on this Unit' },
  'features.unitHint': { zh: '由已安装的插件提供，在 Unit 部署配置中管理。', en: 'Provided by installed plugins and managed in this Unit’s deployment configuration.' },
})

/** The package owns activation; this surface deliberately exposes no local toggle. */
export function NativeFeaturesSection() {
  const { t } = useI18n()
  const features = PRODUCT.nativeFeatures ?? []
  if (!features.length) return null
  return <>
    <div className="settings-sec">{t('features.unitTitle')}</div>
    <div className="hint">{t('features.unitHint')}</div>
    {features.map((feature) => <div className="plugin-card" key={feature}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <PluginLogo />
        <b style={{ fontSize: 13 }}>{t(`space.${feature}`)}</b>
      </div>
    </div>)}
  </>
}
