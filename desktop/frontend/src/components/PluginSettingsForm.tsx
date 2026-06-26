/**
 * 通用插件设置面板:据插件声明的 schema 渲染字段(toggle/text/textarea/number/select/image-list)。
 * 值经 /agent/plugins/:id/settings 读写;image-list 的图片走 /agent/plugins/:id/files。作用域(全局/按 agent)由父组件传入。
 * toggle/select 即时保存;text/number/textarea onBlur 保存。字段 label 用 schema 自带 zh/en。
 */
import React, { useEffect, useRef, useState } from 'react'
import { Loader2, Upload, Trash2, Image as ImageIcon } from 'lucide-react'
import {
  getPluginSettings, putPluginSettings, listPluginFiles, addPluginFile, deletePluginFile,
  type PluginField, type PluginFile,
} from '../services/backendService'
import type { TanguDesktopConfig } from '../types'
import { useI18n } from '../i18n'

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => { const s = String(r.result || ''); resolve(s.slice(s.indexOf(',') + 1)) }
    r.onerror = reject
    r.readAsDataURL(file)
  })
}

export const PluginSettingsForm: React.FC<{
  cfg: TanguDesktopConfig; pluginId: string; scope: string; fields: PluginField[]
}> = ({ cfg, pluginId, scope, fields }) => {
  const { t, locale } = useI18n()
  const [values, setValues] = useState<Record<string, any>>({})
  const [files, setFiles] = useState<PluginFile[]>([])
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const upRef = useRef<HTMLInputElement>(null)
  const upField = useRef<string>('')
  const lbl = (f: { label: string; labelEn?: string }): string => (locale === 'en' && f.labelEn ? f.labelEn : f.label)
  const hasImageList = fields.some((f) => f.type === 'image-list')

  useEffect(() => {
    void getPluginSettings(cfg, pluginId, scope).then(setValues).catch(() => setValues({}))
    if (hasImageList) void listPluginFiles(cfg, pluginId, scope).then(setFiles).catch(() => setFiles([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pluginId, scope])

  const persist = async (next: Record<string, any>): Promise<void> => {
    setValues(next); setErr('')
    try { await putPluginSettings(cfg, pluginId, scope, next); setSaved(true); setTimeout(() => setSaved(false), 1200) }
    catch (e: any) { setErr(e?.message || 'save failed') }
  }
  const setLocal = (key: string, v: any): void => setValues((p) => ({ ...p, [key]: v }))

  const fileByName = (name: string): PluginFile | undefined => files.find((f) => f.name === name)

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]; e.target.value = ''
    const key = upField.current
    if (!file || !key) return
    if (!file.type.startsWith('image/')) { setErr(t('settings.plugins.onlyImage')); return }
    setBusy(true); setErr('')
    try {
      await addPluginFile(cfg, pluginId, scope, file.name, await fileToBase64(file))
      const items = (Array.isArray(values[key]) ? values[key] : []).filter((it: any) => it.file !== file.name)
      await persist({ ...values, [key]: [...items, { file: file.name }] })
      setFiles(await listPluginFiles(cfg, pluginId, scope))
    } catch (e: any) { setErr(e?.message || 'upload failed') }
    finally { setBusy(false) }
  }
  const onDelItem = async (key: string, name: string): Promise<void> => {
    if (!window.confirm(t('settings.plugins.deleteConfirm', { name }))) return
    try {
      await deletePluginFile(cfg, pluginId, scope, name)
      await persist({ ...values, [key]: (values[key] || []).filter((it: any) => it.file !== name) })
      setFiles(await listPluginFiles(cfg, pluginId, scope))
    } catch (e: any) { setErr(e?.message || 'delete failed') }
  }
  const setItemField = (key: string, name: string, ikey: string, v: string): void =>
    setValues((p) => ({ ...p, [key]: (p[key] || []).map((it: any) => (it.file === name ? { ...it, [ikey]: v } : it)) }))

  const inputStyle: React.CSSProperties = { width: '100%', marginTop: 4, fontSize: 12.5 }

  const renderField = (f: PluginField): React.ReactNode => {
    // ── P3 声明式主题面板:展示/结构件(全部走 token,天然继承主题/明暗/扁平) ──
    if (f.type === 'section') {
      return (
        <div className="field" key={f.key} style={{ marginTop: 18 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.06em', paddingBottom: 6, borderBottom: 'var(--border-width) solid var(--border)' }}>{lbl(f)}</div>
          {f.help && <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 6 }}>{lbl({ label: f.help, labelEn: f.helpEn })}</div>}
        </div>
      )
    }
    if (f.type === 'note') {
      const tone = f.tone || 'info'
      const bg = tone === 'warn' ? 'var(--danger-light)'
        : tone === 'success' ? 'color-mix(in srgb, var(--green) 12%, transparent)'
        : 'var(--accent-light)'
      const fg = tone === 'warn' ? 'var(--danger)' : tone === 'success' ? 'var(--green)' : 'var(--text-muted)'
      return (
        <div className="field" key={f.key}>
          <div style={{ background: bg, color: fg, borderRadius: 'var(--radius-md, 8px)', padding: '10px 12px', fontSize: 12.5, lineHeight: 1.6 }}>{lbl(f)}</div>
        </div>
      )
    }
    if (f.type === 'link') {
      return (
        <div className="field" key={f.key}>
          <a className="btn sm" href={f.url} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none', display: 'inline-flex' }}>{lbl(f)}</a>
        </div>
      )
    }
    if (f.type === 'toggle') {
      return (
        <div className="field" key={f.key}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}>
            <input type="checkbox" checked={!!values[f.key]} onChange={(e) => void persist({ ...values, [f.key]: e.target.checked })} />
            {lbl(f)}
          </label>
          {f.help && <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 2 }}>{lbl({ label: f.help, labelEn: f.helpEn })}</div>}
        </div>
      )
    }
    if (f.type === 'select') {
      return (
        <div className="field" key={f.key}>
          <label>{lbl(f)}</label>
          <select value={values[f.key] ?? f.default ?? ''} onChange={(e) => void persist({ ...values, [f.key]: e.target.value })}>
            {f.options.map((o) => <option key={o.value} value={o.value}>{lbl({ label: o.label, labelEn: o.labelEn })}</option>)}
          </select>
        </div>
      )
    }
    if (f.type === 'number') {
      return (
        <div className="field" key={f.key}>
          <label>{lbl(f)}</label>
          <input type="number" min={f.min} max={f.max} value={values[f.key] ?? f.default ?? ''}
            onChange={(e) => setLocal(f.key, e.target.value === '' ? '' : Number(e.target.value))}
            onBlur={() => void persist(values)} style={inputStyle} />
        </div>
      )
    }
    if (f.type === 'text' || f.type === 'textarea') {
      const common = {
        value: values[f.key] ?? f.default ?? '', placeholder: (f as any).placeholder,
        onChange: (e: any) => setLocal(f.key, e.target.value), onBlur: () => void persist(values),
      }
      return (
        <div className="field" key={f.key}>
          <label>{lbl(f)}</label>
          {f.type === 'textarea' ? <textarea rows={4} {...common} style={inputStyle} /> : <input type="text" {...common} style={inputStyle} />}
        </div>
      )
    }
    if (f.type !== 'image-list') return null
    const items: any[] = Array.isArray(values[f.key]) ? values[f.key] : []
    return (
      <div className="field" key={f.key}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <label style={{ margin: 0 }}>{lbl(f)}</label>
          <button className="btn sm" disabled={busy} onClick={() => { upField.current = f.key; upRef.current?.click() }}>
            {busy ? <Loader2 size={13} className="spin" /> : <Upload size={13} />} {t('settings.plugins.import')}
          </button>
        </div>
        {f.help && <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginBottom: 6 }}>{lbl({ label: f.help, labelEn: f.helpEn })}</div>}
        {items.length === 0 ? <div className="hint">{t('settings.plugins.empty')}</div> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {items.map((it) => {
              const blob = fileByName(it.file)
              return (
                <div key={it.file} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', border: 'var(--border-width) solid var(--border)', borderRadius: 8, padding: 8 }}>
                  {blob?.dataBase64
                    ? <img src={`data:${blob.mimeType};base64,${blob.dataBase64}`} alt={it.file} style={{ width: 52, height: 52, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }} />
                    : <div style={{ width: 52, height: 52, borderRadius: 6, background: 'var(--overlay-light)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><ImageIcon size={16} /></div>}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span className="file-name" style={{ flex: 1, fontSize: 12 }}>{it.file}</span>
                      <button className="icon-btn" title={t('common.delete')} onClick={() => void onDelItem(f.key, it.file)}><Trash2 size={13} /></button>
                    </div>
                    {f.itemFields.map((itf) => (
                      <input key={itf.key} type="text" placeholder={lbl(itf)} value={it[itf.key] ?? ''}
                        onChange={(e) => setItemField(f.key, it.file, itf.key, e.target.value)}
                        onBlur={() => void persist(values)} style={{ ...inputStyle, marginTop: 4 }} />
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  return (
    <div>
      {fields.map(renderField)}
      <input ref={upRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => void onUpload(e)} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 18 }}>
        {err && <span style={{ fontSize: 12, color: 'var(--danger, #dc2626)' }}>{err}</span>}
        {saved && <span style={{ fontSize: 12, color: 'var(--accent)' }}>{t('settings.plugins.saved')}</span>}
      </div>
    </div>
  )
}
