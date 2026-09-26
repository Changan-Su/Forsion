/**
 * 自绘单选组(role=radiogroup + role=radio 按钮)的键盘行为,按 WAI-ARIA APG 的 radio 模式(Codex 第一轮 A-3):
 *  - 组内只有**选中项**进 Tab 序(roving tabindex,radioTabIndex);没有选中项时第一项进 Tab 序。
 *  - 方向键在组内移动焦点并**选中**(选中跟随焦点),首尾循环;Home / End 到两端;禁用项跳过。
 * 用法:radiogroup 容器挂 onKeyDown={onRadioGroupKeyDown},每个 radio 给 tabIndex={radioTabIndex(...)}。
 * 设置页主题网格、引导向导主题网格、后端运行方式卡三处共用 —— 声明了 radio 就得有 radio 的操作方式。
 */
import type React from 'react'

const NEXT = new Set(['ArrowRight', 'ArrowDown'])
const PREV = new Set(['ArrowLeft', 'ArrowUp'])

export function onRadioGroupKeyDown(e: React.KeyboardEvent<HTMLElement>): void {
  if (!NEXT.has(e.key) && !PREV.has(e.key) && e.key !== 'Home' && e.key !== 'End') return
  if (e.altKey || e.ctrlKey || e.metaKey) return
  const radios = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]'))
    .filter((el) => !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true')
  const cur = radios.findIndex((el) => el === e.target || el.contains(e.target as Node))
  if (cur < 0) return
  const last = radios.length - 1
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? last : NEXT.has(e.key) ? (cur === last ? 0 : cur + 1) : (cur === 0 ? last : cur - 1)
  e.preventDefault()
  if (next === cur) return
  radios[next].focus()
  radios[next].click()
}

/** roving tabindex:选中项 0,其余 -1;组里一个选中的都没有时让第一项 0(否则整组 Tab 不进去)。 */
export function radioTabIndex(checked: boolean, index: number, anyChecked: boolean): 0 | -1 {
  return checked || (!anyChecked && index === 0) ? 0 : -1
}
