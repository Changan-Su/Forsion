/**
 * ② 外观:风格 / 明暗 / 主题色 / 背景色,右边实时预览(ThemePreview,和设置 › 外观同一个)。即选即生效,后面几屏就是这个样子。
 * 两根颜色轴独立(主题色只换 accent 家族,背景色只换底 / 文字 / 边线族;别退回 2026-08-29 前的耦合写法)。字体留在设置里。
 * 明暗三选一用 LCL 的看法胶囊(ViewModeSwitch spec,滑块会动、跟动效主题走;11-08 换掉手写的 .ob3-seg)。
 * variant 'phone'(手机引导,11-13):没有风格那一栏和右边的预览 —— 窄屏上它们会把明暗 / 颜色挤到下面去;改了马上就能在整个 App 上看到,
 * 不需要另画一个小预览。窄栏一列。设置 › 外观不用这个组件,不受影响。
 */
import React from 'react'
import { Moon, MonitorCog, Sun } from 'lucide-react'
import { ViewModeSwitch } from '@lcl/components'
import { useI18n } from '../../i18n'
import { listLanguages, listSkins, skinSwatch, backgroundSwatch, forcedSchemeForLanguage } from '../../theme/registry'
import { useTheme } from '../../stores/themeStore'
import { ThemePreview } from '../ThemePreview'

export interface ThemeProps {
  themeLang: string; themeSkin: string; themeMode: 'light' | 'dark'; themeModePref: 'light' | 'dark' | 'system'; themeSeed: string
  onThemeChange: (lang: string, skin: string, pref: 'light' | 'dark' | 'system') => void
  onSeedChange: (hex: string) => void
  /** 手机引导用的那版:不出风格、不出预览,窄栏。 */
  variant?: 'phone'
}

export function ThemeScreen(p: ThemeProps): React.ReactNode {
  const { t, locale } = useI18n()
  const themeBg = useTheme((s) => s.bg)
  const setBg = useTheme((s) => s.setBg)
  const bgSeed = useTheme((s) => s.bgSeed)
  const setBgSeed = useTheme((s) => s.setBgSeedValue)
  const dark = p.themeMode === 'dark'
  const forced = forcedSchemeForLanguage(p.themeLang)
  const mode = forced ?? p.themeModePref
  const skins = listSkins()
  const phone = p.variant === 'phone'
  return <div className={`ob3-col ${phone ? 'narrow' : 'mid'}`}>
    <div className="ob3-head"><h1 tabIndex={-1} data-ob-title="">{t('ob3.theme.title')}</h1><p>{t(phone ? 'ob3.theme.descPhone' : 'ob3.theme.desc')}</p></div>
    <div className={`ob3-theme${phone ? ' phone' : ''}`}>
      <section className="ob3-card ob3-ctrl">
        {!phone && <div className="ob3-field"><span>{t('ob3.theme.style')}</span>
          <div className="ob3-styles" role="radiogroup" aria-label={t('ob3.theme.style')}>
            {listLanguages().map((th) => {
              const on = th.manifest.id === p.themeLang
              const desc = locale === 'en' ? th.manifest.descriptionEn || th.manifest.description : th.manifest.description
              return <button key={th.manifest.id} type="button" role="radio" aria-checked={on} className={`ob3-card ob3-style${on ? ' pick' : ''}`} title={desc || undefined}
                onClick={() => p.onThemeChange(th.manifest.id, p.themeSkin, p.themeModePref)}>
                <strong>{th.manifest.name}</strong>{desc && <small>{desc}</small>}
              </button>
            })}
          </div></div>}
        <div className="ob3-field"><span>{t('onboarding.theme.modeLabel')}</span>
          <div className={`ob3-mode${forced ? ' locked' : ''}`} data-ob-mode="" title={forced ? t('settings.theme.modeLocked') : undefined}>
            {/* 锁住时整颗 inert:点不到、Tab 不进、读屏器也不当成能用的控件(下面那行说明照读) */}
            <div inert={!!forced}><ViewModeSwitch spec={{
              value: mode, ariaLabel: t('onboarding.theme.modeLabel'),
              modes: [{ value: 'light', label: t('onboarding.theme.light'), icon: Sun }, { value: 'dark', label: t('onboarding.theme.dark'), icon: Moon },
                { value: 'system', label: t('settings.theme.system'), icon: MonitorCog }],
              onChange: (v) => { if (!forced) p.onThemeChange(p.themeLang, p.themeSkin, v as 'light' | 'dark' | 'system') },
            }} /></div>
            {forced && <small className="ob3-note">{t('settings.theme.modeLockedHint')}</small>}
          </div></div>
        <div className="ob3-field"><span>{t('settings.theme.accentLabel')}</span>
          <div className="ob3-sw" role="radiogroup" aria-label={t('settings.theme.accentLabel')}>
            {skins.map((sk) => <button key={sk.id} type="button" role="radio" aria-checked={sk.id === p.themeSkin} className={sk.id === p.themeSkin ? 'on' : ''}
              onClick={() => p.onThemeChange(p.themeLang, sk.id, p.themeModePref)}>
              <i style={{ background: sk.id === 'custom' ? p.themeSeed : skinSwatch(sk, dark, 'accent') }} />{t(`settings.theme.skin.${sk.id}`)}</button>)}
            {p.themeSkin === 'custom' && <input type="color" value={p.themeSeed} aria-label={t('onboarding.theme.customSeedLabel')} onChange={(e) => p.onSeedChange(e.target.value)} />}
          </div></div>
        <div className="ob3-field"><span>{t('settings.theme.bgLabel')}</span>
          <div className="ob3-sw" role="radiogroup" aria-label={t('settings.theme.bgLabel')}>
            {skins.map((sk) => <button key={sk.id} type="button" role="radio" aria-checked={sk.id === themeBg} className={sk.id === themeBg ? 'on' : ''} onClick={() => setBg(sk.id)}>
              <i style={{ background: backgroundSwatch(sk, dark, sk.id === 'custom' ? (bgSeed || p.themeSeed) : sk.bgSeed) }} />{t(`settings.theme.skin.${sk.id}`)}</button>)}
            {themeBg === 'custom' && <input type="color" value={bgSeed || '#f8f7f6'} aria-label={t('settings.theme.customBgLabel')} onChange={(e) => setBgSeed(e.target.value)} />}
          </div></div>
      </section>
      {!phone && <section className="ob3-card ob3-preview"><ThemePreview tabLabel={t('ob3.theme.title')} /></section>}
    </div>
  </div>
}
