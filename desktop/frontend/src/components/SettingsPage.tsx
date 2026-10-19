/**
 * 设置零件的整页描述(方案 B,2026-10-17):给一份 groups / items 数据,画成宿主的分组面板 + 设置行,按端排版。
 * 宿主自己的设置页(先换了「通知」)和插件的 ctx.ui.mountSettingsPage / mountSettingsItem 共用这一份。
 *
 * - 零件不带文字:全部由调用方传入。宿主词条只有读屏名(步进器的 − / +)和确认框的「取消」。颜色只用宿主变量。
 * - 窄屏排法写在行的 data-fit 上,由 base.css 的 ≤820 规则接(见 SettingsRow 的 fit):开关、数值、单个按钮留在右边,
 *   输入框、下拉、步进器、两个以上的按钮换到下一行占满。触屏上按钮、输入框加高到 36。
 * - 「选了就执行」(choice)在手机上换成一枚按钮 + 半屏:Android 原生半屏 / 网页手机壳的半屏都经 openNativeSheetMenu,
 *   两样都没有时退到 mb-sheet(singleColumn.css,手机壳里总在)。
 * - 状态归调用方,输入中的值归这里(useDraft):调用方 update 一次 = 以它为准;输入框 / 步进器不给 value 就保留用户输入的。
 */
import { Component, createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, Check, Copy, Inbox, Loader2, Minus, Plus } from 'lucide-react'
import { runNativeSheetMenu, presentNativeConfirm, UI_MODE } from '@lcl/engine'
import { PLUGIN_ICONS } from '../amadeus/components/icons'
import { registerMessages, useI18n } from '../i18n'
import { SettingsPanel, SettingsRow, SettingsState, SettingsSwitch } from './SettingsPrimitives'
import type {
  PluginSettingsButton, PluginSettingsConfirm, PluginSettingsGroup, PluginSettingsItem, PluginSettingsMeter,
  PluginSettingsOption, PluginSettingsPageSchema, PluginSettingsState,
} from '../../../shared/settingsPage'

registerMessages({
  'settingsparts.decrease': { zh: '减少', en: 'Decrease' },
  'settingsparts.increase': { zh: '增加', en: 'Increase' },
  'settingsparts.cancel': { zh: '取消', en: 'Cancel' },
})

/** 设置按手机排:真机、开发者手机界面、触屏窄屏。不能只靠窄屏 media query:桌面里的手机框宽 390,物理 viewport 仍是宽屏。 */
export function isPhoneSettings(): boolean {
  if (window.tangu?.mobile || UI_MODE === 'mobile') return true
  try { return window.matchMedia('(pointer: coarse) and (max-width: 820px)').matches } catch { return false }
}

/** alive:挂载还在(插件的挂载 dispose / 插件停用后为假,回调一律不再调)。rev:调用方 update 的次数,变了 = 以新描述为准。 */
const Live = createContext<{ alive(): boolean; rev: number }>({ alive: () => true, rev: 0 })
export const SettingsPartsLive = Live.Provider

/** 插件给的数组:不是数组当空;里面的 null / 非对象项丢掉(一条坏项不该让整页画不出来)。 */
const arr = <T,>(x: T[] | undefined): T[] => (Array.isArray(x) ? x.filter((v) => v != null && typeof v === 'object') : [])

/** 一个控件自己的寿命:卸载(行被 update 拿掉、整页 dispose)时 abort。半屏 / 确认还开着时行没了,答了也不再调回调。 */
function useLifetime(): () => AbortSignal | undefined {
  const ref = useRef<AbortController | null>(null)
  useEffect(() => {
    const c = new AbortController()
    ref.current = c
    return () => c.abort()
  }, [])
  return useCallback(() => ref.current?.signal, [])
}

/** 只认最后一次改动:先选 b(回调还没回)、再选 c,b 晚到的失败不许把 c 弹回去。 */
function useGeneration(): [() => number, (n: number) => boolean] {
  const gen = useRef(0)
  return [() => ++gen.current, (n) => n === gen.current]
}

