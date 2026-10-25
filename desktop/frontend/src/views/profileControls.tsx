import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'
import { useI18n } from '../i18n'
import { Markdown } from '../components/Markdown'
import type { ModelInfo, ThinkingLevel } from '../../../../tangu-agent/src/contracts/clientTypes'
import { THINKING_LEVELS } from '../../../../tangu-agent/src/contracts/clientTypes'
import { DEFAULT_APPROVAL, DEFAULT_THINKING } from '../../../../tangu-agent/src/contracts/sessionDefaults'
import { thinkingLabel } from '../components/thinkingLabel'
import { APPROVAL_MODE_ORDER, MODE_KEY } from '../approvalReason'
import { isCoarsePointer } from '../touch'
import { zoomOf } from '@lcl/engine'
import './agentProfileMessages'
import './profileControls.css'

/** 标签条(`.agent-section-nav`)选中底的滑动:选中底画在选中格自己的 ::before 上(标签按字数分宽),
 *  换选中时从上一格的矩形滑过来(FLIP,WAAPI 动伪元素)。第一次渲染、上一格已不在、减弱动效时直接切。返回值挂到 nav 的 ref 上。 */
export function useSectionNavSlide<T extends HTMLElement = HTMLElement>(selected: string) {
  const ref = useRef<T>(null)
  const prev = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const cur = ref.current?.querySelector<HTMLElement>(':scope > .selected') ?? null
    const old = prev.current
    prev.current = cur
    if (!cur || !old || old === cur || !old.isConnected || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    // 矩形是视口 px(含界面缩放),动画写的是元素自己的 CSS px:按累计 zoom 换算,否则 120% 下会冲过头再一跳
    const z = zoomOf(cur), from = old.getBoundingClientRect(), to = cur.getBoundingClientRect()
    if (!to.width) return
    cur.animate([{ transform: `translate(${(from.left - to.left) / z}px, ${(from.top - to.top) / z}px)`, width: `${from.width / z}px`, height: `${from.height / z}px` },
      { transform: 'none', width: `${to.width / z}px`, height: `${to.height / z}px` }], { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)', pseudoElement: '::before' })
  }, [selected])
  return ref
}

/** 选项列表的方向键 / Home / End(模型与普通下拉共用一份;落在搜索框里时 Home / End 留给输入框)。 */
function moveOptionFocus(e: KeyboardEvent<HTMLDivElement>): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
  if (e.target instanceof HTMLInputElement && (e.key === 'Home' || e.key === 'End')) return
  e.preventDefault(); e.stopPropagation()
  const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('.profile-model-results button'))
  const current = buttons.indexOf(e.target as HTMLButtonElement)
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (current + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
  buttons[next]?.focus()
}

/** Inline disclosure keeps the searchable picker inside narrow docked panels, including at UI zoom. */
export function ProfileModelField({ models, value, onChange, label, disabled, field }: {
  models: ModelInfo[]; value: string; onChange: (id: string) => void; label: string; disabled?: boolean; field?: string
}) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()
  const filtered = models.filter((m) => `${m.name} ${m.id}`.toLowerCase().includes(query.trim().toLowerCase()))
  // 目录外的自定义 id 是支持的用法(下方「使用模型 ID」),不告警;只标一枚小签,免得像是目录名显示坏了(U-28a)。
  const known = models.find((m) => m.id === value)
  const custom = !!value && !known && models.length > 0
  const choose = (model: string) => { onChange(model); setOpen(false); setQuery(''); trigger.current?.focus() }
  return <div className="profile-model-field agent-field" data-profile-field={field}>
    <span id={`${id}-label`}>{label}</span>
    <button ref={trigger} className="profile-model-trigger" disabled={disabled} aria-labelledby={`${id}-label ${id}-value`} aria-expanded={open} aria-controls={`${id}-options`} onClick={() => setOpen(!open)}>
      <span id={`${id}-value`}>{known?.name || value || t('agentProfile.default')}{custom && <small className="profile-model-custom">{t('agentProfile.customModelId')}</small>}</span><ChevronDown size={15} />
    </button>
    {open && <div className="profile-model-options" id={`${id}-options`} onKeyDown={(e) => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); trigger.current?.focus(); return }
      moveOptionFocus(e)
    }}>
      <label className="profile-search"><Search size={14} /><input autoFocus={!isCoarsePointer()} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('agentProfile.searchModels')} aria-label={t('agentProfile.searchModels')} /></label>
      <div className="profile-model-results">
        <button aria-pressed={!value} onClick={() => choose('')}><span>{t('agentProfile.default')}</span>{!value && <Check size={14} />}</button>
        {filtered.map((m) => <button key={`${m.source}-${m.id}`} aria-pressed={value === m.id} onClick={() => choose(m.id)}><span><strong>{m.name}</strong><small>{m.id}</small></span>{value === m.id && <Check size={14} />}</button>)}
        {!filtered.length && <p className="agent-profile-muted">{t('agentProfile.noResults')}</p>}
        {query.trim() && !filtered.length && <button onClick={() => choose(query.trim())}>{t('agentProfile.useModelId', { id: query.trim() })}</button>}
      </div>
    </div>}
  </div>
}

export interface ProfileSelectOption { value: string; label: string }

