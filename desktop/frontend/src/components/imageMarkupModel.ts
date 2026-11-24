/**
 * 在图上标注改(生图多张与标注改图方案 2B,2026-11-23):标记的数据、编号、撤销,以及发出去的那条消息。
 * 方案页:docs/ToBeImproved/生图多张与标注改图方案_2026-11-23/index.html
 *
 * 交给模型的方式(第一期,不动 10-19 的改图契约):原图 + 一张把编号标记画上去的副本,作为附件一起发;正文是编号清单,
 * 每条带九宫格方位(对话模型看不了图时也知道改哪里)。edit_image 的说明里写着「标注副本只看不改」——来源只用原图,
 * 不然圈和编号会被画进结果。坐标一律按图宽 / 图高归一到 0–1,和显示尺寸无关。
 */
import type { Attachment } from '../types'
import { registerMessages, translate as tr } from '../i18n'

registerMessages({
  'markup.where.tl': { zh: '左上', en: 'top left' },
  'markup.where.tc': { zh: '上方居中', en: 'top center' },
  'markup.where.tr': { zh: '右上', en: 'top right' },
  'markup.where.ml': { zh: '左侧', en: 'middle left' },
  'markup.where.mc': { zh: '正中', en: 'center' },
  'markup.where.mr': { zh: '右侧', en: 'middle right' },
  'markup.where.bl': { zh: '左下', en: 'bottom left' },
  'markup.where.bc': { zh: '下方居中', en: 'bottom center' },
  'markup.where.br': { zh: '右下', en: 'bottom right' },
  'markup.kind.ellipse': { zh: '圈出的地方', en: 'Circled area' },
  'markup.kind.pin': { zh: '点的位置', en: 'Marked point' },
  'markup.kind.stroke': { zh: '涂到的地方', en: 'Painted area' },
  'markup.msg.line': { zh: '{n} {where}{kind}：{text}', en: '{n} {kind} ({where}): {text}' },
  'markup.msg.noText': { zh: '按下面的要求改', en: 'follow the request below' },
  'markup.msg.single': { zh: '按标注改附图 {a}（附图 {b} 是标注示意，只用来看改哪里）：', en: 'Edit attached image {a} following the marks (attached image {b} only shows where to change):' },
  'markup.msg.singlePlain': { zh: '改附图 {a}：', en: 'Edit attached image {a}:' },
  'markup.msg.multi': { zh: '分别改下面 {count} 张图，每张单独改一次、只拿它自己的原图（标注示意只用来看改哪里）：', en: 'Edit these {count} images separately: one edit per image, using only its own original (marked copies only show where to change):' },
  'markup.msg.item': { zh: '图 {i}（{name}，附图 {a}）：', en: 'Image {i} ({name}, attached image {a}):' },
  'markup.msg.itemMarked': { zh: '图 {i}（{name}，附图 {a}；附图 {b} 是它的标注示意）：', en: 'Image {i} ({name}, attached image {a}; attached image {b} shows its marks):' },
  'markup.msg.also': { zh: '另外：{text}', en: 'Also: {text}' },
  'markup.msg.keep': { zh: '其余保持不变。', en: 'Keep everything else the same.' },
  'markup.copyName': { zh: '{name}-标注', en: '{name}-marked' },
})

export type MarkKind = 'ellipse' | 'pin' | 'stroke'
/** 一处标注。坐标按图宽 / 图高归一(0–1);涂抹的笔宽按图宽归一。 */
export interface Mark {
  id: number
  kind: MarkKind
  text: string
  cx?: number; cy?: number; rx?: number; ry?: number
  x?: number; y?: number
  points?: Array<[number, number]>
  width?: number
}

export const MAX_MARKS = 9
/** 涂抹的缺省笔宽(图宽的比例) */
export const STROKE_WIDTH = 0.045

/** 一处标注的「中心」:方位词和跟着标记走的输入框都按它算 */
export function markCenter(m: Mark): [number, number] {
  if (m.kind === 'ellipse') return [m.cx ?? 0.5, m.cy ?? 0.5]
  if (m.kind === 'pin') return [m.x ?? 0.5, m.y ?? 0.5]
  const pts = m.points ?? [[0.5, 0.5]]
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]
}

