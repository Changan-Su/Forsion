/**
 * 旧的插件设置接口 → 宿主设置零件的整页描述(方案 P4,2026-11-18)。插件作者一行不改,设置页一律由宿主零件画
 * (components/SettingsPage,与 ctx.ui.mountSettingsPage 同一份)。纯函数:值从哪读、往哪存由调用方给。
 *
 *  - 引擎插件 manifest `settings.fields`:section → 新的一组;toggle → 开关;select → 下拉;number → 范围小用步进器、
 *    否则输入框;text → 输入框(secret → 密码框);textarea → 自定义块(多行,secret 的照旧换成单行密码框);
 *    image-list → 自定义块(沿用原来的上传 / 删除 / 逐项字段);note → 不可操作的说明行;link → 一枚「打开」按钮。
 *    存的时机不变:开关 / 下拉 / 步进器即时存,输入框失焦存(由调用方在页面上接 blur)。
 *  - Forsion 插件 `ctx.registerSetting` 行 → 「通用」组:boolean → 开关,number → 步进器或输入框,text → 输入框。
 *  - Forsion 插件 `ctx.registerSettingsView` → 每个面板一组,组里一个自定义块(插件照旧往空 div 里画)。
 */
import type { PluginField } from '../services/backendService'
import type { SettingContribution, SettingsViewContribution } from '../amadeus/plugins/types'
import type { PluginSettingsGroup, PluginSettingsItem, PluginSettingsPageSchema } from '../../../shared/settingsPage'

type Locale = 'zh' | 'en'
type Labeled = { label: string; labelEn?: string }

const pick = (locale: Locale, zh: string, en?: string): string => (locale === 'en' && en ? en : zh)
export const fieldLabel = (f: Labeled, locale: Locale): string => pick(locale, f.label, f.labelEn)
const fieldHelp = (f: { help?: string; helpEn?: string }, locale: Locale): string | undefined => (f.help ? pick(locale, f.help, f.helpEn) : undefined)

/** 步进器只给范围小的数:两头都有界、跨度不超过这么多步。端口号、毫秒数这类大数用输入框(点一百下不是办法)。 */
export const STEPPER_MAX_SPAN = 24
export function numberFitsStepper(min: unknown, max: unknown): boolean {
  return typeof min === 'number' && typeof max === 'number' && Number.isFinite(min) && Number.isFinite(max) && max >= min && max - min <= STEPPER_MAX_SPAN
}

const finite = (x: unknown): number | undefined => {
  const n = typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN
  return Number.isFinite(n) ? n : undefined
}

/** 数字输入框里的一段文字 → 要存的值:空 = ''(同旧表单);不是数 = undefined(不存,输入框里先留着)。 */
export function parseNumberInput(text: string): number | '' | undefined {
  if (text.trim() === '') return ''
  return finite(text)
}

export interface EngineSchemaContext {
  locale: Locale
  values: Record<string, unknown>
  /** 宿主文案:「通用」(第一个 section 之前的字段落在这一组)、链接按钮上的「打开」。 */
  generalTitle: string
  openLabel: string
  /** 即时存(开关 / 下拉 / 步进器)。失败要 reject:开关、下拉会弹回去。 */
  save(key: string, value: unknown): void | Promise<unknown>
  /** 只改本地值,失焦再存(输入框)。 */
  edit(key: string, value: unknown): void
  /** 自定义块的挂载口(textarea / image-list 由页面自己往里画)。 */
  mountSlot(slot: string): (el: HTMLElement) => () => void
  openUrl(url: string): void
}

/** 自定义块的 slot 名:页面按它认出画什么(`textarea:<key>` / `images:<key>`)。 */
export const engineSlot = (kind: 'textarea' | 'images', key: string): string => `${kind}:${key}`