/** 插件给的数据在渲染时出错(字段类型不对)只丢这一项 / 这一组,其余照画。 */
class Guard extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }
  componentDidCatch(e: unknown): void { console.error('[settings] 这一项画不出来,已跳过', e) }
  render(): ReactNode { return this.state.failed ? null : this.props.children }
}

/** 调调用方给的回调。同步返回 → undefined;返回 promise → 等它,成功 true、失败 false;抛错算失败。挂载没了就不调。 */
function invoke(alive: () => boolean, fn: () => unknown): Promise<boolean> | undefined {
  if (!alive()) return undefined
  try {
    const r = fn()
    if (r && typeof (r as PromiseLike<unknown>).then === 'function') {
      return Promise.resolve(r).then(() => true, (e) => { console.error('[settings] 回调失败', e); return false })
    }
    return undefined
  } catch (e) {
    console.error('[settings] 回调抛错', e)
    return Promise.resolve(false)
  }
}

/** 控件里正在显示的值。给了 value 且(值变了或调用方 update 过)→ 换成它;value 不给 → 一直保留用户改过的。 */
function useDraft<T>(value: T | undefined, fallback: T): [T, (v: T) => void] {
  const { rev } = useContext(Live)
  const [s, setS] = useState(() => ({ v: value ?? fallback, value, rev }))
  const set = useCallback((v: T) => setS((o) => ({ ...o, v })), [])
  if (s.rev !== rev || !Object.is(s.value, value)) {
    const next = { v: value === undefined ? s.v : value, value, rev }
    setS(next)
    return [next.v, set]
  }
  return [s.v, set]
}

function glyph(name: unknown, size: number): ReactNode {
  if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(PLUGIN_ICONS, name)) return null
  const G = PLUGIN_ICONS[name]
  return <G width={size} height={size} />
}

async function confirmPart(c: PluginSettingsConfirm, cancel: string, signal: AbortSignal | undefined): Promise<boolean> {
  const out = await presentNativeConfirm({ title: c.title, ...(c.message ? { message: c.message } : {}), confirm: c.confirmLabel, cancel, danger: c.danger ?? true }, signal)
  if (signal?.aborted) return false
  if (out.handled) return out.value != null
  // 设置页的确认一律用 window.confirm(桌面主进程弹原生框);手机上走上面的半屏
  return window.confirm(c.message ? `${c.title}\n\n${c.message}` : c.title)
}

function PartButton<V>({ b, value, disabled }: { b: PluginSettingsButton<V>; value: V; disabled?: boolean }) {
  const { alive } = useContext(Live)
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const lifetime = useLifetime()
  const kind = b.kind === 'primary' || b.kind === 'danger' ? b.kind : 'ghost'
  const click = async (): Promise<void> => {
    const signal = lifetime()
    if (b.confirm && !(await confirmPart(b.confirm, t('settingsparts.cancel'), signal))) return
    if (signal?.aborted) return
    const p = invoke(alive, () => b.onClick(value))
    if (p) { setBusy(true); void p.then(() => setBusy(false)) }
  }
  return (
    <button type="button" className={`btn ${kind} sm`} disabled={disabled || b.disabled || busy} aria-busy={busy || undefined} onClick={() => void click()}>
      {glyph(b.icon, 13)}{b.label}
    </button>
  )
}

function SwitchControl({ item }: { item: Extract<PluginSettingsItem, { type: 'switch' }> }) {
  const { alive } = useContext(Live)
  const [on, setOn] = useDraft(item.value, false)
  const [bump, current] = useGeneration()
  const latest = useRef(item.value)
  latest.current = item.value
  return (
    <SettingsSwitch checked={!!on} label={item.title} disabled={item.disabled} onChange={(next) => {
      setOn(next)
      const n = bump()
      void invoke(alive, () => item.onChange(next))?.then((ok) => { if (!ok && current(n)) setOn(latest.current) })
    }} />
  )
}

