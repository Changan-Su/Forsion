import type { ButtonHTMLAttributes, ReactNode } from 'react'

export function SettingsPanel(props: {
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  className?: string
  /** 设置搜索的落点(settingsSearchIndex.ts 的 anchor)。 */
  anchor?: string
}) {
  return (
    <section className={`settings-panel${props.className ? ` ${props.className}` : ''}`} data-setting-anchor={props.anchor}>
      <div className={`settings-panel-head${props.actions ? ' settings-panel-head--actions' : ''}`}>
        {props.icon && <span className="settings-panel-icon">{props.icon}</span>}
        <div>
          <strong>{props.title}</strong>
          {props.description && <p>{props.description}</p>}
        </div>
        {props.actions && <div className="settings-panel-actions settings-panel-actions--wide">{props.actions}</div>}
      </div>
      {props.children}
    </section>
  )
}

export function SettingsRow(props: {
  label: ReactNode
  description?: ReactNode
  control?: ReactNode
  children?: ReactNode
  className?: string
  /** 设置搜索的落点(settingsSearchIndex.ts 的 anchor)。 */
  anchor?: string
  /** 窄屏(≤820)排法:`inline` = 开关、数值、单个按钮这类紧凑控件留在右边(放不下才换行);`wrap` = 输入框、步进器、
   *  两个以上的按钮换到下一行并占满。不给 = 旧行为(一律换到下一行),没换过来的旧页面保持原样。 */
  fit?: 'inline' | 'wrap'
}) {
  return (
    <div className={`settings-control-row settings-setting-row${props.className ? ` ${props.className}` : ''}`} data-setting-anchor={props.anchor} data-fit={props.fit}>
      <div className="settings-control-copy">
        <span>
          <strong>{props.label}</strong>
          {props.description && <small>{props.description}</small>}
        </span>
      </div>
      {props.control && <div className="settings-row-control">{props.control}</div>}
      {props.children}
    </div>
  )
}

/** 二态设置的唯一一种开关(走查续五 5.1:复选框、外观页旧 .switch 都换成它)。其余按钮属性(data-*、title…)原样落在按钮上。 */
export function SettingsSwitch({ checked, onChange, label, disabled, ...rest }: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  disabled?: boolean
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'onClick' | 'role' | 'type'>) {
  return (
    <button
      {...rest}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`settings-switch${checked ? ' active' : ''}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  )
}

export function SettingsState(props: {
  icon: ReactNode
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  busy?: boolean
}) {
  return (
    <section className="settings-state" aria-busy={props.busy || undefined}>
      <span className={`settings-state-icon${props.busy ? ' is-busy' : ''}`}>{props.icon}</span>
      <strong>{props.title}</strong>
      {props.description && <p>{props.description}</p>}
      {props.actions && <div className="settings-state-actions">{props.actions}</div>}
    </section>
  )
}