function engineItem(f: PluginField, c: EngineSchemaContext): PluginSettingsItem | null {
  const { locale, values } = c
  const title = fieldLabel(f, locale)
  const desc = 'help' in f ? fieldHelp(f, locale) : undefined
  const base = { id: f.key, title, ...(desc ? { desc } : {}) }
  const raw = (): unknown => values[f.key] ?? ('default' in f ? f.default : undefined)
  switch (f.type) {
    case 'toggle':
      // 引擎读值时已按 schema default 兜底(settingsStore.getScopeSettings),这里与旧表单同口径只看存的值
      return { ...base, type: 'switch', value: !!values[f.key], onChange: (v) => c.save(f.key, v) }
    case 'select':
      return {
        ...base, type: 'select', value: String(raw() ?? ''),
        options: f.options.map((o) => ({ value: o.value, label: pick(locale, o.label, o.labelEn) })),
        onChange: (v) => c.save(f.key, v),
      }
    case 'number': {
      if (numberFitsStepper(f.min, f.max)) {
        return { ...base, type: 'stepper', value: finite(raw()) ?? f.min, min: f.min, max: f.max, step: 1, onChange: (n) => { void c.save(f.key, n) } }
      }
      const v = raw()
      return {
        ...base, type: 'input', inputType: 'text', value: v === undefined || v === null ? '' : String(v),
        onChange: (text) => { const n = parseNumberInput(text); if (n !== undefined) c.edit(f.key, n) },
      }
    }
    case 'text':
    case 'textarea': {
      if (f.type === 'textarea' && !f.secret) return { type: 'custom', id: engineSlot('textarea', f.key), mount: c.mountSlot(engineSlot('textarea', f.key)) }
      const v = raw()
      return {
        ...base, type: 'input', inputType: f.secret ? 'password' : 'text', value: v === undefined || v === null ? '' : String(v),
        ...(f.placeholder ? { placeholder: f.placeholder } : {}),
        onChange: (text) => c.edit(f.key, text),
      }
    }
    case 'image-list':
      return { type: 'custom', id: engineSlot('images', f.key), mount: c.mountSlot(engineSlot('images', f.key)) }
    case 'note':
      // 说明文字:一行没有控件的说明(标题留空,正文走说明那一档的灰字)
      return { id: f.key, type: 'value', title: '', desc: fieldLabel(f, locale), value: '' }
    case 'link':
      return { id: f.key, type: 'button', title, buttons: [{ label: c.openLabel, icon: 'link', onClick: () => c.openUrl(f.url) }] }
    default:
      return null
  }
}

export function engineFieldsToSchema(fields: readonly PluginField[], c: EngineSchemaContext): PluginSettingsPageSchema {
  const groups: PluginSettingsGroup[] = []
  let current: PluginSettingsGroup | null = null
  for (const f of Array.isArray(fields) ? fields : []) {
    if (!f || typeof f !== 'object' || typeof f.key !== 'string') continue
    if (f.type === 'section') {
      const desc = fieldHelp(f, c.locale)
      current = { id: `section:${f.key}`, title: fieldLabel(f, c.locale), ...(desc ? { desc } : {}), items: [] }
      groups.push(current)
      continue
    }
    const item = engineItem(f, c)
    if (!item) continue
    if (!current) {
      current = { id: 'general', icon: 'list-checks', title: c.generalTitle, items: [] }
      groups.push(current)
    }
    current.items.push(item)
  }
  return { groups }
}

export interface ForsionSettingsContext {
  generalTitle: string
  /** 现存的值(字符串;没存过 = 缺省值的字符串)。 */
  read(def: SettingContribution): string
  write(def: SettingContribution, next: string): void
}

/** registerSetting 的行 → 「通用」组。宿主自动塞的「工作文件夹」排最后(插件自己的设置在前)。没有行 → null。 */
export function forsionSettingsGroup(rows: readonly SettingContribution[], c: ForsionSettingsContext, workFolderKey = 'workFolder'): PluginSettingsGroup | null {
  const list = rows.filter((r) => r && typeof r.key === 'string')
  if (!list.length) return null
  const ordered = [...list.filter((r) => r.key !== workFolderKey), ...list.filter((r) => r.key === workFolderKey)]
  const items: PluginSettingsItem[] = ordered.map((def) => {
    const base = { id: def.key, title: String(def.label ?? def.key), ...(def.description ? { desc: def.description } : {}) }
    const val = c.read(def)
    if (def.type === 'boolean') return { ...base, type: 'switch', value: val === 'true', onChange: (on) => c.write(def, on ? 'true' : 'false') }
    if (def.type === 'number' && numberFitsStepper(def.min, def.max)) {
      return { ...base, type: 'stepper', value: finite(val) ?? finite(def.default) ?? def.min, min: def.min, max: def.max, step: 1, onChange: (n) => c.write(def, String(n)) }
    }
    // number(范围大)与 text:输入框,每次改动即存(同旧表单;插件读 localStorage 时自己解析)
    return { ...base, type: 'input', inputType: 'text', value: val, onChange: (text) => c.write(def, text) }
  })
  return { id: 'general', icon: 'list-checks', title: c.generalTitle, items }
}

export interface SettingsViewContext {
  /** 面板没给 title 时的组名。 */
  fallbackTitle: string
  /** 每份注册(对象身份)一个稳定 id:插件重注册同 id 的面板 = 新对象 = 重新挂。 */
  idOf(def: SettingsViewContribution): string
  mount(def: SettingsViewContribution): (el: HTMLElement) => () => void
}

/** registerSettingsView → 每个面板一组,组里一个自定义块。 */
export function settingsViewGroups(views: readonly SettingsViewContribution[], c: SettingsViewContext): PluginSettingsGroup[] {
  return views.filter((v) => v && typeof v.mount === 'function').map((def) => {
    let title = ''
    try { title = typeof def.title === 'function' ? String(def.title() ?? '') : String(def.title ?? '') } catch { title = '' }
    const id = c.idOf(def)
    return { id: `view:${id}`, title: title || c.fallbackTitle, items: [{ type: 'custom', id, mount: c.mount(def) }] }
  })
}
