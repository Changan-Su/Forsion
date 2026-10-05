import { useState } from 'react'
import { Palette } from 'lucide-react'
import { label, useSpaceStore } from '@lcl/engine'
import { registerMessages, useI18n } from '../i18n'
import { forcedSchemeForLanguage, hasLanguage, listLanguages, listSkins } from '../theme/registry'
import { useTheme } from '../stores/themeStore'
import { setSpaceAppearance, useSpaceAppearance } from '../stores/spaceAppearanceStore'
import type { SpaceAppearance } from '../../../shared/spaceAppearance'
import { SettingsPanel, SettingsRow } from './SettingsPrimitives'

registerMessages({
  'spaceAppearance.title': { zh: 'Space 外观', en: 'Space appearance' },
  'spaceAppearance.description': { zh: '为每个 Space 设置主题与颜色。未设置的项目实时跟随全局外观。', en: 'Choose a theme and colors for each Space. Unset options follow global appearance as it changes.' },
  'spaceAppearance.space': { zh: '选择 Space', en: 'Choose Space' },
  'spaceAppearance.inherit': { zh: '跟随全局', en: 'Follow global' },
  'spaceAppearance.language': { zh: '设计语言', en: 'Design language' },
  'spaceAppearance.accent': { zh: '主题色', en: 'Accent color' },
  'spaceAppearance.background': { zh: '背景色', en: 'Background color' },
  'spaceAppearance.mode': { zh: '明暗模式', en: 'Color mode' },
  'spaceAppearance.light': { zh: '浅色', en: 'Light' },
  'spaceAppearance.dark': { zh: '深色', en: 'Dark' },
  'spaceAppearance.system': { zh: '跟随系统', en: 'Follow system' },
  'spaceAppearance.reset': { zh: '恢复全局外观', en: 'Reset to global appearance' },
  'spaceAppearance.error': { zh: '无法保存外观，请重试。', en: 'Could not save appearance. Try again.' },
  'spaceAppearance.missing': { zh: '主题暂不可用，当前跟随全局', en: 'Theme unavailable; following global appearance' },
})

export function SpaceAppearancePanel() {
  const { t, locale } = useI18n()
  const spaces = useSpaceStore((s) => s.spaces)
  const active = useSpaceStore((s) => s.activeSpaceId)
  const [selected, select] = useState(active)
  const id = spaces.some((sp) => sp.id === selected) ? selected : spaces[0]?.id
  const byId = useSpaceAppearance((s) => s.byId)
  const global = useTheme()
  const [error, setError] = useState(false)
  if (!id) return null
  const appearance = byId[id] ?? {}
  const update = (patch: Partial<SpaceAppearance>): void => { setError(!setSpaceAppearance(id, { ...appearance, ...patch })) }
  const forced = forcedSchemeForLanguage(appearance.lang && hasLanguage(appearance.lang) ? appearance.lang : global.lang)
  const languages = listLanguages()
  const skins = listSkins()
  return <SettingsPanel icon={<Palette size={16} />} title={t('spaceAppearance.title')} description={t('spaceAppearance.description')}>
    <SettingsRow label={t('spaceAppearance.space')} control={<select aria-label={t('spaceAppearance.space')} value={id} onChange={(e) => { select(e.target.value); setError(false) }}>
      {spaces.map((sp) => <option value={sp.id} key={sp.id}>{label(sp.name)}</option>)}
    </select>} />
    <SettingsRow label={t('spaceAppearance.language')} control={<select aria-label={t('spaceAppearance.language')} value={appearance.lang ?? ''} onChange={(e) => update({ lang: e.target.value || undefined })}>
      <option value="">{t('spaceAppearance.inherit')}</option>
      {appearance.lang && !languages.some((entry) => entry.manifest.id === appearance.lang) && <option value={appearance.lang}>{t('spaceAppearance.missing')}</option>}
      {languages.map(({ manifest: m }) => <option key={m.id} value={m.id}>{locale === 'en' ? (m.nameEn || m.name) : m.name}</option>)}
    </select>} />
    {(['skin', 'bg'] as const).map((axis) => {
      const key = axis === 'skin' ? 'spaceAppearance.accent' : 'spaceAppearance.background'
      const seedKey = axis === 'skin' ? 'seed' : 'bgSeed'
      return <SettingsRow key={axis} label={t(key)} control={<div className="space-appearance-color">
        <select aria-label={t(key)} value={appearance[axis] ?? ''} onChange={(e) => update({ [axis]: e.target.value || undefined })}>
          <option value="">{t('spaceAppearance.inherit')}</option>
          {skins.map((skin) => <option key={skin.id} value={skin.id}>{t(`settings.theme.skin.${skin.id}`)}</option>)}
        </select>
        {appearance[axis] === 'custom' && <input type="color" aria-label={t(key)} value={appearance[seedKey] || global[seedKey] || global.seed} onChange={(e) => update({ [seedKey]: e.target.value })} />}
      </div>} />
    })}
    <SettingsRow label={t('spaceAppearance.mode')} description={forced ? t('settings.theme.modeLockedHint') : undefined} control={<select disabled={!!forced} aria-label={t('spaceAppearance.mode')} value={appearance.modePref ?? ''} onChange={(e) => update({ modePref: (e.target.value || undefined) as SpaceAppearance['modePref'] })}>
      <option value="">{t('spaceAppearance.inherit')}</option>
      {(['light', 'dark', 'system'] as const).map((mode) => <option key={mode} value={mode}>{t(`spaceAppearance.${mode}`)}</option>)}
    </select>} />
    <SettingsRow label={t('spaceAppearance.reset')} control={<button className="btn ghost sm" disabled={!Object.keys(appearance).length} onClick={() => setError(!setSpaceAppearance(id, {}))}>{t('spaceAppearance.reset')}</button>} />
    {error && <p role="alert" className="danger-ink">{t('spaceAppearance.error')}</p>}
  </SettingsPanel>
}
