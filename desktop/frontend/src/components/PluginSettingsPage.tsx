/**
 * 引擎插件(manifest `settings.fields`)的设置正文:作用域(全局 / 按 Agent)+ 字段,全部由宿主设置零件画(方案 P4,2026-11-18)。
 * 字段 → 零件的换算在 pluginSettingsSchema.ts;多行文本与图片列表是自定义块,块里的界面由这里经 portal 画进去
 * (同一棵 React 树:值与语言都跟着走)。
 *
 * 读写口径不变:值经 /agent/plugins/:id/settings(PUT 是补丁)读写,图片走 /agent/plugins/:id/files;开关 / 下拉 / 步进器即时存,
 * 输入框失焦存(整页接 blur)。改动:读失败显示错误 + 重试(以前当成空表照样能存,违反「读失败 ≠ 空」);存失败弹回原值并提示。
 * 「设置 › 电脑操作」与「设置 › 插件设置 › 某个引擎插件」共用这一份。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Image as ImageIcon, Loader2, Trash2, Upload } from 'lucide-react'
import {
  addPluginFile, deletePluginFile, getPluginSettings, listPluginFiles, putPluginSettings,
  type PluginField, type PluginFile, type PluginInfo,
} from '../services/backendService'
import type { NormalAgentDef, TanguDesktopConfig } from '../types'
import { registerMessages, useI18n } from '../i18n'
import { agentName } from '../agentName'
import { homeTarget } from '../services/engine/targets'
import { panelToast } from './PanelNotice'
import { SettingsPage } from './SettingsPage'
import { SettingsRow } from './SettingsPrimitives'
import { engineFieldsToSchema, engineSlot, fieldLabel } from './pluginSettingsSchema'
import type { PluginSettingsGroup, PluginSettingsPageSchema } from '../../../shared/settingsPage'
import './pluginSettings.css'

registerMessages({
  'plugsettings.general': { zh: '通用', en: 'General' },
  'plugsettings.openLink': { zh: '打开', en: 'Open' },
  'plugsettings.loadFailed': { zh: '读取设置失败', en: "Couldn't load settings" },
  'plugsettings.retry': { zh: '重试', en: 'Try again' },
  'plugsettings.saveFailed': { zh: '设置没有保存：{error}', en: "Settings weren't saved: {error}" },
  'plugsettings.scopeDesc': {
    zh: '全局设置对所有 Agent 生效；按 Agent 的设置只对选中的 Agent 生效。',
    en: 'Global settings apply to every agent. Per-agent settings apply only to the agent you pick.',
  },
  'plugsettings.scopeEditing': { zh: '正在修改', en: 'Editing' },
  'plugsettings.scopeAgent': { zh: 'Agent', en: 'Agent' },
})

const errText = (e: unknown): string => (e && typeof e === 'object' && 'message' in e ? String((e as { message?: unknown }).message || '') : '') || String(e)

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => { const s = String(r.result || ''); resolve(s.slice(s.indexOf(',') + 1)) }
    r.onerror = reject
    r.readAsDataURL(file)
  })
}

const openUrl = (url: string): void => {
  if (!/^https?:\/\//i.test(url)) return
  if (window.tangu?.openExternal) void window.tangu.openExternal(url)
  else window.open(url, '_blank', 'noopener')
}

type ImageItem = { file: string } & Record<string, unknown>

/** 图片列表(image-list):沿用原来的导入 / 删除 / 逐项字段,画在自定义块里。 */
function ImageListBlock({ field, items, files, busy, onImport, onDelete, onItemField }: {
  field: Extract<PluginField, { type: 'image-list' }>
  items: ImageItem[]
  files: PluginFile[]
  busy: boolean
  onImport(): void
  onDelete(name: string): void
  onItemField(name: string, key: string, value: string): void
}) {
  const { t, locale } = useI18n()
  const help = field.help ? (locale === 'en' && field.helpEn ? field.helpEn : field.help) : undefined
  return (
    <div className="plugin-settings-images" data-plugin-setting={field.key}>
      <SettingsRow anchor={`plugin-setting-${field.key}`} fit="inline" label={fieldLabel(field, locale)} description={help}
        control={<button type="button" className="btn ghost sm" disabled={busy} onClick={onImport}>{busy ? <Loader2 size={13} className="spin" /> : <Upload size={13} />}{t('settings.plugins.import')}</button>} />
      {items.length === 0 ? <div className="plugin-settings-images-empty">{t('settings.plugins.empty')}</div> : (
        <div className="plugin-settings-images-list">
          {items.map((it) => {
            const blob = files.find((f) => f.name === it.file)
            return (
              <div key={it.file} className="plugin-settings-image">
                {blob?.dataBase64
                  ? <img src={`data:${blob.mimeType};base64,${blob.dataBase64}`} alt={it.file} />
                  : <span className="plugin-settings-image-ph"><ImageIcon size={16} /></span>}
                <div className="plugin-settings-image-body">
                  <div className="plugin-settings-image-head">
                    <span className="file-name">{it.file}</span>
                    <button type="button" className="icon-btn" title={t('common.delete')} aria-label={t('common.delete')} onClick={() => onDelete(it.file)}><Trash2 size={13} /></button>
                  </div>
                  {field.itemFields.map((itf) => (
                    <input key={itf.key} type="text" placeholder={fieldLabel(itf, locale)} aria-label={fieldLabel(itf, locale)} value={String(it[itf.key] ?? '')}
                      onChange={(e) => onItemField(it.file, itf.key, e.target.value)} />
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

/** 多行文本(textarea,非 secret):失焦存(整页的 blur 接住)。 */
function TextareaBlock({ field, value, onChange }: { field: Extract<PluginField, { type: 'text' | 'textarea' }>; value: string; onChange(v: string): void }) {
  const { locale } = useI18n()
  const help = field.help ? (locale === 'en' && field.helpEn ? field.helpEn : field.help) : undefined
  const label = fieldLabel(field, locale)
  return (
    <div className="plugin-settings-textarea" data-plugin-setting={field.key}>
      <SettingsRow anchor={`plugin-setting-${field.key}`} fit="wrap" label={label} description={help} />
      <textarea rows={4} value={value} placeholder={field.placeholder} aria-label={label} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}

/** 一个作用域下的全部字段。key 换(插件 / 作用域变了)= 重新挂载、重新读。 */
function EngineFields({ pluginId, scope, fields }: { pluginId: string; scope: string; fields: PluginField[] }) {
  const { t, locale } = useI18n()
  const [values, setValues] = useState<Record<string, unknown> | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [files, setFiles] = useState<PluginFile[]>([])
  const [busy, setBusy] = useState(false)
  const [slots, setSlots] = useState<Record<string, HTMLElement>>({})
  const latest = useRef<Record<string, unknown>>({})
  const dirty = useRef(false)
  const chain = useRef<Promise<unknown>>(Promise.resolve())
  const alive = useRef(true)
  const upRef = useRef<HTMLInputElement>(null)
  const upField = useRef('')
  const hasImageList = fields.some((f) => f.type === 'image-list')

  const load = useCallback(() => {
    setLoadError(null)
    setValues(null)
    void getPluginSettings(homeTarget(), pluginId, scope).then(
      (v) => { if (!alive.current) return; latest.current = v && typeof v === 'object' ? v : {}; dirty.current = false; setValues(latest.current) },
      (e) => { if (alive.current) setLoadError(errText(e)) },
    )
    if (hasImageList) void listPluginFiles(homeTarget(), pluginId, scope).then((f) => { if (alive.current) setFiles(f) })
  }, [pluginId, scope, hasImageList])
  useEffect(() => { alive.current = true; load(); return () => { alive.current = false } }, [load])

  /** 整份存(PUT 是补丁,整份发也不丢别的键);排队发,后改的不会被先改的晚到覆盖。 */
  const write = (next: Record<string, unknown>): Promise<unknown> => {
    latest.current = next
    dirty.current = false
    if (alive.current) setValues(next)
    const sent = chain.current.then(() => putPluginSettings(homeTarget(), pluginId, scope, next))
    chain.current = sent.catch(() => {})
    return sent.catch((e) => { panelToast(t('plugsettings.saveFailed', { error: errText(e) }), true); throw e })
  }
  const save = (key: string, v: unknown): Promise<unknown> => {
    const prev = latest.current[key]
    return write({ ...latest.current, [key]: v }).catch((e) => {
      // 没存上:弹回原值(开关 / 下拉跟着回去),除非这期间又改过
      if (Object.is(latest.current[key], v)) { latest.current = { ...latest.current, [key]: prev }; if (alive.current) setValues(latest.current) }
      throw e
    })
  }
  const edit = (key: string, v: unknown): void => {
    latest.current = { ...latest.current, [key]: v }
    dirty.current = true
    setValues(latest.current)
  }
  const flush = (): void => { if (dirty.current) void write(latest.current).catch(() => {}) }
  const flushRef = useRef(flush)
  flushRef.current = flush
  useEffect(() => () => flushRef.current(), []) // 离开页面(失焦之前就卸了)时把没存的存上

  const mountSlot = useCallback((slot: string) => (el: HTMLElement) => {
    setSlots((s) => ({ ...s, [slot]: el }))
    return () => setSlots((s) => { if (s[slot] !== el) return s; const n = { ...s }; delete n[slot]; return n })
  }, [])

  const listOf = (key: string): ImageItem[] => (Array.isArray(latest.current[key]) ? (latest.current[key] as ImageItem[]).filter((x) => x && typeof x.file === 'string') : [])
  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]; e.target.value = ''
    const key = upField.current
    if (!file || !key) return
    if (!file.type.startsWith('image/')) { panelToast(t('settings.plugins.onlyImage'), true); return }
    setBusy(true)
    try {
      await addPluginFile(homeTarget(), pluginId, scope, file.name, await fileToBase64(file))
      await write({ ...latest.current, [key]: [...listOf(key).filter((it) => it.file !== file.name), { file: file.name }] })
      const next = await listPluginFiles(homeTarget(), pluginId, scope)
      if (alive.current) setFiles(next)
    } catch (err) {
      panelToast(errText(err), true)
    } finally { if (alive.current) setBusy(false) }
  }
  const onDelete = async (key: string, name: string): Promise<void> => {
    if (!window.confirm(t('settings.plugins.deleteConfirm', { name }))) return
    try {
      await deletePluginFile(homeTarget(), pluginId, scope, name)
      await write({ ...latest.current, [key]: listOf(key).filter((it) => it.file !== name) })
      const next = await listPluginFiles(homeTarget(), pluginId, scope)
      if (alive.current) setFiles(next)
    } catch (err) { panelToast(errText(err), true) }
  }

  const schema: PluginSettingsPageSchema = loadError != null
    ? { state: { kind: 'error', title: t('plugsettings.loadFailed'), ...(loadError ? { desc: loadError } : {}), action: { label: t('plugsettings.retry'), onClick: load } } }
    : values == null
      ? { state: { kind: 'loading', title: t('common.loading') } }
      : engineFieldsToSchema(fields, {
        locale, values, generalTitle: t('plugsettings.general'), openLabel: t('plugsettings.openLink'),
        save, edit, mountSlot, openUrl,
      })

  return (
    <div className="plugin-settings-engine" data-plugin-settings-engine={pluginId} onBlur={flush}>
      <SettingsPage schema={schema} />
      {values != null && fields.map((f) => {
        if (f.type === 'textarea' && !f.secret) {
          const el = slots[engineSlot('textarea', f.key)]
          return el ? createPortal(<TextareaBlock field={f} value={String(values[f.key] ?? f.default ?? '')} onChange={(v) => edit(f.key, v)} />, el, f.key) : null
        }
        if (f.type === 'image-list') {
          const el = slots[engineSlot('images', f.key)]
          return el ? createPortal(
            <ImageListBlock field={f} items={listOf(f.key)} files={files} busy={busy}
              onImport={() => { upField.current = f.key; upRef.current?.click() }}
              onDelete={(name) => void onDelete(f.key, name)}
              onItemField={(name, ikey, v) => edit(f.key, listOf(f.key).map((it) => (it.file === name ? { ...it, [ikey]: v } : it)))} />,
            el, f.key) : null
        }
        return null
      })}
      {hasImageList && <input ref={upRef} type="file" accept="image/*" hidden onChange={(e) => void onUpload(e)} />}
    </div>
  )
}

/** 作用域那一组(插件声明了 agent 作用域才有):全局 / 按 Agent,按 Agent 时再选是哪个。 */
function scopeGroup(t: (k: string) => string, mode: 'global' | 'agent', setMode: (m: 'global' | 'agent') => void, agents: NormalAgentDef[], slug: string, setSlug: (s: string) => void): PluginSettingsGroup {
  return {
    id: 'scope', icon: 'bot', title: t('settings.plugins.scope'), desc: t('plugsettings.scopeDesc'),
    items: [
      {
        type: 'segmented', id: 'scope-mode', title: t('plugsettings.scopeEditing'), value: mode,
        options: [{ value: 'global', label: t('settings.plugins.scopeGlobal') }, { value: 'agent', label: t('settings.plugins.scopeAgent') }],
        onChange: (v) => setMode(v === 'agent' ? 'agent' : 'global'),
      },
      ...(mode === 'agent' ? [{
        type: 'select' as const, id: 'scope-agent', title: t('plugsettings.scopeAgent'), value: slug, disabled: agents.length === 0,
        options: agents.length ? agents.map((a) => ({ value: a.slug, label: agentName(a) })) : [{ value: '', label: t('settings.plugins.selectAgent') }],
        onChange: (v: string) => setSlug(v),
      }] : []),
    ],
  }
}

export const PluginSettingsPage: React.FC<{ cfg?: TanguDesktopConfig; plugin: PluginInfo; agents: NormalAgentDef[] }> = ({ plugin, agents }) => {
  const { t } = useI18n()
  const [scopeMode, setScopeMode] = useState<'global' | 'agent'>('global')
  const [agentSlug, setAgentSlug] = useState('')
  // Agent 名单是异步到的:没选过就落第一个(旧版只在首帧取,名单晚到时就一直是空)
  const slug = agents.some((a) => a.slug === agentSlug) ? agentSlug : agents[0]?.slug || ''
  const scopeStr = scopeMode === 'agent' && slug ? `agent:${slug}` : 'global'
  const fields = plugin.settings?.fields ?? []
  const perAgent = Array.isArray(plugin.scopes) && plugin.scopes.includes('agent')
  return (
    <>
      {perAgent && <SettingsPage schema={{ groups: [scopeGroup(t, scopeMode, setScopeMode, agents, slug, setAgentSlug)] }} />}
      {fields.length === 0
        ? <SettingsPage schema={{ state: { kind: 'empty', title: t('settings.plugins.noSettings') } }} />
        : <EngineFields key={`${plugin.id}:${scopeStr}`} pluginId={plugin.id} scope={scopeStr} fields={fields} />}
    </>
  )
}