/** 九宫格方位:给看不了图的对话模型,也给人读 */
export function whereOf(m: Mark): string {
  const [x, y] = markCenter(m)
  const col = x < 1 / 3 ? 'l' : x < 2 / 3 ? 'c' : 'r'
  const row = y < 1 / 3 ? 't' : y < 2 / 3 ? 'm' : 'b'
  return tr(`markup.where.${row}${col}`)
}

export function kindLabel(kind: MarkKind): string { return tr(`markup.kind.${kind}`) }

/** 删掉 / 撤销以后按顺序重编号 */
export function renumber(marks: Mark[]): Mark[] { return marks.map((m, i) => (m.id === i + 1 ? m : { ...m, id: i + 1 })) }

/** 撤销栈:每一步存一份标记清单。新落一处 + 它的第一句话 = 一步(落下时记一步,写第一句不再记)。 */
export interface History { past: Mark[][]; future: Mark[][] }
export const emptyHistory = (): History => ({ past: [], future: [] })
export function record(h: History, before: Mark[]): History { return { past: [...h.past, before], future: [] } }
export function undo(h: History, cur: Mark[]): { h: History; marks: Mark[] } | null {
  if (!h.past.length) return null
  return { h: { past: h.past.slice(0, -1), future: [cur, ...h.future] }, marks: h.past[h.past.length - 1] }
}
export function redo(h: History, cur: Mark[]): { h: History; marks: Mark[] } | null {
  if (!h.future.length) return null
  return { h: { past: [...h.past, cur], future: h.future.slice(1) }, marks: h.future[0] }
}

export interface MarkupEntry { name: string; marks: Mark[] }

/** 发出去的正文。附件顺序:每张图先原图,有标记的紧跟它的标注副本(和 buildAttachments 一致)。 */
export function buildMarkupMessage(entries: MarkupEntry[], overall: string): string {
  const lines: string[] = []
  const markLines = (marks: Mark[]): string[] =>
    marks.map((m) => tr('markup.msg.line', { n: m.id, where: whereOf(m), kind: kindLabel(m.kind), text: m.text.trim() || tr('markup.msg.noText') }))
  const extra = overall.trim()
  if (entries.length === 1) {
    const [e] = entries
    lines.push(e.marks.length ? tr('markup.msg.single', { a: 1, b: 2 }) : tr('markup.msg.singlePlain', { a: 1 }))
    lines.push(...markLines(e.marks))
    if (extra) lines.push(e.marks.length ? tr('markup.msg.also', { text: extra }) : extra)
  } else {
    lines.push(tr('markup.msg.multi', { count: entries.length }))
    let a = 1
    entries.forEach((e, i) => {
      lines.push(e.marks.length ? tr('markup.msg.itemMarked', { i: i + 1, name: e.name, a, b: a + 1 }) : tr('markup.msg.item', { i: i + 1, name: e.name, a }))
      lines.push(...markLines(e.marks))
      // 整体要求在每张下面各写一遍:放在末尾一行「每张都要」,模型会把它当成另一件事、对同一张多改一次(live imagemulti ④)
      if (extra) lines.push(e.marks.length ? tr('markup.msg.also', { text: extra }) : extra)
      a += e.marks.length ? 2 : 1
    })
  }
  lines.push(tr('markup.msg.keep'))
  return lines.join('\n')
}

/** 一次发多少张附件:edit_image 一次最多 8 张来源 */
export function attachmentCount(entries: MarkupEntry[]): number { return entries.reduce((n, e) => n + (e.marks.length ? 2 : 1), 0) }
export const MAX_ATTACHMENTS = 8

// ── 字节:原图与标注副本 ──
const OK_MIME = /^image\/(png|jpeg|webp)$/
/** edit_image 只收 6 MB 以内的 PNG / JPEG / WebP:原图读回来不合规就重编码成 JPEG(长边 ≤ 2048) */
const MAX_B64 = 5_500_000