/** 分段选择与下拉共用:选了立刻生效,调用方的回调失败就退回去。 */
function useChoose(item: { value: string; onChange(v: string): unknown }): [string, (v: string) => void] {
  const { alive } = useContext(Live)
  const [v, setV] = useDraft(item.value, '')
  const [bump, current] = useGeneration()
  const latest = useRef(item.value)
  latest.current = item.value
  return [v, (next) => {
    if (next === v) return
    setV(next)
    const n = bump()
    void invoke(alive, () => item.onChange(next))?.then((ok) => { if (!ok && current(n)) setV(latest.current) })
  }]
}

function SegmentedControl({ item }: { item: Extract<PluginSettingsItem, { type: 'segmented' }> }) {
  const [v, choose] = useChoose(item)
  return (
    <div className="seg" role="radiogroup" aria-label={item.title}>
      {arr(item.options).map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={v === o.value} className={v === o.value ? 'active' : undefined} disabled={item.disabled} onClick={() => choose(o.value)}>{o.label}</button>
      ))}
    </div>
  )
}

function SelectControl({ item }: { item: Extract<PluginSettingsItem, { type: 'select' }> }) {
  const [v, choose] = useChoose(item)
  return (
    <select value={v} aria-label={item.title} disabled={item.disabled} onChange={(e) => choose(e.target.value)}>
      {arr(item.options).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

const INPUT_TYPES = new Set(['text', 'email', 'url', 'password', 'search'])
function InputControl({ item }: { item: Extract<PluginSettingsItem, { type: 'input' }> }) {
  const { alive } = useContext(Live)
  const [text, setText] = useDraft(item.value, '')
  return (
    <span className="settings-parts-inline">
      <input type={INPUT_TYPES.has(item.inputType ?? '') ? item.inputType : 'text'} value={text} placeholder={item.placeholder} aria-label={item.title}
        disabled={item.disabled} onChange={(e) => { const next = e.target.value; setText(next); void invoke(alive, () => item.onChange?.(next)) }} />
      {item.button && <PartButton b={item.button} value={text} disabled={item.disabled} />}
    </span>
  )
}

const num = (x: unknown, fallback: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : fallback)
function StepperControl({ item }: { item: Extract<PluginSettingsItem, { type: 'stepper' }> }) {
  const { alive } = useContext(Live)
  const { t } = useI18n()
  const min = num(item.min, -Infinity)
  const max = num(item.max, Infinity)
  const step = num(item.step, 1) > 0 ? num(item.step, 1) : 1
  const [v, setV] = useDraft<number>(item.value, Number.isFinite(min) ? min : 0)
  const set = (n: number): void => {
    const c = Math.min(max, Math.max(min, n))
    if (c === v) return
    setV(c)
    void invoke(alive, () => item.onChange?.(c))
  }
  return (
    <span className="settings-parts-inline">
      <span className="settings-stepper" role="group" aria-label={item.title}>
        <button type="button" aria-label={t('settingsparts.decrease')} disabled={item.disabled || v <= min} onClick={() => set(v - step)}><Minus size={14} /></button>
        <output aria-live="polite">{v}</output>
        <button type="button" aria-label={t('settingsparts.increase')} disabled={item.disabled || v >= max} onClick={() => set(v + step)}><Plus size={14} /></button>
      </span>
      {item.button && <PartButton b={item.button} value={v} disabled={item.disabled} />}
    </span>
  )
}

function CodeControl({ item }: { item: Extract<PluginSettingsItem, { type: 'code' }> }) {
  const { alive } = useContext(Live)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(id)
  }, [copied])
  const copy = (): void => {
    void Promise.resolve().then(() => navigator.clipboard.writeText(item.value)).then(
      () => { setCopied(true); void invoke(alive, () => item.onCopy?.()) },
      (e) => console.error('[settings] 复制失败', e),
    )
  }
  return (
    <span className="settings-inline-actions">
      <code className="settings-code-chip">{item.value}</code>
      <button type="button" className="btn ghost sm" disabled={item.disabled} onClick={copy}>{copied ? <Check size={13} /> : <Copy size={13} />}{item.copyLabel}</button>
    </span>
  )
}

function ChoiceSheet({ title, options, onPick, onClose }: { title: string; options: PluginSettingsOption[]; onPick(v: string): void; onClose(): void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="mb-sheet-scrim settings-parts-sheet" onClick={onClose}>
      <div className="mb-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()} style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <div className="mb-sheet-grip" />
        <div className="mb-sheet-head">{title}</div>
        {options.map((o) => (
          <button key={o.value} type="button" className="mb-sheet-row" onClick={() => onPick(o.value)}>
            <span>{o.label}</span>{o.detail && <small>{o.detail}</small>}
          </button>
        ))}
      </div>
    </div>
  )
}

function ChoiceControl({ item, phone }: { item: Extract<PluginSettingsItem, { type: 'choice' }>; phone: boolean }) {
  const { alive } = useContext(Live)
  const [sheet, setSheet] = useState(false)
  const close = useCallback(() => setSheet(false), [])
  const lifetime = useLifetime()
  const options = arr(item.options)
  if (!phone) {
    return (
      <span className="settings-inline-actions">
        {options.map((o) => <PartButton key={o.value} b={{ label: o.label, onClick: () => item.onPick(o.value) }} value={undefined} disabled={item.disabled} />)}
      </span>
    )
  }
  const title = item.sheetTitle ?? item.title
  const pick = (v: string): void => { setSheet(false); void invoke(alive, () => item.onPick(v)) }
  const open = (): void => {
    const signal = lifetime()
    void runNativeSheetMenu({
      title,
      sections: [{ items: options.map((o) => ({ id: o.value, label: o.label, ...(o.detail ? { detail: o.detail } : {}), run: () => { if (!signal?.aborted) pick(o.value) } })) }],
    }, { signal }).then((handled) => { if (!handled && !signal?.aborted) setSheet(true) })
  }
  return (
    <>
      <button type="button" className="btn ghost sm" disabled={item.disabled} aria-haspopup="dialog" onClick={open}>{item.button}</button>
      {sheet && createPortal(<ChoiceSheet title={title} options={options} onPick={pick} onClose={close} />, document.body)}
    </>
  )
}

function fitOf(item: PluginSettingsItem, phone: boolean): 'inline' | 'wrap' {
  switch (item.type) {
    case 'input': case 'select': case 'stepper': return 'wrap'
    case 'button': return arr(item.buttons).length > 1 ? 'wrap' : 'inline'
    case 'choice': return phone || arr(item.options).length <= 1 ? 'inline' : 'wrap'
    default: return 'inline'
  }
}

function RowControl({ item, phone }: { item: PluginSettingsItem; phone: boolean }) {
  switch (item.type) {
    case 'switch': return <SwitchControl item={item} />
    case 'value': return <span className="settings-value">{item.value}</span>
    case 'button': return <span className="settings-inline-actions">{arr(item.buttons).map((b, i) => <PartButton key={i} b={b} value={undefined} disabled={item.disabled} />)}</span>
    case 'input': return <InputControl item={item} />
    case 'segmented': return <SegmentedControl item={item} />
    case 'select': return <SelectControl item={item} />
    case 'choice': return <ChoiceControl item={item} phone={phone} />
    case 'stepper': return <StepperControl item={item} />
    case 'code': return <CodeControl item={item} />
    default: return null
  }
}

function Meters({ meters }: { meters: PluginSettingsMeter[] }) {
  return (
    <div className="settings-meters">
      {meters.map((m, i) => {
        const pct = Math.round(Math.min(1, Math.max(0, num(m.value, 0))) * 100)
        return (
          <div key={i} className="settings-meter">
            <div className="settings-meter-head"><span>{m.label}</span><strong>{m.valueLabel ?? `${pct}%`}</strong></div>
            <div className="settings-meter-track" role="meter" aria-label={m.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
              <div className="settings-meter-fill" style={{ width: `${pct}%` }} />
            </div>
            {m.caption && <small>{m.caption}</small>}
          </div>
        )
      })}
    </div>
  )
}

function PartState({ state }: { state: PluginSettingsState }) {
  const busy = state.kind === 'loading'
  const icon = busy ? <Loader2 size={20} /> : glyph(state.icon, 20) ?? (state.kind === 'error' ? <AlertCircle size={20} /> : <Inbox size={20} />)
  return <SettingsState icon={icon} title={state.title} description={state.desc} busy={busy} actions={state.action && <PartButton b={state.action} value={undefined} />} />
}

/** 清单外的内容:宿主给一块空 div,插件自己往里画;每个 id 只 mount 一次,块没了 / 整页卸载时调它返回的收尾。 */
function Custom({ mount }: { mount: (el: HTMLElement) => void | (() => void) }) {
  const { alive } = useContext(Live)
  const ref = useRef<HTMLDivElement>(null)
  const first = useRef({ mount, alive })
  useEffect(() => {
    const { mount: run, alive: live } = first.current
    if (!live() || typeof run !== 'function') return
    let off: unknown
    try { off = run(ref.current!) } catch (e) { console.error('[settings] 自定义块挂载失败', e) }
    return () => {
      if (typeof off !== 'function') return
      try { (off as () => void)() } catch (e) { console.error('[settings] 自定义块收尾失败', e) }
    }
  }, [])
  return <div ref={ref} className="settings-parts-custom" />
}

function Item({ item, phone }: { item: PluginSettingsItem; phone: boolean }) {
  switch (item?.type) {
    case 'meters': return <Meters meters={arr(item.meters)} />
    case 'state': return item.state ? <PartState state={item.state} /> : null
    case 'custom': return <Custom mount={item.mount} />
    case 'switch': case 'value': case 'button': case 'input': case 'segmented': case 'select': case 'choice': case 'stepper': case 'code':
      return (
        <SettingsRow label={item.title} description={item.desc} className={item.disabled ? 'is-disabled' : undefined}
          fit={fitOf(item, phone)} control={<RowControl item={item} phone={phone} />} />
      )
    default: return null
  }
}

const keyOf = (x: { id?: unknown }, i: number): string => (typeof x?.id === 'string' && x.id ? x.id : `#${i}`)

function Group({ group, phone }: { group: PluginSettingsGroup; phone: boolean }) {
  const items = arr(group.items)
  const actions = arr(group.actions)
  return (
    <SettingsPanel className="settings-panel--parts" icon={glyph(group.icon, 16)} title={group.title} description={group.desc}
      actions={actions.length ? actions.map((b, i) => <PartButton key={i} b={b} value={undefined} />) : undefined}>
      {items.length > 0 && <div className="settings-control-list settings-parts-list">{items.map((it, i) => <Guard key={keyOf(it, i)}><Item item={it} phone={phone} /></Guard>)}</div>}
    </SettingsPanel>
  )
}

/** 一整页:分组面板一组一个;`state` 给了就只画它(整页加载中 / 未登录 / 出错)。外面不包元素,面板直接落在调用方的容器里。 */
export function SettingsPage({ schema }: { schema: PluginSettingsPageSchema }) {
  const [phone] = useState(isPhoneSettings)
  if (schema?.state) return <PartState state={schema.state} />
  return <>{arr(schema?.groups).map((g, i) => <Guard key={keyOf(g, i)}><Group group={g} phone={phone} /></Guard>)}</>
}

/** 一件(方案 A):和整页里同一个 item 画法一样,插件自己决定放哪。 */
export function SettingsItem({ item }: { item: PluginSettingsItem }) {
  const [phone] = useState(isPhoneSettings)
  // 按 id 认:换了 id 就是另一件(自定义块的收尾 / 新挂、输入中的值都不能串过去)
  return <Guard key={keyOf(item, 0)}><Item item={item} phone={phone} /></Guard>
}
