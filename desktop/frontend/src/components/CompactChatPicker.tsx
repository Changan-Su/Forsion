import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { registerMessages } from '../i18n'
import './compactChatPicker.css'

registerMessages({
  'chatPicker.engine': { zh: '引擎', en: 'Engine' },
  'chatPicker.agent': { zh: 'Agent', en: 'Agent' },
})

/** 原生 select 保留键盘、触屏与完整选项名称；外观只展示当前选择，避免窄栏靠 hover 猜图标。 */
export function CompactChatPicker({ label, value, icon, options, onChange, busy = false }: {
  label: string
  value: string
  icon: ReactNode
  options: Array<{ value: string; name: string; description?: string; disabled?: boolean }>
  onChange: (value: string) => void
  busy?: boolean
}) {
  const selected = options.find((option) => option.value === value)
  return (
    <label className="compact-chat-picker" aria-busy={busy || undefined} title={selected?.name}>
      <span className="compact-chat-picker-kind">{label}</span>
      <span className="compact-chat-picker-icon">{icon}</span>
      <span className="compact-chat-picker-name">{selected?.name || label}</span>
      <ChevronDown size={13} />
      <select aria-label={label} value={selected ? value : ''} onChange={(event) => onChange(event.target.value)}>
        {!selected && <option value="" disabled>{label}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.description ? `${option.name} — ${option.description}` : option.name}
          </option>
        ))}
      </select>
    </label>
  )
}
