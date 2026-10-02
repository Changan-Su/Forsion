import React, { useState } from 'react'
import { ImageIcon, Play, RotateCcw, Upload, X } from 'lucide-react'
import { useI18n } from '../i18n'
import { useAppearance, updateAppearance, readAppearanceFile, prepareAppearanceImage } from '../appearance/store'
import { ANIMATIONS, DEFAULT_APPEARANCE, type AppearancePatch, type AppearanceAsset } from '../../../shared/startupAppearance'
import { BrandLogo } from './BrandLogo'
import startupHtml from '../../index.html?raw'
import startupRuntime from '../../startupAppearance.js?raw'
import './startupAppearance.css'
import './startupAppearanceCopy'



export const StartupAppearanceSettings: React.FC = () => {
  const { t, locale } = useI18n()
  const { value, presets } = useAppearance()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(false)
    try { await work() } catch { setError(true) } finally { setBusy(false) }
  }
  const save = (patch: AppearancePatch): void => { void run(() => updateAppearance(patch)) }
  const label = (asset: AppearanceAsset): string => asset.id === 'upload' ? t('startupAppearance.uploaded') : locale === 'en' ? asset.labelEn || asset.label : asset.label
  const select = (slot: 'icon' | 'splash', key: string): void => {
    if (!key) { save({ [slot]: null }); return }
    const preset = presets.find((p) => p.key === key)
    if (!preset?.[slot]) return
    void run(async () => {
      const image = await prepareAppearanceImage(preset[slot]!, slot === 'icon')
      const poster = slot === 'splash' ? await prepareAppearanceImage(image, true) : undefined
      // A disabled/reloaded plugin must not finish an old asynchronous selection.
      if (!useAppearance.getState().presets.some((p) => p.token === preset.token)) return
      await updateAppearance({ [slot]: { id: preset.key, label: preset.label, labelEn: preset.labelEn, pluginId: preset.pluginId, image, poster } })
    })
  }
  const showPreview = (): void => {
    // The actual startup HTML and runtime, isolated from the host and all app modules.
    const html = startupHtml.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace('<html', `<html data-mode="${document.documentElement.dataset.mode === 'dark' ? 'dark' : 'light'}"`)
      .replace('<!-- forsion-startup-runtime -->', `<script>window.tangu={startupAppearance:{initial:${JSON.stringify({ ...value, showSplash: true }).replace(/</g, '\\u003c')}}};</script><script>${startupRuntime}</script><script>setTimeout(function(){document.getElementById('root').textContent=' ';},2400);</script>`)
    setPreview(html)
  }
  return <section className="settings-panel startup-appearance" data-setting-anchor="startup-appearance">
    <div className="settings-panel-head"><ImageIcon size={18} /><div><strong>{t('startupAppearance.title')}</strong><p>{t('startupAppearance.description')}</p></div></div>
    <div className="startup-appearance-current"><BrandLogo size={64} /><p className="hint">{t('startupAppearance.behavior')}</p></div>
    <fieldset disabled={busy} className="startup-appearance-fields">
      {(['icon', 'splash'] as const).map((slot) => <div className="startup-appearance-row" key={slot}>
        <label htmlFor={`startup-${slot}`}>{t(`startupAppearance.${slot}`)}</label>
        <select id={`startup-${slot}`} value={value[slot]?.id || ''} onChange={(e) => select(slot, e.target.value)}>
          <option value="">{t('startupAppearance.default')}</option>
          {value[slot] && !presets.some((p) => p.key === value[slot]!.id && p[slot]) && <option value={value[slot]!.id}>{label(value[slot]!)}</option>}
          {presets.some((p) => p[slot]) && <optgroup label={t('startupAppearance.plugins')}>{presets.filter((p) => p[slot]).map((p) => <option key={p.key} value={p.key}>{locale === 'en' ? p.labelEn || p.label : p.label}</option>)}</optgroup>}
        </select>
        <label className="btn ghost sm startup-appearance-upload"><Upload size={14} />{t('startupAppearance.upload')}
          <input aria-label={`${t('startupAppearance.upload')} · ${t(`startupAppearance.${slot}`)}`} type="file" accept="image/png,image/jpeg,image/svg+xml,image/gif,image/webp" onChange={(e) => {
            const file = e.target.files?.[0]; e.target.value = ''
            if (file) void run(async () => {
              const image = await readAppearanceFile(file, slot === 'icon')
              const poster = slot === 'splash' ? await prepareAppearanceImage(image, true) : undefined
              await updateAppearance({ [slot]: { id: 'upload', label: file.name.slice(0, 160) || 'Image', image, poster } })
            })
          }} />
        </label>
      </div>)}
      <div className="startup-appearance-row"><label htmlFor="startup-motion">{t('startupAppearance.motion')}</label><select id="startup-motion" value={value.animation} onChange={(e) => save({ animation: e.target.value as typeof value.animation })}>{ANIMATIONS.map((id) => <option key={id} value={id}>{t(`startupAppearance.motion.${id}`)}</option>)}</select></div>
      <label className="startup-appearance-toggle"><input type="checkbox" checked={value.showSplash} onChange={(e) => save({ showSplash: e.target.checked })} />{t('startupAppearance.show')}</label>
      {window.tangu?.startupAppearance && <><label className="startup-appearance-toggle"><input type="checkbox" checked={value.nativeIcon} onChange={(e) => save({ nativeIcon: e.target.checked })} />{t('startupAppearance.native')}</label><p className="hint">{t('startupAppearance.nativeHint')}</p></>}
      <p className="hint">{t('startupAppearance.hint')}</p>
      {!presets.length && <p className="hint">{t('startupAppearance.empty')}</p>}
      <div className="startup-appearance-actions"><button type="button" className="btn sm" onClick={showPreview}><Play size={14} />{t('startupAppearance.preview')}</button><button type="button" className="btn ghost sm" onClick={() => save(DEFAULT_APPEARANCE)}><RotateCcw size={14} />{t('startupAppearance.reset')}</button></div>
    </fieldset>
    {error && <p role="alert" className="startup-appearance-error">{t('startupAppearance.error')}</p>}
    {preview && <dialog ref={(el) => { if (el && !el.open) el.showModal() }} className="startup-appearance-preview" aria-label={t('startupAppearance.preview')} onCancel={(e) => { e.preventDefault(); setPreview(null) }} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setPreview(null) } }}><button autoFocus type="button" className="btn ghost sm" onClick={() => setPreview(null)}><X size={14} />{t('startupAppearance.close')}</button><iframe title={t('startupAppearance.preview')} sandbox="allow-scripts" srcDoc={preview} /></dialog>}
  </section>
}
