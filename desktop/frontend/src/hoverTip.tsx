/** 侧栏悬停提示(取代行尾的计数徽章)。时序、接力、定位都在 LCL 的提示框(lcl/engine/hoverSurface.ts):
 *  悬停 300ms 弹出,相邻行之间接力不重播;移开 80ms 后收。(2026-10-23 借鉴 Comma 方案取代原来的 1s / 0.1s。)
 *
 *  内容由调用方给 loader(可 async —— 文件时间要走 fs:stat)。loader 只在延时到点后才跑,
 *  所以「停够才弹」天然节流掉了扫过的行,不会每行一次磁盘 IO。这里只剩旧名字的薄包装,六处调用方不用改。
 */
import { tooltipProps, hideTooltip, type TooltipLines } from '@lcl/components'
import { useApp } from './stores/appStore'
import { formatDateTime } from './format/time'

export type TipLines = string[]
type Loader = () => TipLines | Promise<TipLines | null> | null

/** 收起当前提示(点开菜单之前之类)。 */
export function disarmTip(): void {
  hideTooltip()
}

/** 给行元素的 props;直接摊进 JSX 即可。默认贴行右侧,放不下翻到左侧。
 *  opts.focus:键盘聚焦(:focus-visible)时也弹、失焦收起 —— 提示里有**独有信息**的行用(Orbit 一级行的「类型 · 相对时间」,
 *  Codex 第一轮 B2-4);鼠标点击带来的焦点不弹,免得点一下就冒提示。 */
export function tipProps(load: Loader, opts?: { focus?: boolean }): ReturnType<typeof tooltipProps> {
  return tooltipProps(load as () => TooltipLines | null | Promise<TooltipLines | null>, { side: 'right', className: 'amx-tip', focus: !!opts?.focus })
}

/** 时间戳 → 「2026年9月17日 14:05」/「Sep 17, 2026, 14:05」(跟界面语言;秒是噪音,不显示)。 */
export function fmtTime(ms: number): string {
  return formatDateTime(ms, { year: 'always' })
}

/** 文案:loader 跑在事件回调里(非渲染),故走 store 取 tr,免得给一堆无 i18n 的文件塞 hook。 */
export const tipT = (k: string, vars?: Record<string, unknown>): string => useApp.getState().tr(k, vars)

/** 磁盘条目的提示行:文件 → 名 + 修改 + 创建;目录 → 子项计数(名字行上已有,不重复)。
 *  走主进程 fs:stat —— 停够才调,天然节流。非 electron / 读不到 → null(不弹)。 */
export async function fsTipLines(absPath: string, displayName: string): Promise<TipLines | null> {
  const st = await window.tangu?.statPath?.(absPath).catch(() => null)
  if (!st) return null
  if (st.isDir) return [tipT('tip.folder', { files: st.files ?? 0, folders: st.folders ?? 0 })]
  const lines = [displayName, tipT('tip.modified', { t: fmtTime(st.mtimeMs) })]
  // birthtimeMs=null:该文件系统给不出创建时间(Linux 常见)→ 宁可少一行,也不显示假日期。
  if (st.birthtimeMs) lines.push(tipT('tip.created', { t: fmtTime(st.birthtimeMs) }))
  return lines
}
