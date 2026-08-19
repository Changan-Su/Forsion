/** UnifiedPage 的 frontmatter 收发室(P0 数据安全,2026-08-13 侦察发现):
 *  编辑器只吃正文 —— fm 块若喂进 Milkdown,首次落盘会被序列化成水平线+setext 标题(毁档)。
 *  这里把源文拆成「fm 块原文(逐字,含 amadeus_* 行)+ 正文」,保存时原样拼回;
 *  chrome(icon/cover/属性)只改 fm 侧,与正文共用同一条整文件写盘管线(单写者,不与防抖竞态)。 */
import { parse as parseYaml } from 'yaml'
import { AMADEUS_FM_KEY, stripFrontmatter, extractFrontmatterExtra } from '@amadeus-shared/compiler/split'
import { structureKeysFor } from '@amadeus-shared/compiler/v4'
import { parseFmObject, setFmExtraOnSource } from '@amadeus-shared/db/pageFrontmatter'

export interface FmSplit {
  /** fm 块逐字原文(含首尾 --- 与结尾换行);无 fm = ''。 */
  fmText: string
  /** 正文(fm 之后的一切,字节原样)。 */
  body: string
}

/** 拆分与 stripFrontmatter 同一正则口径:compose(split(raw)) === raw 恒成立。 */
export function splitFm(raw: string): FmSplit {
  const body = stripFrontmatter(raw)
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
  const amadeusLines = fmText
    ? extractAmadeusLines(fmText)
    : []
  const y = foreignYaml.replace(/\n+$/, '')
  if (!amadeusLines.length && !y.trim()) return ''
  return ['---', ...amadeusLines, ...(y.trim() ? [y] : []), '---', ''].join('\n')
}

function extractAmadeusLines(fmText: string): string[] {
  // 与 setFmExtraOnSource 同一口径:只有四个精确保留键算「我们的行」;
  // 用户自己的 amadeus_created 之类前缀键属外来数据,走 YAML 区(属性面板可见可编辑)。
  const m = /^---\r?\n([\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)$/.exec(fmText)
  if (!m) return []
  return (m[1] ?? '').split('\n').filter((l) => AMADEUS_FM_KEY.test(l))
}

const STRUCT_KEY = /^["']?amadeus_(schema|layout|canvas)["']?\s*:/

/** 结构键(amadeus_schema/amadeus_layout/amadeus_canvas)行级 splice(绝不过 YAML 往返,Codex A14):
 *  整片结构区重写 —— 先摘掉全部旧结构行(容忍引号键/重复行),再按 structureKeysFor 的判据重发;
 *  其余 fm 行逐字原样,剥到空 fm 块则整块消失。两个 JSON 参数必须是单行 JSON.stringify 输出。
 *  ⚠️ canvasJson 是**必填**:它与 layout 同属被本函数整片重写的区域,漏传 = 保存一次画布几何蒸发
 *  (且 schema 判据也跟着错)。要保持原状就传 `canvasLineOf(fmText)` —— 编译期强制每个写点表态。 */
export function setAmadeusStructure(fmText: string, layoutJson: string | null, canvasJson: string | null): string {
  const m = /^---\r?\n([\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)$/.exec(fmText)
  const inner = m ? (m[1] ?? '') : ''
  const kept = (inner ? inner.replace(/\r?\n$/, '').split('\n') : []).filter((l) => !STRUCT_KEY.test(l))
  const lines = [...structureKeysFor(layoutJson, canvasJson), ...kept]
  if (!lines.length) return ''
  return ['---', ...lines, '---', ''].join('\n')
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

function structLineOf(fmText: string, key: 'layout' | 'canvas'): string | null {
  const m = /^---\r?\n([\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)$/.exec(fmText)
  if (!m) return null
  const re = new RegExp(`^["']?amadeus_${key}["']?\\s*:\\s*(.+)$`)
  // ⚠️ 重复键取**最后一条** —— 与 parseSimpleYaml 同口径(它逐行覆盖同名键,后者胜)。取第一条
  //    会与解析侧打架:读到的是后一份、写回去的是前一份,一次保存把有效几何换成旧值(Codex P1)。
  let hit: string | null = null
  for (const line of (m[1] ?? '').split('\n')) {
    const lm = re.exec(line)
    if (lm) hit = lm[1].trim()
  }
  return hit
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
