/**
 * 审批卡 / 收件箱 / Muse 待批清单共用的「所见即所跑」判定。
 * 字符集与引擎 approvals.ts 的 SPOOF_CHARS 逐字一致(改一处要连带改另一处):C0/C1 控制符、软连字符、
 * ALM、蒙古元音分隔、零宽、行 / 段分隔、方向嵌入 / 覆盖 / 隔离、U+2060–206F、BOM —— 都能让看到的文字与实际执行的不同。
 */
const SPOOF_RANGES: Array<[number, number]> = [
  [0x00, 0x08], [0x0b, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x180e, 0x180e], [0x200b, 0x200b],
  [0x200e, 0x200f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff],
]
// 按码点拼字符类(源码里不写转义字面量:编辑工具会把它解码成真字符,U+2028 一进正则字面量就是换行)
const esc = (n: number): string => '\\' + 'u' + n.toString(16).padStart(4, '0')
export const SPOOF_RE = new RegExp(`[${SPOOF_RANGES.map(([a, b]) => (a === b ? esc(a) : `${esc(a)}-${esc(b)}`)).join('')}]`)
/** 一行里超过 24 列的横向空白:挂在行尾能把后面的命令推出视线(引擎的 preview 会标成 [N spaces],原始命令框不会)。 */
export const WIDE_BLANK_RE = /[^\S\n]{25,}/
/** 预览长到大概率要滚动才能看完(按行数 / 字数估,不依赖布局):给出「请滚动看完」提示。 */
export const previewNeedsScrollHint = (s: string): boolean => s.split('\n').length > 20 || s.length > 2000
