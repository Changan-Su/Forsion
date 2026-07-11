/**
 * 用户活动日志(main 侧唯一拼行/落盘点)—— `~/.forsion/activity/<YYYY-MM-DD>.log`,一行一事件:
 *
 *   202607110216 chat.new s=a1b2c3 "帮我整理今天的任务清单,先把…"
 *   202607110209 note.edit f="Notes/xxx.md" l=8-9
 *
 * 数据面:renderer 埋点(frontend/src/activity/log.ts)经 `activity:append` IPC 传**结构化**
 * {event, detail} 进来——拼行与消毒只在这里做,用户内容进不了行结构(防伪造事件行)。
 * 格式/消毒与引擎侧 tangu-agent/src/services/userActivity.ts 的 formatActivityLine **必须同款**
 * (读端 read_activity/Muse 触发器在引擎;改一处须同步另一处)。
 * note.edit 特例:page:save handler 调 logNoteEdit(带新旧全文),此处 diff 行区间 + 按文件 5 分钟
 * 合并(编辑器 400ms debounce 保存,逐次记会刷屏)。保留 30 天(启动时 prune)。
 */
import { promises as fs } from 'fs'
import { join } from 'path'
import { forsionHomeDir } from './forsionHome'

const EVENT_RE = /^[a-z][a-z0-9:._-]*$/
const LINE_CAP = 200
const VALUE_CAP = 80
const KEEP_DAYS = 30
// 2min:太长的话「编辑完立刻问 Muse/看实时视图」窗口内必扑空(dev Ctrl+C 强杀还会丢 buffer)
const EDIT_WINDOW_MS = 2 * 60_000

let enabled = true
/** 配置闸(main 读 config 后/config:set 时刷新);关=丢弃一切新事件,旧日志不动。 */
export function setActivityLogEnabled(v: boolean): void { enabled = v }
export function isActivityLogEnabled(): boolean { return enabled }

export const activityDir = (): string => join(forsionHomeDir(), 'activity')

