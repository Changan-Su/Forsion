// 探针开关:回车一次 = 文件里只多一个换行(Obsidian 口径)。缺省 off = 与 main 完全一致。
//
//  · off    —— 现状:回车 = 新段落,段与段之间空一行。
//  · inline —— 路线一「段内换行」:段落里回车插软换行(落盘单个 `\n`),空行上再回车才分段。
//  · line   —— 路线二「一行一段」:每行一个段落,相邻段落落盘只隔一个 `\n`,读时把软换行拆回多段。
//
// 读取顺序:页面查询参数 `amxEnter=inline|line` → 构建期环境变量 VITE_AMX_ENTER → off。
// 单测用 setEnterModeForTest。编辑器的 schema / 插件在创建时读一次,切换后要重建编辑器。
export type EnterMode = 'off' | 'inline' | 'line'

const parse = (v: unknown): EnterMode | null => (v === 'inline' || v === 'line' || v === 'off' ? v : null)

function initial(): EnterMode {
  try {
    const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('amxEnter') : null
    const m = parse(q)
    if (m) return m
  } catch { /* 非浏览器环境 */ }
  try {
    const env = (import.meta as unknown as { env?: Record<string, unknown> }).env
    const m = parse(env?.VITE_AMX_ENTER)
    if (m) return m
  } catch { /* 没有 import.meta.env */ }
  return 'off'
}

let mode: EnterMode = initial()

export const enterMode = (): EnterMode => mode
export const enterOn = (): boolean => mode !== 'off'

/** 仅供单测:切换模式(之后新建的编辑器生效)。 */
export function setEnterModeForTest(m: EnterMode): void {
  mode = m
}
