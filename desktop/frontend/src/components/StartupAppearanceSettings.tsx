import React, { useState } from 'react'
import { ChevronRight, ImageIcon, Play, RotateCcw, Upload, X } from 'lucide-react'
import { useI18n } from '../i18n'
import { useAppearance, updateAppearance, prepareAppearanceImage } from '../appearance/store'
import { APPEARANCE_ACCEPT, AppearanceImportError, importAppearanceFile, type ImportedAppearance } from '../appearance/imageImport'
import { BUILTIN_APPEARANCES } from '../appearance/builtins'
import { ANIMATIONS, DEFAULT_APPEARANCE, type AppearancePatch, type AppearanceAsset } from '../../../shared/startupAppearance'
import { BrandLogo } from './BrandLogo'
import { SettingsPanel, SettingsRow, SettingsSwitch } from './SettingsPrimitives'
import { AppearanceImportDialog } from './AppearanceImportDialog'
import startupHtml from '../../index.html?raw'
import startupRuntime from '../../startupAppearance.js?raw'
import { APP_VERSION } from '../changelog'
import './startupAppearance.css'
import './startupAppearanceCopy'

/** Picker value of the original animated tree mark; asset ids never collide with it (`upload`, `builtin:*`, `plugin:*`). */
const CLASSIC = 'classic'

