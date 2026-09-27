/** astryx(facebook/astryx 设计系统)接入桥 —— 全应用唯一入口。
 *  - CSS 三件套只在此 import 一次(reset→astryx-base→theme 的 layer 级联,顺序有讲究);
 *    重置用本目录的 astryxReset.css(原件收进 @scope,只罩 AstryxScope 子树),不 import 原件的全局版;
 *  - lclTheme:astryx token 值直接引用 LCL CSS 变量 → 换肤/明暗零维护跟随;
 *  - <AstryxScope>:Theme + mode 镜像(themeStore),包住任何使用 astryx 组件的子树。
 *  评估期纪律:业务代码不直接 import '@astryxdesign/core/theme',一律经本模块。 */
import './astryxReset.css'
import '@astryxdesign/core/astryx.css'
import '@astryxdesign/theme-neutral/theme.css'
import { useLayoutEffect, type ReactNode } from 'react'
import { Theme, defineTheme } from '@astryxdesign/core/theme'
import { useTheme } from '../stores/themeStore'

// LCL → astryx token 桥:单值字符串引用 LCL 变量,明暗由 LCL 变量自身随 data-mode 流动。
export const lclTheme = defineTheme({
  name: 'forsion-lcl',
  tokens: {
    '--color-accent': 'var(--accent, #6c5ce7)',
    // 前景(勾选框对勾/主按钮文字):必须桥到 LCL 的 --on-accent(随主题走,浅色 accent 主题里是深色),
    // 否则 astryx 用自带默认白 → 浅色/奶白 accent 主题下 对勾白底白字看不清。
    '--color-on-accent': 'var(--on-accent, #fff)',
    '--color-background-body': 'var(--bg)',
    '--color-background-surface': 'var(--bg-card, var(--bg))',
    '--color-text-primary': 'var(--text)',
    '--color-text-secondary': 'var(--text-muted)',
    '--radius-container': 'var(--radius-md, 12px)',
    // Theme 包裹层(display:contents)会级联 font-family → 桥回 LCL 字体,否则全局 Scope 会换掉应用字体。
    '--font-family-body': 'var(--font-ui)',
  },
})

export function AstryxScope({ children }: { children: ReactNode }) {
  const mode = useTheme((s) => s.mode)
  const lang = useTheme((s) => s.lang)
  // astryx 的根 Theme(树里没有父 Theme 时)会把 data-theme="light|dark" 与 data-astryx-theme 同步到
  // <html> 上;卸载时两个都移除(兄弟 Scope 还挂着也照删)。刻意不做 Root 全局包裹(曾试过:astryx 的
  // 继承样式/@layer reset prose 会放大到全应用,观感被用户否掉),改为每个 Scope 自己纠偏:
  // - data-theme:LCL 用它存语言名,根 Theme 写 light|dark 会盖掉(切 Space 主题退回 lovable 的根因)→
  //   父级 layout effect 晚于子 Theme 执行,把语言值抢回;卸载时微任务等整个提交结束后再恢复一次。
  // - data-astryx-theme:**必须从 <html> 摘掉**。Theme 注入的运行时 CSS(prose 的 :where(h1..h6/p/small/
  //   code,pre/hr) 与 :scope 上的整套 --color-*/--text-* token)都是 @scope ([data-astryx-theme="forsion-lcl"]),
  //   <html> 带着它就成了作用域根 → 日历/待办视图与别的内容同窗时(侧栏停着待办、仪表盘嵌卡),整窗裸标签
  //   吃 Astryx 字号行高:笔记正文 15→14px、行高 24→20px(check:astryxscope 实测)。Astryx 写它只为
  //   让传送到 body 的浮层/toast 命中作用域;我们用的 Button/DropdownMenu/Kbd/CheckboxInput(含 Tooltip/
  //   Layer)都没有 createPortal,浮层走原生 popover 留在包裹层里,摘掉零损失。以后引入会传送的组件,
  //   给它的挂载点单独带属性,别再挂回 <html>。deps 带 mode,跟根 Theme 的重跑同步。
  useLayoutEffect(() => {
    const el = document.documentElement
    el.dataset.theme = lang
    el.removeAttribute('data-astryx-theme')
    return () => {
      queueMicrotask(() => {
        document.documentElement.dataset.theme = useTheme.getState().lang
      })
    }
  }, [lang, mode])
  return (
    <Theme theme={lclTheme} mode={mode}>
      {children}
    </Theme>
  )
}