async function blobToB64(b: Blob): Promise<string> {
  const buf = new Uint8Array(await b.arrayBuffer())
  let s = ''
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000))
  return btoa(s)
}
/** 先取成 blob 再解码:沙箱图的 src 是引擎的下载地址(跨源),直接画进画布会把画布污染、toBlob 抛 SecurityError */
async function loadImage(src: string): Promise<HTMLImageElement> {
  const res = await fetch(src)
  if (!res.ok) throw new Error(`image fetch failed: ${res.status}`)
  const url = URL.createObjectURL(await res.blob())
  return new Promise((ok, bad) => {
    const im = new Image()
    im.onload = () => { URL.revokeObjectURL(url); ok(im) }
    im.onerror = () => { URL.revokeObjectURL(url); bad(new Error('image load failed')) }
    im.src = url
  })
}
function canvasFor(im: HTMLImageElement, maxSide: number): { c: HTMLCanvasElement; g: CanvasRenderingContext2D; k: number } {
  const k = Math.min(1, maxSide / Math.max(im.naturalWidth, im.naturalHeight))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(im.naturalWidth * k)); c.height = Math.max(1, Math.round(im.naturalHeight * k))
  const g = c.getContext('2d')!
  g.drawImage(im, 0, 0, c.width, c.height)
  return { c, g, k }
}
async function canvasJpeg(c: HTMLCanvasElement, q: number): Promise<Blob> {
  return new Promise((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error('encode failed'))), 'image/jpeg', q))
}
const stem = (name: string): string => name.replace(/\.[a-z0-9]+$/i, '') || 'image'

/** shrink:整包超预算时强制重编码成 JPEG(长边 ≤ 2048) */
export async function originalAttachment(src: string, name: string, shrink = false): Promise<Attachment> {
  const res = await fetch(src)
  if (!res.ok) throw new Error(`image fetch failed: ${res.status}`)
  const blob = await res.blob()
  if (!shrink && OK_MIME.test(blob.type) && blob.size * 4 / 3 < MAX_B64) return { name, mimeType: blob.type, data: await blobToB64(blob), size: blob.size }
  const { c } = canvasFor(await loadImage(src), 2048)
  const out = await canvasJpeg(c, 0.9)
  return { name: `${stem(name)}.jpg`, mimeType: 'image/jpeg', data: await blobToB64(out), size: out.size }
}

/** 把 --signal 解析成画布认得的 rgb(),顺带算出编号字用白还是深色(暗色下指示色是浅蓝,白字看不清)。 */
export function resolveSignal(host: Element = document.body): string {
  const el = document.createElement('span')
  el.style.color = 'var(--signal, #2c5f9e)'
  host.append(el)
  const css = getComputedStyle(el).color
  el.remove()
  const c = document.createElement('canvas')
  c.width = c.height = 1
  const g = c.getContext('2d')
  if (!g) return 'rgb(44, 95, 158)'
  g.fillStyle = '#2c5f9e'
  g.fillStyle = css // 认不得的写法会被画布忽略,留着上一行的缺省色
  g.fillRect(0, 0, 1, 1)
  const [r, gg, b] = g.getImageData(0, 0, 1, 1).data
  return `rgb(${r}, ${gg}, ${b})`
}
function inkOn(color: string): string {
  const m = /(\d+)\D+(\d+)\D+(\d+)/.exec(color)
  if (!m) return '#fff'
  const [r, g, b] = m.slice(1).map(Number)
  return 0.299 * r + 0.587 * g + 0.114 * b > 165 ? '#16181d' : '#fff'
}

