/** Database(Notion 式表格)的文件格式与纯逻辑:vault 内独立 `.db` JSON 文件,笔记里 `![[xxx.db]]` 嵌入。
 *  主进程(写前校验)与渲染层(表格操作)双端引用;显示名存文件内,文件名只作 ![[ ]] 解析用。 */
import { z } from 'zod'

export const DB_VERSION = 1

export type ColumnType = 'text' | 'number' | 'checkbox' | 'date' | 'select' | 'multiselect' | 'url' | 'page'

/** cell 语义:text/url/select=string、number=有限数、checkbox=boolean(缺=false)、
 *  date='YYYY-MM-DD'(即 <input type=date> 的 value)、multiselect=string[];缺 key 一律视为空。 */
export type CellValue = string | number | boolean | string[] | null

export interface DbColumn {
  id: string
  name: string
  /** primitive 类型(ColumnType 的成员)或插件注册的自定义类型 id(如 'todo'/'calendarDate')。
   *  自定义类型经渲染层的属性注册表 resolveBaseType 折算成一个 primitive baseType 落盘/校验/编解;
   *  主进程只按 z.string() 放行、按 cellValueSchema 校验值,永不需要认识自定义类型。 */
  type: string
  /** select 与 multiselect 共用的选项池(标签字符串,顺序即菜单顺序);互切类型零迁移。 */
  options?: string[]
  /** 列宽 px,拖拽落盘;缺=弹性列。 */
  width?: number
}

export interface DbRow {
  id: string
  cells: Record<string, CellValue> // key = column.id
}

/** 「笔记视图」数据源(Bases 式):行 = folder 里的笔记(实时)。 */
export interface DbSource {
  folder: string // vault 相对;'' = 整库
}

export interface DbFile {
  version: number
  name: string // 显示名(文件名无关紧要,嵌入头部可改)
  /** 存在 = 「笔记视图」(Bases 式,行即笔记,行来自 source.folder,rows 忽略);
   *  不存在 = 经典 JSON 表(行存 rows)。两模式并存。 */
  source?: DbSource
  columns: DbColumn[]
  rows: DbRow[] // 经典表:数组顺序 = 行的规范顺序;笔记视图:恒为 []
}

/** 用户可选的列类型(picker 列表)。'page' 不在内:它是笔记视图自动创建的唯一身份列(Page Name),系统专用。 */
export const COLUMN_TYPES: ColumnType[] = ['text', 'number', 'checkbox', 'date', 'select', 'multiselect', 'url']

/** 笔记视图内置身份列的 id(= cell key);单元格值 = 笔记标题/文件名。一张视图至多一个。 */
export const PAGE_NAME_KEY = '__page_name'

const cellValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()])
const dbColumnSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  // 放行任意非空 type 字符串:插件注册的自定义类型(渲染层折算成 baseType)才能写盘不被拒。
  // 值本身仍由 cellValueSchema 严格校验,未知类型只会渲染回退为文本,不丢数据。
  type: z.string().min(1),
  options: z.array(z.string()).optional(),
  width: z.number().positive().optional(),
})
const dbRowSchema = z.object({
  id: z.string().min(1),
  cells: z.record(z.string(), cellValueSchema),
})
export const dbFileSchema = z.object({
  version: z.number().int().min(1),
  name: z.string(),
  source: z.object({ folder: z.string() }).optional(),
  columns: z.array(dbColumnSchema),
  rows: z.array(dbRowSchema),
})

/** 短随机 id(列/行):8 位 base36,表格规模下碰撞可忽略。 */
export const dbId = (): string => Math.random().toString(36).slice(2, 10)

/** 新数据库种子:1 个文本列 + 1 个空行(创建即可打字,不是空壳)。 */
export function emptyDb(name: string): DbFile {
  return {
    version: DB_VERSION,
    name,
    columns: [{ id: dbId(), name: '名称', type: 'text' }],
    rows: [{ id: dbId(), cells: {} }],
  }
}

/** 新「笔记视图」种子:只含 Page Name 身份列;行来自 folder 里的笔记(不写 rows)。
 *  列(属性)在指向文件夹后按笔记 frontmatter 键的并集补全。 */
export function emptyNoteView(name: string, folder: string): DbFile {
  return {
    version: DB_VERSION,
    name,
    source: { folder },
    columns: [{ id: PAGE_NAME_KEY, name: 'Page Name', type: 'page' }],
    rows: [],
  }
}

/** Amadeus 默认工作区首启种子:一张经典多维表,自带 calendarDate + todo 两个内置注册类型的列,
 *  首启即让 Calendar Space 有内容。type 用注册类型字符串(依赖 DbColumn.type: string + zod z.string())。 */
export function seedCalendarDb(): DbFile {
  const nameId = dbId()
  const dateId = dbId()
  const doneId = dbId()
  return {
    version: DB_VERSION,
    name: '我的日历',
    columns: [
      { id: nameId, name: '名称', type: 'text' },
      { id: dateId, name: '日期', type: 'calendarDate' },
      { id: doneId, name: '完成', type: 'todo' },
    ],
    rows: [
      { id: dbId(), cells: { [nameId]: '欢迎使用 Calendar Space', [dateId]: '2026-07-06T10:00/2026-07-06T11:00', [doneId]: true } },
      { id: dbId(), cells: { [nameId]: '整理本周任务', [dateId]: '2026-07-07' } },
      { id: dbId(), cells: { [nameId]: '项目评审', [dateId]: '2026-07-08T14:00/2026-07-08T15:30' } },
    ],
  }
}

export type DbParseResult = { ok: true; data: DbFile } | { ok: false; error: string }

/** 宽容读 + 严格拒:JSON 损坏 / 结构不符 / 版本过新(前向保护)都返回错误而非异常。 */
export function parseDb(text: string): DbParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: 'JSON 解析失败' }
  }
  const r = dbFileSchema.safeParse(raw)
  if (!r.success) return { ok: false, error: '不是有效的 Database 文件结构' }
  if (r.data.version > DB_VERSION) return { ok: false, error: `版本过新(v${r.data.version}),请升级应用` }
  return { ok: true, data: r.data }
}

/** 两空格缩进 + 尾换行:vault 常入 git,保持可 diff。 */
export function serializeDb(db: DbFile): string {
  return `${JSON.stringify(db, null, 2)}\n`
}

/** 列类型切换是非破坏式的(只改 column.type 不动 cells):渲染经此宽容折算,编辑时才写规范值。
 *  切错类型再切回来数据无损(Notion 同款行为)。 */
export function coerceForDisplay(v: CellValue | undefined, type: ColumnType): CellValue {
  switch (type) {
    case 'text':
    case 'url':
    case 'page': // page 单元格 = 笔记标题(字符串);文件名/路径由列的 targetFolder 推导
      if (typeof v === 'string') return v
      if (typeof v === 'number') return String(v)
      if (Array.isArray(v)) return v.join(', ')
      return ''
    case 'number': {
      if (typeof v === 'number' && Number.isFinite(v)) return v
      if (typeof v === 'string') {
        const n = Number.parseFloat(v)
        if (Number.isFinite(n)) return n
      }
      return null
    }
    case 'checkbox':
      return v === true
    case 'date':
      return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : ''
    case 'select':
      if (typeof v === 'string') return v
      if (Array.isArray(v)) return v[0] ?? ''
      return ''
    case 'multiselect':
      if (Array.isArray(v)) return v
      if (typeof v === 'string' && v !== '') return [v]
      return []
  }
}
