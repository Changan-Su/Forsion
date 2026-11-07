/**
 * 主区空态(应用层公共组件,不进 LCL:调用方要读界面语言、要跳设置)。
 * 样子来自 Coding 启动台的居中空态(`.csl-catalog .csl-empty`):22px 图标、heading 档标题、最宽 320px 的一句话、
 * 最多一颗实心主按钮。一句话说清「这里会出现什么」;有下一步才给按钮。侧栏不再另写一句「暂无内容」。
 * 手机壳(`.mb-shell`)里同一个组件,只是不居中到正中、往上提一点(emptyState.css)。
 *
 * `secondary` 只给「主按钮之外还有一个次要动作」的少数场合(收件箱「全部标为已读」),画成描边小按钮,别塞第二颗实心的。
 * `examples`(2026-11-02,上手引导 B):最多 3 条「可以这样写」的例句,点一下通常是填进输入框(不直接建东西);右边一句灰字注解。
 * 其余 HTML 属性(data-*、role…)原样落在外层,台架和单测按它们找。
 */
import type { HTMLAttributes, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import './emptyState.css'

export interface EmptyStateAction {
  label: string
  icon?: LucideIcon
  onClick: () => void
  disabled?: boolean
  /** 落在按钮上的 data-action(台架 / 单测用)。 */
  action?: string
}

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  icon: LucideIcon
  title: ReactNode
  line?: ReactNode
  action?: EmptyStateAction | null
  secondary?: ReactNode
  examples?: { label: ReactNode; note?: ReactNode; onClick: () => void }[]
}

export function EmptyState({ icon: Icon, title, line, action, secondary, examples, className, ...rest }: EmptyStateProps) {
  const ActionIcon = action?.icon
  return (
    <div {...rest} className={`empty-state${className ? ` ${className}` : ''}`} data-empty-state="">
      <Icon className="empty-state-icon" size={22} strokeWidth={1.6} aria-hidden />
      <strong className="empty-state-title">{title}</strong>
      {line && <p className="empty-state-line">{line}</p>}
      {!!examples?.length && <div className="empty-state-examples">
        {examples.slice(0, 3).map((ex, i) => <button key={i} type="button" className="empty-state-example" onClick={ex.onClick}>
          <span className="empty-state-example-label">{ex.label}</span>{ex.note && <span className="empty-state-example-note">{ex.note}</span>}
        </button>)}
      </div>}
      {(action || secondary) && <div className="empty-state-actions">
        {action && <button type="button" className="empty-state-action" data-action={action.action} disabled={action.disabled} onClick={action.onClick}>
          {ActionIcon && <ActionIcon size={15} aria-hidden />}{action.label}
        </button>}
        {secondary}
      </div>}
    </div>
  )
}
