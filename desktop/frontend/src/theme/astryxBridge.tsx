/** astryx(facebook/astryx 设计系统)接入桥 —— 全应用唯一入口。
 *  - CSS 三件套只在此 import 一次(reset→astryx-base→theme 的 layer 级联,顺序有讲究);
 *  - lclTheme:astryx token 值直接引用 LCL CSS 变量 → 换肤/明暗零维护跟随;
 *  - <AstryxScope>:Theme + mode 镜像(themeStore),包住任何使用 astryx 组件的子树。
 *  评估期纪律:业务代码不直接 import '@astryxdesign/core/theme',一律经本模块。 */
import '@astryxdesign/core/reset.css'
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
  // astryx 的根 Theme(树里没有父 Theme 时)会把 data-theme="light|dark" 同步到 <html> 上,
  // 覆盖 LCL 的 data-theme=<语言>;卸载时还把 data-theme/data-astryx-theme 整个移除(兄弟 Scope
  // 还挂着也照删)→ 切 Space 主题退回 lovable 的根因。刻意不做 Root 全局包裹(曾试过:astryx 的
  // 继承样式/@layer reset prose 会放大到全应用,观感被用户否掉),改为每个 Scope 自己纠偏:
  // - 挂载/更新:父级 layout effect 晚于子 Theme 执行,把 LCL 语言值抢回;data-astryx-theme 一并
  //   补上(传送到 body 的浮层靠它命中 @scope 主题样式)。deps 带 mode,跟根 Theme 的重跑同步。
  // - 卸载:React 删除树父 cleanup 先于子 Theme 的 removeAttribute → 微任务等整个提交结束后恢复
  //   (幂等,与同一提交里新挂载的 Scope 互不打架)。
  useLayoutEffect(() => {
    const el = document.documentElement
    el.dataset.theme = lang
    el.setAttribute('data-astryx-theme', lclTheme.name)
    return () => {
      queueMicrotask(() => {
        document.documentElement.dataset.theme = useTheme.getState().lang
        document.documentElement.setAttribute('data-astryx-theme', lclTheme.name)
      })
    }
  }, [lang, mode])
  return (
    <Theme theme={lclTheme} mode={mode}>
      {children}
    </Theme>
  )
}
