// 回车口径开关:回车一次 = 文件里只多一个换行(段内软换行;停在空行上再回车才分段)。缺省关 = 现有行为。
//
// 只作用于 v4 统一编辑器(unified/UnifiedPage):空行逐条往返(./lineGap)、回车 / Shift+回车 / 行首退格
// (unified/keyboard.ts)、段内第二行的行首触发符(./blockTriggers)、多行纯文本粘贴 / 拖入不再一行一段(./plainPaste)。
// 关着时上面每一处都原样走现有代码路径,schema 也不加新 attr —— 存盘与现状逐字相同。
//
// 怎么打开(都在页面 / 模块加载时读一次;切换后要重开笔记,已建好的编辑器不跟着变):
//  · 页面地址查询参数 `amxEnter=inline`(台架用;`amxEnter=off` 强制关);
//  · localStorage `amadeus.enterMode` = `inline`(真应用里试用,不进设置界面);
//  · 构建 / 起 vite 时的环境变量 `VITE_AMX_ENTER=inline`(让现有台架整套带着开关跑)。
// 单测用 setEnterInlineForTest。

export const ENTER_MODE_STORAGE_KEY = 'amadeus.enterMode'

const parse = (v: unknown): boolean | null => (v === 'inline' ? true : v === 'off' ? false : null)

function initial(): boolean {
  try {
    const q = typeof location !== 'undefined' ? parse(new URLSearchParams(location.search).get('amxEnter')) : null
    if (q != null) return q
  } catch { /* 非浏览器环境 */ }
  try {
    const s = typeof localStorage !== 'undefined' ? parse(localStorage.getItem(ENTER_MODE_STORAGE_KEY)) : null
    if (s != null) return s
  } catch { /* 存储不可用 */ }
  try {
    const env = (import.meta as unknown as { env?: Record<string, unknown> }).env
    const e = parse(env?.VITE_AMX_ENTER)
    if (e != null) return e
  } catch { /* 没有 import.meta.env */ }
  return false
}

let inline = initial()

/** 开关是否打开(回车一次 = 一个换行)。 */
export const enterInline = (): boolean => inline

/** 仅供单测:切换开关(之后新建的编辑器生效)。 */
export function setEnterInlineForTest(on: boolean): void {
  inline = on
}