const pad = (x: number): string => String(x).padStart(2, '0')
const activityTs = (d = new Date()): string =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}`
const localDateStr = (d = new Date()): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

const cleanValue = (v: unknown): string =>
  String(v ?? '').replace(/\s+/g, ' ').replace(/"/g, "'").trim().slice(0, VALUE_CAP)

/** 拼一行(与引擎 formatActivityLine 同款)。event 非法 → null(丢弃)。 */
export function formatActivityLine(event: string, detail?: Record<string, unknown>, at = new Date()): string | null {
  const ev = String(event || '').trim()
  if (!EVENT_RE.test(ev)) return null
  let line = `${activityTs(at)} ${ev}`
  const d = detail || {}
  for (const [k, raw] of Object.entries(d)) {
    if (k === 'text' || raw === undefined || raw === null || raw === '') continue
    if (!/^[a-z][a-z0-9_]*$/i.test(k)) continue
    const v = cleanValue(raw)
    if (!v) continue
    line += /[\s"=]/.test(v) ? ` ${k}="${v}"` : ` ${k}=${v}`
  }
  if (d.text !== undefined && d.text !== null && String(d.text).trim()) {
    line += ` "${cleanValue(d.text).slice(0, 40)}"`
  }
  return line.slice(0, LINE_CAP)
}

async function appendRaw(line: string): Promise<void> {
  const file = join(activityDir(), `${localDateStr()}.log`)
  try {
    await fs.appendFile(file, line + '\n', 'utf8')
  } catch {
    try {
      await fs.mkdir(activityDir(), { recursive: true })
      await fs.appendFile(file, line + '\n', 'utf8')
    } catch { /* 装饰性数据,失败即弃 */ }
  }
}

/** 记一条事件(fire-and-forget,绝不抛)。IPC handler 与 main 内部(app.start/file.save)共用。 */
export function logActivity(event: string, detail?: Record<string, unknown>): void {
  try {
    if (!enabled) return
    const line = formatActivityLine(event, detail)
    if (line) void appendRaw(line)
  } catch { /* 绝不拖累调用方 */ }
}

// ── note.edit:行区间 diff + 按文件 5 分钟合并 ────────────────────────────────

/** 掐头 frontmatter(--- ... ---)后按行算变更区间(1-based,针对新文本);无变化 → null。 */
export function changedLineRange(oldText: string, newText: string): { from: number; to: number } | null {
  const strip = (s: string): string[] => {
    let t = s ?? ''
    if (t.startsWith('---\n')) {
      const end = t.indexOf('\n---', 4)
      if (end >= 0) {
        const nl = t.indexOf('\n', end + 4)
        t = nl >= 0 ? t.slice(nl + 1) : ''
      }
    }
    return t.split('\n')
  }
  const a = strip(oldText)
  const b = strip(newText)
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  if (p === a.length && p === b.length) return null
  let s = 0
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  const from = p + 1
  const to = Math.max(b.length - s, from) // 纯删除时区间收敛到删除位置
  return { from, to }
}

const editBuffer = new Map<string, { from: number; to: number; timer: ReturnType<typeof setTimeout> }>()

function flushNoteEdit(relPath: string): void {
  const e = editBuffer.get(relPath)
  if (!e) return
  editBuffer.delete(relPath)
  clearTimeout(e.timer)
  logActivity('note.edit', { f: relPath, l: e.from === e.to ? String(e.from) : `${e.from}-${e.to}` })
}

/** page:save 调用:算行差并入 5 分钟窗口(窗口末尾落一行合并区间;app 退出前 flushAllNoteEdits)。 */
export function logNoteEdit(relPath: string, oldText: string, newText: string): void {
  try {
    if (!enabled || !relPath) return
    const r = changedLineRange(oldText, newText)
    if (!r) return
    const cur = editBuffer.get(relPath)
    if (cur) {
      cur.from = Math.min(cur.from, r.from)
      cur.to = Math.max(cur.to, r.to)
      return
    }
    const timer = setTimeout(() => flushNoteEdit(relPath), EDIT_WINDOW_MS)
    ;(timer as any).unref?.()
    editBuffer.set(relPath, { from: r.from, to: r.to, timer })
  } catch { /* 绝不拖累保存 */ }
}

/** app 退出前把窗口内未落盘的编辑行冲出去。 */
export function flushAllNoteEdits(): void {
  for (const key of [...editBuffer.keys()]) flushNoteEdit(key)
}

/** 合并窗口内未落盘的编辑,合成行(ts=now)。导出/实时视图附带,免得「刚编辑却看不到」。 */
export function pendingNoteEditLines(): string[] {
  const out: string[] = []
  for (const [f, e] of editBuffer) {
    const line = formatActivityLine('note.edit', { f, l: e.from === e.to ? String(e.from) : `${e.from}-${e.to}` })
    if (line) out.push(line)
  }
  return out
}

// ── 维护:30 天轮转 + 导出 ───────────────────────────────────────────────────

/** 启动时调用:删 30 天前的日志文件。绝不抛。 */
export async function pruneActivity(): Promise<void> {
  try {
    const names = await fs.readdir(activityDir())
    const cutoff = localDateStr(new Date(Date.now() - KEEP_DAYS * 86_400_000))
    for (const n of names) {
      const m = /^(\d{4}-\d{2}-\d{2})\.log$/.exec(n)
      if (m && m[1] < cutoff) await fs.unlink(join(activityDir(), n)).catch(() => {})
    }
  } catch { /* 目录不存在是常态 */ }
}

/** 导出近 days 天日志拼接文本(开发者「导出活动日志」按钮用)。 */
export async function exportActivity(days = 7): Promise<string> {
  const n = Math.min(Math.max(1, Math.floor(days) || 7), KEEP_DAYS)
  const parts: string[] = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000)
    try {
      parts.push(await fs.readFile(join(activityDir(), `${localDateStr(d)}.log`), 'utf8'))
    } catch { /* 当日无文件 */ }
  }
  const pending = pendingNoteEditLines()
  return parts.join('') + (pending.length ? pending.join('\n') + '\n' : '')
}
