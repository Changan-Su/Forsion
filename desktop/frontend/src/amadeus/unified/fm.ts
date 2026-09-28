/** UnifiedPage 的 frontmatter 收发室(P0 数据安全,2026-08-13 侦察发现):
 *  编辑器只吃正文 —— fm 块若喂进 Milkdown,首次落盘会被序列化成水平线+setext 标题(毁档)。
 *  这里把源文拆成「fm 块原文(逐字,含 amadeus_* 行)+ 正文」,保存时原样拼回;
 *  chrome(icon/cover/属性)只改 fm 侧,与正文共用同一条整文件写盘管线(单写者,不与防抖竞态)。 */
import { parse as parseYaml } from 'yaml'
import { AMADEUS_FM_KEY, BOM, fmEntries, stripFrontmatter, extractFrontmatterExtra } from '@amadeus-shared/compiler/split'
import { structureKeysFor } from '@amadeus-shared/compiler/v4'
import { parseFmObject, setFmExtraOnSource } from '@amadeus-shared/db/pageFrontmatter'

export interface FmSplit {
  /** fm 块逐字原文(含首尾 --- 与结尾换行);无 fm = ''。 */
  fmText: string
  /** 正文(fm 之后的一切,字节原样)。 */
  body: string
}

/** 拆分与 stripFrontmatter 同一正则口径:compose(split(raw)) === raw 恒成立。
 *  文件头 BOM(D-01)一律归 fm 侧:有 fm 块时它随块被 stripFrontmatter 认走;没有块时单独一个
 *  BOM 也当 fmText —— 编辑器吃不下 U+FEFF(首存即丢),留在拼接侧才能逐字往返。
 *  所以 fmText 只有三种形态:''、BOM 独苗、[BOM]+`---…---` 块;下面所有行级改写都先 fmInner 摘 BOM。 */
export function splitFm(raw: string): FmSplit {
  const body = stripFrontmatter(raw)
  if (body.length === raw.length && raw.startsWith(BOM)) return { fmText: BOM, body: raw.slice(1) }
  return { fmText: raw.slice(0, raw.length - body.length), body }
}

export function composeFm(fmText: string, body: string): string {
  return fmText + body
}

/** fm 块上的外来键 patch(值 undefined = 删键):骑 setFmExtraOnSource(amadeus_* 行原样保留、
 *  外来键 YAML 合并),返回新的 fm 块原文。全键删空 → ''(不留空 fm 块)。
 *  ⚠️ 外来区非空但 YAML 解析不了 → **拒改返回原文**(Codex P0:setFmExtraOnSource 把解析失败
 *  折算成 {},一次点图标就把用户手写 frontmatter 全部静默清空;拒改语义与 patchFmExtraText 对齐)。 */
export function patchFm(fmText: string, patch: Record<string, unknown>): string {
  const foreign = foreignFmText(fmText)
  if (foreign.trim() && !foreignParseable(foreign)) return fmText
  return splitFm(setFmExtraOnSource(fmText, patch)).fmText
}

function foreignParseable(foreign: string): boolean {
  try {
    const v: unknown = parseYaml(foreign)
    return v == null || (typeof v === 'object' && !Array.isArray(v))
  } catch {
    return false
  }
}

/** 整体替换外来键区(属性面板提交 YAML 文本);amadeus_* 行原样保留。 */
export function setForeignFm(fmText: string, foreignYaml: string): string {
  const { bom } = fmInner(fmText)
  const amadeusLines = extractAmadeusLines(fmText)
  const y = foreignYaml.replace(/\n+$/, '')
  if (!amadeusLines.length && !y.trim()) return bom
  return bom + ['---', ...amadeusLines, ...(y.trim() ? [y] : []), '---', ''].join('\n')
}

