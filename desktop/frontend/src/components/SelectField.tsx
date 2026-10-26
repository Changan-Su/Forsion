import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import './selectField.css'

/** 选项列表的方向键 / Home / End(模型与普通下拉共用一份;落在搜索框里时 Home / End 留给输入框)。 */
export function moveOptionFocus(e: KeyboardEvent<HTMLDivElement>): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
  if (e.target instanceof HTMLInputElement && (e.key === 'Home' || e.key === 'End')) return
  e.preventDefault(); e.stopPropagation()
  const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('.profile-model-results button'))
  const current = buttons.indexOf(e.target as HTMLButtonElement)
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (current + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
  buttons[next]?.focus()
}

export interface SelectOption { value: string; label: string }

/**
 * 普通下拉(思考档位、审批模式、图像工作室参数、自动化执行者…):触发器 + 就地展开的选项,不浮层、不带搜索
 * (10-25 第四轮 4.3 起于 Agent「运行设置」;10-26 第七轮 7.21 从 views/profileControls 提到这里,替掉剩下的原生 select)。
 * 键盘:触发器上 ↑ / ↓ / Enter / 空格展开,展开后焦点落在当前项;↑ ↓ Home End 移动,Enter 选,Esc 收起并回到触发器;点外面收起。
 * `label` 缺省时不画标签行,外面自己有 <label> 或靠 `ariaLabel` 起名。只有一个选项时不出箭头、点不开。
 * `size="sm"`:窄属性面板用的 34px 触发器 / 32px 选项行(手机补到 44px)。`field` 落成 data-profile-field,台架按它找具体哪一个。
 */
export function SelectField({ label, ariaLabel, value, options, onChange, disabled, field, size }: {
  label?: string; ariaLabel?: string; value: string; options: SelectOption[]; onChange: (value: string) => void; disabled?: boolean; field?: string; size?: 'sm'
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const id = useId()
  const current = options.find((o) => o.value === value) ?? options[0]
  const single = options.length < 2
  useEffect(() => {
    if (!open) return
    box.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus()
    const outside = (e: PointerEvent): void => { if (!box.current?.parentElement?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [open])
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  const choose = (next: string): void => { if (next !== value) onChange(next); setOpen(false); trigger.current?.focus() }
  const labelledBy = label ? `${id}-label ${id}-value` : undefined
  return <div className="profile-model-field profile-select-field agent-field" data-profile-field={field} data-size={size}>
    {label && <span id={`${id}-label`}>{label}</span>}
    <button ref={trigger} type="button" className="profile-model-trigger" disabled={disabled || single} aria-haspopup="listbox" aria-labelledby={labelledBy} aria-label={label ? undefined : ariaLabel} aria-expanded={open} aria-controls={`${id}-options`}
      onClick={() => setOpen(!open)}
      onKeyDown={(e) => { if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); setOpen(true) } }}>
      <span id={`${id}-value`}>{current?.label}</span>{!single && <ChevronDown size={15} />}
    </button>
    {open && <div ref={box} className="profile-model-options profile-select-options" id={`${id}-options`} role="listbox" aria-labelledby={label ? `${id}-label` : undefined} aria-label={label ? undefined : ariaLabel} onKeyDown={(e) => {
      // Esc:收起、回到触发器。Tab:先把焦点交回触发器再收起,浏览器的 Tab 从触发器接着往下走(不掉回 body)。
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); trigger.current?.focus(); setOpen(false); return }
      if (e.key === 'Tab') { trigger.current?.focus(); setOpen(false); return }
      moveOptionFocus(e)
    }}>
      <div className="profile-model-results">
        {options.map((o) => <button key={o.value} type="button" role="option" data-value={o.value} aria-selected={o.value === value} onClick={() => choose(o.value)}><span>{o.label}</span>{o.value === value && <Check size={14} />}</button>)}
      </div>
    </div>}
  </div>
}
