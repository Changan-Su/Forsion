/**
 * 输入框里的行内引用:引用除了挂在上方「已选择」条,还能以一枚芯片的样子出现在句子里光标处。
 *
 * 输入框仍是纯文本框。行内的一段在草稿文本里写成「两个数字空格 + 名字 + 一个窄不断行空格」:
 *   - 前面那两个空格不断行、合起来约 1.1em,是空的 —— 叠在文本框上的那层(InlineRefMirror)在这一格画图标;
 *   - 整段底下由那一层画芯片的底色。文本框自己照常显示名字,所以输入法、选区、光标都不受影响。
 * 这一段指的是哪条引用,按名字到「已选择」里找;用户把它改坏了(删掉一个边界空格)就退回普通文字。
 * 发送时每一段换成那条引用的 token(expandRuns),名字对不上的原样留下。
 *
 * ponytail: 按名字对应。两条引用同名时只有先加的那条能用这种写法,后一条在句子里直接写 token 原文(见 Composer2 的 inlineTextFor)。
 *           要彻底不撞名得给每段带一个不可见的编号,等真有人撞到再做。
 */
export const RUN_LEAD = '  '
export const RUN_TAIL = ' '
const RUN_SRC = '  ([^  \\n]{1,80}) '

export interface InlineRun { start: number; end: number; name: string }

/** 引用的名字 → 能放进行内段的写法(去掉会和边界撞的空格与换行,封顶 80 字)。 */
// 按码点截(不切开表情),截完再去一次尾空格:第 80 个字正好是空格时不去的话,再过一遍这个函数结果就变了,段和引用对不上(Codex 评审)
export const runName = (name: string): string => [...String(name || '').replace(/[\u2007\u202F\r\n]+/g, ' ').trim()].slice(0, 80).join('').trimEnd()

export const inlineRun = (name: string): string => `${RUN_LEAD}${runName(name)}${RUN_TAIL}`

/** 文本里所有认得出的行内段(known 说这个名字是不是某条引用)。 */
export function findRuns(text: string, known: (name: string) => boolean): InlineRun[] {
  if (!text.includes(RUN_LEAD)) return []
  const out: InlineRun[] = []
  const re = new RegExp(RUN_SRC, 'gu')
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) if (known(m[1])) out.push({ start: m.index, end: m.index + m[0].length, name: m[1] })
  return out
}

/** 退格 / Delete 时光标挨着或落在哪一段里(整段一起删)。back = 退格(看光标左边),fwd = Delete(看右边)。 */
export function runTouching(runs: InlineRun[], pos: number, dir: 'back' | 'fwd'): InlineRun | undefined {
  return runs.find((r) => (dir === 'back' ? r.start < pos && pos <= r.end : r.start <= pos && pos < r.end))
}

/** 发送:每一段换成 token。used = 被换掉的那些名字(它们不必再进消息开头的引用行)。 */
export function expandRuns(text: string, tokenOf: (name: string) => string | undefined): { text: string; used: Set<string> } {
  const used = new Set<string>()
  if (!text.includes(RUN_LEAD)) return { text, used }
  const out = text.replace(new RegExp(RUN_SRC, 'gu'), (whole, name: string) => {
    const token = tokenOf(name)
    if (token === undefined) return whole
    used.add(name)
    return token
  })
  return { text: out, used }
}

/** 把某个名字的行内段还原成普通文字(引用被从「已选择」里摘掉时:话还在,只是不再是引用)。 */
export function plainRuns(text: string, name: string): string {
  const target = runName(name)
  if (!target || !text.includes(RUN_LEAD)) return text
  return text.replace(new RegExp(RUN_SRC, 'gu'), (whole, n: string) => (n === target ? n : whole))
}

/** 去掉草稿末尾的空白,但留着行内段的边界空格(它们也算空白字符:直接 /\s+$/ 会把结尾那一段拆坏)。往草稿后面接东西前用这个。 */
export const trimDraftEnd = (text: string): string => text.replace(/[^\S\u2007\u202F]+$/, '')