/**
 * 普通下拉(思考档位、审批模式…):和 ProfileModelField 同一颗触发器、同一块就地展开的选项,只是不带搜索
 * (10-25 第四轮 4.3:Agent「运行设置」三个同级下拉一种控件,原生 select 的高度 / 箭头 / 暗色系统样子一并去掉)。
 * 键盘:触发器上 ↑ / ↓ / Enter / 空格展开,展开后焦点落在当前项;↑ ↓ Home End 移动,Enter 选,Esc 收起并回到触发器;点外面收起。
 * `field` 落成 data-profile-field,台架按它找具体哪一个。
 */
export function ProfileSelectField({ label, value, options, onChange, disabled, field }: {
  label: string; value: string; options: ProfileSelectOption[]; onChange: (value: string) => void; disabled?: boolean; field?: string
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const id = useId()
  const current = options.find((o) => o.value === value) ?? options[0]
  useEffect(() => {
    if (!open) return
    box.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus()
    const outside = (e: PointerEvent): void => { if (!box.current?.parentElement?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [open])
  const choose = (next: string): void => { if (next !== value) onChange(next); setOpen(false); trigger.current?.focus() }
  return <div className="profile-model-field profile-select-field agent-field" data-profile-field={field}>
    <span id={`${id}-label`}>{label}</span>
    <button ref={trigger} type="button" className="profile-model-trigger" disabled={disabled} aria-haspopup="listbox" aria-labelledby={`${id}-label ${id}-value`} aria-expanded={open} aria-controls={`${id}-options`}
      onClick={() => setOpen(!open)}
      onKeyDown={(e) => { if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); setOpen(true) } }}>
      <span id={`${id}-value`}>{current?.label}</span><ChevronDown size={15} />
    </button>
    {open && <div ref={box} className="profile-model-options profile-select-options" id={`${id}-options`} role="listbox" aria-labelledby={`${id}-label`} onKeyDown={(e) => {
      // Esc:收起、回到触发器。Tab:先把焦点交回触发器再收起,浏览器的 Tab 从触发器接着往下走(不掉回 body)。
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); trigger.current?.focus(); setOpen(false); return }
      if (e.key === 'Tab') { trigger.current?.focus(); setOpen(false); return }
      moveOptionFocus(e)
    }}>
      <div className="profile-model-results">
        {options.map((o) => <button key={o.value} type="button" role="option" aria-selected={o.value === value} onClick={() => choose(o.value)}><span>{o.label}</span>{o.value === value && <Check size={14} />}</button>)}
      </div>
    </div>}
  </div>
}

type Translate = (key: string, vars?: Record<string, string | number>) => string

/** 「跟随默认」那一项:知道现在的缺省是哪一档就写进括号(「跟随默认（Medium）」),不知道就只写「跟随默认设置」。 */
export const followDefaultLabel = (t: Translate, current?: string): string =>
  current ? t('agentProfile.defaultWith', { value: current }) : t('agentProfile.default')

/** 思考档位的选项。缺省档 = 引擎的会话缺省(sessionDefaults.DEFAULT_THINKING,agentLoop 同值)。
 *  `knownDefault: false`:缺省取决于所在的场合(团队临时成员跟着团队 / 会话的档),括号不写,只写「跟随默认设置」。 */
export function thinkingOptions(t: Translate, opts: { knownDefault?: boolean } = {}): ProfileSelectOption[] {
  return [{ value: '', label: followDefaultLabel(t, opts.knownDefault === false ? undefined : thinkingLabel(DEFAULT_THINKING as ThinkingLevel, t)) },
    ...THINKING_LEVELS.map((lv) => ({ value: lv, label: thinkingLabel(lv, t) }))]
}

/** 审批模式的选项:名字用输入框模式菜单那一套(approvalReason.MODE_KEY 单源)。缺省档 = 本机会话的起步档
 *  (sessionDefaults.DEFAULT_APPROVAL「替我批准」;Agent 定义只作用于本机会话,云沙箱会话不读这一项)。 */
export function approvalOptions(t: Translate, opts: { knownDefault?: boolean } = {}): ProfileSelectOption[] {
  return [{ value: '', label: followDefaultLabel(t, opts.knownDefault === false ? undefined : t(MODE_KEY[DEFAULT_APPROVAL])) },
    ...APPROVAL_MODE_ORDER.map((mode) => ({ value: mode, label: t(MODE_KEY[mode]) }))]
}

export function ProfileTextEditor({ label, value, onChange, rows = 8, maxLength, hint, placeholder }: {
  label: string; value: string; onChange: (value: string) => void; rows?: number; maxLength?: number; hint?: string; placeholder?: string
}) {
  const { t } = useI18n()
  const [preview, setPreview] = useState(false)
  const id = useId()
  return <div className="profile-text-editor">
    <div className="profile-editor-heading"><label htmlFor={id}>{label}</label><button type="button" className="profile-text-action" aria-pressed={preview} onClick={() => setPreview(!preview)}>{t(preview ? 'agentProfile.edit' : 'agentProfile.preview')}</button></div>
    {preview ? <div className="md-body profile-text-preview" role="region" aria-label={label}>{value ? <Markdown content={value} /> : <p className="agent-profile-muted">{t('agentProfile.emptyText')}</p>}</div> : <textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} rows={rows} maxLength={maxLength} placeholder={placeholder} />}
    <small className="profile-editor-hint">{hint}<span>{t('agentProfile.characters', { count: value.length })}</span></small>
  </div>
}

export function ProfileGroup({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return <section className="profile-config-group"><h2>{title}</h2>{hint && <p className="agent-profile-muted">{hint}</p>}<div className="agent-config-fields">{children}</div></section>
}