/** 把编号标记画进一张副本(给对话模型看改哪里)。颜色用 resolveSignal() 解析好的 rgb()。 */
export async function markedAttachment(src: string, name: string, marks: Mark[], color: string): Promise<Attachment> {
  const im = await loadImage(src)
  const { c, g } = canvasFor(im, 1536)
  const W = c.width, H = c.height, u = Math.max(W, H) / 1000, ink = inkOn(color)
  const badge = (x: number, y: number, n: number): void => {
    const r = 15 * u
    g.beginPath(); g.arc(x, y, r + 2.5 * u, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill()
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fillStyle = color; g.fill()
    g.fillStyle = ink; g.font = `600 ${Math.round(r * 1.2)}px -apple-system, "PingFang SC", sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'
    g.fillText(String(n), x, y + u)
  }
  for (const m of marks) {
    if (m.kind === 'ellipse') {
      const cx = (m.cx ?? 0.5) * W, cy = (m.cy ?? 0.5) * H, rx = (m.rx ?? 0.1) * W, ry = (m.ry ?? 0.1) * H
      for (const [w, col] of [[7 * u, 'rgba(255,255,255,.9)'], [4 * u, color]] as const) { g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); g.lineWidth = w; g.strokeStyle = col; g.stroke() }
      badge(cx + rx * 0.72, cy - ry * 0.72, m.id)
    } else if (m.kind === 'pin') {
      // 贴着上沿时箭头朝上、编号放到点的下面(同 ImageMarkup 的屏上画法),免得编号画出图外被裁掉
      const x = (m.x ?? 0.5) * W, y = (m.y ?? 0.5) * H, r = 15 * u, f = y < 22 * u + 2 * r + 4 * u ? -1 : 1
      g.beginPath(); g.moveTo(x, y); g.lineTo(x - 10 * u, y - 22 * u * f); g.lineTo(x + 10 * u, y - 22 * u * f); g.closePath(); g.fillStyle = '#fff'; g.fill()
      g.beginPath(); g.moveTo(x, y - 3 * u * f); g.lineTo(x - 7 * u, y - 20 * u * f); g.lineTo(x + 7 * u, y - 20 * u * f); g.closePath(); g.fillStyle = color; g.fill()
      badge(x, y - (22 * u + r) * f, m.id)
    } else {
      const pts = m.points ?? []
      if (!pts.length) continue
      g.save(); g.globalAlpha = 0.42; g.strokeStyle = color; g.lineCap = 'round'; g.lineJoin = 'round'; g.lineWidth = (m.width ?? STROKE_WIDTH) * W
      g.beginPath(); pts.forEach(([px, py], i) => (i ? g.lineTo(px * W, py * H) : g.moveTo(px * W, py * H))); if (pts.length === 1) g.lineTo(pts[0][0] * W + 0.1, pts[0][1] * H)
      g.stroke(); g.restore()
      badge(pts[0][0] * W, pts[0][1] * H, m.id)
    }
  }
  const out = await canvasJpeg(c, 0.9)
  return { name: `${tr('markup.copyName', { name: stem(name) })}.jpg`, mimeType: 'image/jpeg', data: await blobToB64(out), size: out.size }
}

/** 整包 base64 预算:本机引擎的请求体上限是 25 MB(standalone/main.ts),八张 3 MB 的 PNG 就超了 —— 超了从最大的原图起逐张重编码 */
export const TOTAL_B64_BUDGET = 18_000_000

/** 一次发出去的全部附件:每张图原图在前,有标记的紧跟标注副本 */
export async function buildAttachments(entries: Array<MarkupEntry & { src: string }>, color: string): Promise<Attachment[]> {
  const out: Array<Attachment & { src?: string }> = []
  for (const e of entries) {
    out.push({ ...(await originalAttachment(e.src, e.name)), src: e.src })
    if (e.marks.length) out.push(await markedAttachment(e.src, e.name, e.marks, color))
  }
  const total = (): number => out.reduce((n, a) => n + a.data.length, 0)
  const originals = out.map((a, i) => i).filter((i) => out[i].src).sort((a, b) => out[b].data.length - out[a].data.length)
  for (const i of originals) {
    if (total() <= TOTAL_B64_BUDGET) break
    const e = entries.find((x) => x.src === out[i].src)
    if (e) out[i] = await originalAttachment(e.src, e.name, true)
  }
  return out.map(({ src: _src, ...a }) => a)
}