const FM_BLOCK = /^---\r?\n([\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)$/

/** fmText → 文件头 BOM + fm 块内文(不含栅栏;不是块 = null)。行级改写一律先摘 BOM、产物再原样
 *  放回字节 0(D-01:不摘则块认不出 → 当成「无 fm」从零重建 = 第一击就删光用户的 fm)。 */
function fmInner(fmText: string): { bom: string; inner: string | null } {
  const bom = fmText.startsWith(BOM) ? BOM : ''
  const m = FM_BLOCK.exec(fmText.slice(bom.length))
  return { bom, inner: m ? (m[1] ?? '') : null }
}

/** fm 块内文 → 顶层条目(键行 + 缩进续行为一组,见 split.ts fmEntries;V-01)。不是块 = null。
 *  按 /\r?\n/ 切:CRLF 源文的行尾 `\r` 既不进重组的块(D-19 混杂),也不挡单行值的读取。 */
function entriesOf(fmText: string): string[][] | null {
  const { inner } = fmInner(fmText)
  if (inner == null) return null
  return inner ? fmEntries(inner.replace(/\r?\n$/, '').split(/\r?\n/)) : []
}

function extractAmadeusLines(fmText: string): string[] {
  // 与 setFmExtraOnSource 同一口径:只有四个精确保留键算「我们的行」;
  // 用户自己的 amadeus_created 之类前缀键属外来数据,走 YAML 区(属性面板可见可编辑)。
  // 按条目取:块状写法的续行跟着键走,不落进外来区成孤儿(V-01)。
  return (entriesOf(fmText) ?? []).filter((e) => AMADEUS_FM_KEY.test(e[0])).flat()
}

const STRUCT_KEY = /^["']?amadeus_(schema|layout|canvas)["']?\s*:/

/** 结构键(amadeus_schema/amadeus_layout/amadeus_canvas)行级 splice(绝不过 YAML 往返,Codex A14):
 *  整片结构区重写 —— 先摘掉全部旧结构行(容忍引号键/重复行),再按 structureKeysFor 的判据重发;
 *  其余 fm 行逐字原样,剥到空 fm 块则整块消失。两个 JSON 参数必须是单行 JSON.stringify 输出。
 *  ⚠️ canvasJson 是**必填**:它与 layout 同属被本函数整片重写的区域,漏传 = 保存一次画布几何蒸发
 *  (且 schema 判据也跟着错)。要保持原状就传 `canvasLineOf(fmText)` —— 编译期强制每个写点表态。 */
export function setAmadeusStructure(fmText: string, layoutJson: string | null, canvasJson: string | null): string {
  const { bom } = fmInner(fmText)
  // 整块按 LF 重组(entriesOf 按 /\r?\n/ 切),CRLF 源文不再落成 CRLF/LF 混杂(D-19)。
  const entries = entriesOf(fmText) ?? []
  // 结构键按**条目**摘:块状写法的缩进续行跟着键一起走(V-01:只摘键行 = 续行成孤儿、整块 fm 失效)。
  const kept = entries.filter((e) => !STRUCT_KEY.test(e[0])).flat()
  const struct = structureKeysFor(layoutJson, canvasJson).flatMap((line) => {
    // 块状写法的结构键、值没变 → 原条目逐字回写,不走 `键: 值` 单行发射:读不懂的块状原文、块标量里的
    // 字符串都可能含换行或 `: `,拼成单行就是非法 YAML(与 canvas.ts「读不懂就逐字保留」同一道防线)。
    const key = STRUCT_EMIT.exec(line)?.[1] as StructKey | undefined
    const e = key ? lastStructEntry(entries, key) : null
    return e && e.length > 1 && structValueOf(e, key!) === (key === 'layout' ? layoutJson : canvasJson) ? e : [line]
  })
  const lines = [...struct, ...kept]
  if (!lines.length) return bom
  return bom + ['---', ...lines, '---', ''].join('\n')
}

/** 结构键自愈:layout/canvas 任一在场却没有 `amadeus_schema` 时补发结构区(顺序也归位)。
 *  只补不拆 —— 两者都不在场时原样返回,不去动一个孤零零的 schema 行(那只是 v4-structured
 *  的合法空态,拆了会把文件从 structured 变成 plain,不该由「自愈」擅自决定)。
 *  给源码模式这类绕过 setAmadeusStructure 的手写路径兜底(Codex P0)。 */
export function fixStructKeys(fmText: string): string {
  const layout = layoutLineOf(fmText)
  const canvas = canvasLineOf(fmText)
  if (layout == null && canvas == null) return fmText
  if (/^["']?amadeus_schema["']?\s*:/m.test(fmText)) return fmText
  return setAmadeusStructure(fmText, layout, canvas)
}

/** fm 块 → amadeus_layout 单行 JSON 原文(没有 → null)。 */
export function layoutLineOf(fmText: string): string | null {
  return structLineOf(fmText, 'layout')
}

/** fm 块 → amadeus_canvas 单行 JSON 原文(没有 → null)。画布几何在宿主侧只按原文搬运。 */
export function canvasLineOf(fmText: string): string | null {
  return structLineOf(fmText, 'canvas')
}

type StructKey = 'layout' | 'canvas'
const STRUCT_EMIT = /^amadeus_(layout|canvas):/

function structLineOf(fmText: string, key: StructKey): string | null {
  const entries = entriesOf(fmText)
  const e = entries && lastStructEntry(entries, key)
  return e ? structValueOf(e, key) : null
}

/** ⚠️ 重复键取**最后一条** —— 与 parseSimpleYaml 同口径(它逐行覆盖同名键,后者胜)。取第一条
 *  会与解析侧打架:读到的是后一份、写回去的是前一份,一次保存把有效几何换成旧值(Codex P1)。 */
function lastStructEntry(entries: readonly string[][], key: StructKey): string[] | null {
  const re = new RegExp(`^["']?amadeus_${key}["']?\\s*:`)
  let hit: string[] | null = null
  for (const e of entries) if (re.test(e[0])) hit = e
  return hit
}

/** 结构键条目 → 值。单行 = 行尾原文(老口径;键后没有值 = 当作没有这个键)。
 *  块状写法(V-01,外部 YAML 工具把单行 JSON 重排成多行)按 YAML 读这**一个**条目(整块一起读会被
 *  重复键打断,而重复键按上面「后者胜」是合法输入):对象/数组 → 折成单行 JSON,画布/分栏照常显示;
 *  块标量里的字符串 → 原样当值。读不懂 → 返回整段条目原文:非 null(键在场)且必然 JSON.parse 失败,
 *  下游一律走「读不懂就逐字保留」(canvas.ts deriveCanvasJson、deriveFmFromDoc 的 layout 分支、
 *  setCanvas* 的当面报错),写回时 setAmadeusStructure 原样回写这组行 —— 写入侧 fail-closed。 */
function structValueOf(entry: readonly string[], key: StructKey): string | null {
  if (entry.length === 1) {
    const m = new RegExp(`^["']?amadeus_${key}["']?\\s*:\\s*(.+)$`).exec(entry[0])
    return m ? m[1].trim() : null
  }
  const raw = entry.join('\n')
  try {
    const obj: unknown = parseYaml(raw)
    const v: unknown = obj && typeof obj === 'object' && !Array.isArray(obj) ? Object.values(obj)[0] : undefined
    if (v && typeof v === 'object') return JSON.stringify(v)
    if (typeof v === 'string') return v
  } catch {
    // 落到下面:读不懂
  }
  return raw
}

/** fm 块 → 外来键对象(icon/cover/cover_y/用户属性)。非法 YAML → {}。 */
export function foreignFmObject(fmText: string): Record<string, unknown> {
  if (!fmText) return {}
  return parseFmObject(extractFrontmatterExtra(fmText))
}

/** fm 块 → 外来键 YAML 原文(属性面板数据源;注释/顺序逐字保留)。 */
export function foreignFmText(fmText: string): string {
  if (!fmText) return ''
  return extractFrontmatterExtra(fmText)
}
