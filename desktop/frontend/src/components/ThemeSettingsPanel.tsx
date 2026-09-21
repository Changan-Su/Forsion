/** 选中主题自曝的可调参数(manifest settings[]);就地展开在主题卡下方,改一下即刻生效。
 *  值落 localStorage `theme.<id>.<key>`,由 themeSettings 刷成 :root 内联 CSS 变量。 */
import React, { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import type { ThemeEntry, ThemeSetting } from '../theme/manifest'
import { applyThemeSettings, readRaw, writeRaw, resetAll, usableSettings } from '../theme/themeSettings'
import { broadcastPrefs } from '../uiPrefsBus'
import { useI18n } from '../i18n'

const Row: React.FC<{ themeId: string; def: ThemeSetting; value: string; onChange: (v: string) => void }> = ({
  def, value, onChange,
}) => (
  <div className="theme-opt-row">
    <div className="theme-opt-label">
      <div>{def.label}</div>
      {def.description && <div className="theme-opt-desc">{def.description}</div>}
    </div>
    {def.type === 'number' ? (
      <>
        <input
          type="range" min={def.min} max={def.max} step={def.step ?? 1}
          value={value === '' ? def.default : value}
          onChange={(e) => onChange(e.target.value)}
        />
        <output className="theme-opt-val">{(value === '' ? def.default : value)}{def.unit ?? ''}</output>
      </>
    ) : def.type === 'select' ? (
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {def.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    ) : def.type === 'boolean' ? (
      <input type="checkbox" checked={value === 'true'} onChange={(e) => onChange(String(e.target.checked))} />
    ) : (
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
    )}
  </div>
)

export const ThemeSettingsPanel: React.FC<{ entry: ThemeEntry }> = ({ entry }) => {
  const { t } = useI18n()
  const themeId = entry.manifest.id
  const defs = usableSettings(entry)
  // 存值副本:改一次刷一次 :root,顺带触发重渲让滑块数字跟上。
  const [vals, setVals] = useState<Record<string, string>>(() =>
    Object.fromEntries(defs.map((d) => [d.key, readRaw(themeId, d)])))

  if (defs.length === 0) return null

  const set = (def: ThemeSetting, raw: string): void => {
    writeRaw(themeId, def, raw)
    setVals((s) => ({ ...s, [def.key]: raw }))
    applyThemeSettings(entry)
    broadcastPrefs() // 设置住在独立浮窗:不吼一嗓子,主窗的这套变量要重启才跟上
  }
  const reset = (): void => {
    resetAll(themeId, defs)
    setVals(Object.fromEntries(defs.map((d) => [d.key, String(d.default)])))
    applyThemeSettings(entry)
    broadcastPrefs() // ⚠ 重置 = 删键,收方只覆盖写进来的键 → 那边要下次启动才回默认(见 uiPrefsApply)
  }

  return (
    <div className="theme-opts">
      <div className="theme-opts-head">
        <span>{t('settings.theme.options', { name: entry.manifest.preview.title?.text || entry.manifest.name })}</span>
        <button type="button" className="btn sm ghost" onClick={reset}>
          <RotateCcw size={12} style={{ verticalAlign: -1, marginRight: 4 }} />
          {t('settings.theme.optionsReset')}
        </button>
      </div>
      {defs.map((d) => (
        <Row key={d.key} themeId={themeId} def={d} value={vals[d.key] ?? String(d.default)} onChange={(v) => set(d, v)} />
      ))}
    </div>
  )
}
