/** Reusable UI components inside a View. No workspace, session, or backend ownership. */
import React, { forwardRef, useLayoutEffect, useRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode, type Ref, type TextareaHTMLAttributes } from 'react'
import './chatBox.css'

export const ChatBoxSurface = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function ChatBoxSurface({ className = '', ...props }, ref) {
  return <div {...props} ref={ref} className={`t2c-card ${className}`} data-ui-component="chat-box" />
})

export interface ChatBoxInputProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Conversation hosts with their own sizing observer can opt out. */
  autoSize?: boolean
}
export const ChatBoxInput = forwardRef<HTMLTextAreaElement, ChatBoxInputProps>(function ChatBoxInput({ className = '', autoSize = true, ...props }, ref) {
  const local = useRef<HTMLTextAreaElement | null>(null)
  useLayoutEffect(() => {
    const el = local.current
    if (!el || !autoSize) return
    const resize = () => { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` }
    resize()
    // Observe width changes without observing the textarea's own height writes.
    let width = el.parentElement?.clientWidth
    const widthObserver = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width !== width) { width = entry.contentRect.width; resize() }
    })
    if (el.parentElement) widthObserver.observe(el.parentElement)
    return () => widthObserver.disconnect()
  }, [autoSize, props.value, props.placeholder])
  return <textarea {...props} rows={props.rows ?? 1} className={`t2c-ta ${className}`} ref={node => {
    local.current = node
    if (typeof ref === 'function') ref(node)
    else if (ref) ref.current = node
  }} />
})

export function ChatBoxToolbar({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={`t2c-row ${className}`} />
}

export function ChatBoxSubmit({ className = '', children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...props} className={`t2c-send ${className}`}>{children ?? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6" /></svg>}</button>
}

export interface ChatBoxProps {
  value: string
  onValueChange(value: string): void
  onSubmit(): void
  submitLabel: string
  disabled?: boolean
  submitDisabled?: boolean
  /** Prompt forms normally use modifier-enter so a plain Enter can add a line. */
  submitOn?: 'enter' | 'modifier-enter'
  className?: string
  inputRef?: Ref<HTMLTextAreaElement>
  inputProps?: Omit<ChatBoxInputProps, 'value' | 'onChange' | 'disabled'>
  beforeInput?: ReactNode
  afterInput?: ReactNode
  controls?: ReactNode
  submitContent?: ReactNode
  submitClassName?: string
}

export function ChatBox({ value, onValueChange, onSubmit, submitLabel, disabled, submitDisabled, submitOn = 'modifier-enter', className, inputRef, inputProps, beforeInput, afterInput, controls, submitContent, submitClassName }: ChatBoxProps) {
  const submit = () => { if (!disabled && !submitDisabled) onSubmit() }
  return <ChatBoxSurface className={className}>
    {beforeInput}
    <ChatBoxInput {...inputProps} ref={inputRef} value={value} disabled={disabled} onChange={e => onValueChange(e.target.value)} onKeyDown={e => {
      inputProps?.onKeyDown?.(e)
      if (!e.defaultPrevented && e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing
        && (submitOn === 'enter' || e.metaKey || e.ctrlKey)) { e.preventDefault(); submit() }
    }} />
    {afterInput}
    <ChatBoxToolbar>{controls}<span className="t2c-grow" /><ChatBoxSubmit className={submitClassName} disabled={disabled || submitDisabled} title={submitLabel} aria-label={submitLabel} onClick={submit}>{submitContent}</ChatBoxSubmit></ChatBoxToolbar>
  </ChatBoxSurface>
}