export const StartupAppearanceSettings: React.FC = () => {
  const { t, locale } = useI18n()
  const { value, presets } = useAppearance()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [importing, setImporting] = useState<{ image: ImportedAppearance; slot: 'icon' | 'splash' } | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  // Where the icon also lives outside the app: the desktop system (Dock / taskbar), or the Android home screen.
  const system = window.tangu?.startupAppearance ? 'native' : window.tangu?.launcherIcon ? 'launcher' : null
  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(null)
    try { await work() } catch (e) { setError(e instanceof AppearanceImportError ? `startupAppearance.error.${e.reason}` : 'startupAppearance.error.save') } finally { setBusy(false) }
  }
  const save = (patch: AppearancePatch): void => { void run(() => updateAppearance(patch)) }
  const label = (asset: AppearanceAsset): string => asset.id === 'upload' ? t('startupAppearance.uploaded') : locale === 'en' ? asset.labelEn || asset.label : asset.label
  const select = (slot: 'icon' | 'splash', key: string): void => {
    // The two built-in scenes carry no image: they are what shows while no artwork is selected.
    if (slot === 'splash' && (!key || key === CLASSIC)) { save({ splash: null, scene: key ? 'classic' : 'treeShadow' }); return }
    if (!key) { save({ [slot]: null }); return }
    const builtin = BUILTIN_APPEARANCES.find((p) => p.key === key)
    if (builtin?.[slot]) {
      save({ [slot]: { id: builtin.key, label: builtin.label, labelEn: builtin.labelEn, image: builtin[slot]!, ...(slot === 'splash' ? { poster: builtin.icon } : {}) } })
      return
    }
    const preset = presets.find((p) => p.key === key)
    if (!preset?.[slot]) return
    void run(async () => {
      const image = await prepareAppearanceImage(preset[slot]!, slot === 'icon')
      const poster = slot === 'splash' ? await prepareAppearanceImage(image, true, false) : undefined
      // A disabled/reloaded plugin must not finish an old asynchronous selection.
      if (!useAppearance.getState().presets.some((p) => p.token === preset.token)) return
      await updateAppearance({ [slot]: { id: preset.key, label: preset.label, labelEn: preset.labelEn, pluginId: preset.pluginId, image, poster } })
    })
  }
  const showPreview = (): void => {
    // The actual startup HTML and runtime, isolated from the host and all app modules.
    // Function replacer: an uploaded file name is part of the config, and `$'` in a replacement string expands to page HTML.
    const html = startupHtml.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace('<html', `<html data-mode="${document.documentElement.dataset.mode === 'dark' ? 'dark' : 'light'}"`)
      .replace('<!-- forsion-startup-runtime -->', () => `<script>window.FORSION_APP_VERSION=${JSON.stringify(APP_VERSION)};window.tangu={startupAppearance:{prefersReducedMotion:${window.tangu?.startupAppearance?.prefersReducedMotion === true},softwareRendering:${window.tangu?.startupAppearance?.softwareRendering === true},initial:${JSON.stringify({ ...value, showSplash: true }).replace(/</g, '\\u003c')}}};</script><script>${startupRuntime}</script><script>setTimeout(function(){document.getElementById('root').textContent=' ';},2400);</script>`)
    setPreview(html)
  }
  const artworkControl = (slot: 'icon' | 'splash'): React.ReactNode => (
    <div className="startup-appearance-picker">
      <select id={`startup-${slot}`} value={value[slot]?.id || (slot === 'splash' && value.scene === 'classic' ? CLASSIC : '')} onChange={(e) => select(slot, e.target.value)}>
        <option value="">{t(slot === 'splash' ? 'startupAppearance.scene.treeShadow' : 'startupAppearance.default')}</option>
        {value[slot] && ![...BUILTIN_APPEARANCES, ...presets].some((p) => p.key === value[slot]!.id && p[slot]) && <option value={value[slot]!.id}>{label(value[slot]!)}</option>}
        <optgroup label={t('startupAppearance.builtins')}>{slot === 'splash' && <option value={CLASSIC}>{t('startupAppearance.scene.classic')}</option>}{BUILTIN_APPEARANCES.filter((p) => p[slot]).map((p) => <option key={p.key} value={p.key}>{locale === 'en' ? p.labelEn || p.label : p.label}</option>)}</optgroup>
        {presets.some((p) => p[slot]) && <optgroup label={t('startupAppearance.plugins')}>{presets.filter((p) => p[slot]).map((p) => <option key={p.key} value={p.key}>{locale === 'en' ? p.labelEn || p.label : p.label}</option>)}</optgroup>}
      </select>
      <label className="btn ghost sm startup-appearance-upload" title={t('startupAppearance.upload')}>
        <Upload size={14} aria-hidden="true" />
        <input aria-label={`${t('startupAppearance.upload')} · ${t(`startupAppearance.${slot}`)}`} type="file" accept={APPEARANCE_ACCEPT} onChange={(e) => {
          const file = e.target.files?.[0]; e.target.value = ''
          if (file) void run(async () => {
            setImporting({ image: await importAppearanceFile(file), slot })
          })
        }} />
      </label>
    </div>
  )
  return <SettingsPanel
    className="startup-appearance"
    anchor="startup-appearance"
    icon={<ImageIcon size={16} />}
    title={t('startupAppearance.title')}
    description={t('startupAppearance.description')}
    actions={<>
      <button type="button" className="btn ghost sm" disabled={busy} title={t('startupAppearance.preview')} aria-label={t('startupAppearance.preview')} onClick={showPreview}><Play size={14} /></button>
      <button type="button" className="btn ghost sm" disabled={busy} title={t('startupAppearance.reset')} aria-label={t('startupAppearance.reset')} onClick={() => save(DEFAULT_APPEARANCE)}><RotateCcw size={14} /></button>
    </>}
  >
    <fieldset disabled={busy} className="startup-appearance-fields" aria-label={t('startupAppearance.title')}>
      <SettingsRow
        label={<label className="startup-appearance-icon-label" htmlFor="startup-icon"><BrandLogo size={28} />{t('startupAppearance.icon')}</label>}
        control={artworkControl('icon')}
      />
      {system && <SettingsRow
        label={t(`startupAppearance.${system}`)}
        description={t(`startupAppearance.${system}Scope`)}
        className="startup-appearance-switch-row"
        control={<SettingsSwitch checked={value.nativeIcon} onChange={(nativeIcon) => save({ nativeIcon })} label={t(`startupAppearance.${system}`)} />}
      />}
      <SettingsRow
        label={t('startupAppearance.show')}
        className="startup-appearance-switch-row"
        control={<SettingsSwitch checked={value.showSplash} onChange={(showSplash) => save({ showSplash })} label={t('startupAppearance.show')} />}
      />
      <SettingsRow label={<label htmlFor="startup-splash">{t('startupAppearance.splash')}</label>} control={artworkControl('splash')} />
      <SettingsRow
        label={<label htmlFor="startup-motion">{t('startupAppearance.motion')}</label>}
        control={<select id="startup-motion" value={value.animation} onChange={(e) => save({ animation: e.target.value as typeof value.animation })}>{ANIMATIONS.map((id) => <option key={id} value={id}>{t(`startupAppearance.motion.${id}`)}</option>)}</select>}
      />
    </fieldset>
    <details className="startup-appearance-help">
      <summary><ChevronRight size={12} aria-hidden="true" />{t('startupAppearance.help')}</summary>
      <div>
        <p>{t('startupAppearance.behavior')}</p>
        <p>{t('startupAppearance.sceneHint')}</p>
        <p>{t('startupAppearance.hint')}</p>
        {system && <p>{t(`startupAppearance.${system}Hint`)}</p>}
        {!presets.length && <p>{t('startupAppearance.empty')}</p>}
      </div>
    </details>
    {error && <p role="alert" className="startup-appearance-error">{t(error)}</p>}
    {importing && <AppearanceImportDialog image={importing.image} slot={importing.slot} onCancel={() => setImporting(null)} onApply={async (asset) => {
      await updateAppearance({ [importing.slot]: asset })
      setImporting(null)
    }} />}
    {/* webhost-ok: 固定已知嵌入(宿主自己的开屏 HTML + 运行时,见 showPreview),只需跑开屏动画;sandbox 仅 allow-scripts,无同源、无宿主 API */}
    {preview && <dialog ref={(el) => { if (el && !el.open) el.showModal() }} className="startup-appearance-preview" aria-label={t('startupAppearance.preview')} onCancel={(e) => { e.preventDefault(); setPreview(null) }} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setPreview(null) } }}><button autoFocus type="button" className="btn ghost sm" onClick={() => setPreview(null)}><X size={14} />{t('startupAppearance.close')}</button><iframe title={t('startupAppearance.preview')} sandbox="allow-scripts" srcDoc={preview} /></dialog>}
  </SettingsPanel>
}
