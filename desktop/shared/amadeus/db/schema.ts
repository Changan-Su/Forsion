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
  /** type='formula':表达式源码(语法见 db/formula.ts);单元格值为计算结果,不落盘。 */
  formula?: string
  /** type='rowlink'(关联表):目标 .db 的 vault 相对路径;cell 存目标行 id(多选列存 id 数组)。
   *  type='lookup' 反向模式(与 lookupBackCol 同时存在):要扫的目标表路径。 */
  refDb?: string
  /** type='rowlink':允许多选(cell 为 string[]);缺/false = 单选(cell 为 string)。 */
  multiple?: boolean
  /** type='rowlink'(投影列 lookupKind='links' 同样认):芯片文案取目标表的哪一列(目标表列 id);缺 = 目标表 columns[0]。
   *  禁选 formula/lookup(计算列磁盘无值 → 全列「未命名」),渲染端解析时非法值一律回落首列。 */
  titleCol?: string
  /** type='rowlink'(投影列同样认):选择器候选行限定(对目标表行的筛选条件,算子与 DbViewFilter 同一套);缺 = 目标表全部行。 */
  refFilter?: DbViewFilter[]
  /** type='rowlink':refFilter 的组合逻辑;缺 = 'and'(全部满足)。 */
  refFilterMode?: 'and' | 'or'
  /** type='lookup'(引用,正向):本表中 rowlink 列的 id(沿它找到目标行)。 */
  lookupRel?: string
  /** type='lookup'(反向 rollup):目标表(refDb)里指回本表的 rowlink 列 id;
   *  该列单元格含本行 id 的目标行都算命中。与 refDb 同时存在即反向模式(判据 db/lookup.ts isBackLookup)。 */
  lookupBackCol?: string
  /** type='lookup':目标表中要引用的列 id(正向/反向共用)。 */
  lookupCol?: string
  /** type='lookup':聚合方式(first/count/sum/avg/join);缺 = first。 */
  lookupAgg?: string
  /** type='lookup' 反向模式专用:'links' = **可编辑投影列**(真双向关联的反向侧)。
   *  语义分工:投影列 = 关联本身(值 = 目标表里 lookupBackCol 指回本行的**行 id 数组**,照 rowlink cell 的形状消费、可点开 picker 改),
   *  普通 lookup = 沿关联取值/聚合。真值只存正向侧(目标表的 rowlink cell),本列 cell 永不落盘,只落这个配置;
   *  lookupCol/lookupAgg 对它无意义(纯逻辑 db/backlink.ts)。缺 = 普通 lookup。 */
  lookupKind?: 'links'
  /** type='autonumber'(自动编号):显示前缀(如 'PC-' → PC-12);cell 仍存纯数字。 */
  prefix?: string
  /** 数字显示格式(type='number';公式/引用列的结果是数字时同样按它显示):小数位 0-6,缺 = 跟随原值。
   *  ⚠️ **纯渲染,绝不动落盘值** —— cell 恒是原始数字,进入编辑态回到原始值(纯逻辑 db/numberFormat.ts)。 */
  precision?: number
  /** 数字显示的单位前缀,如 `¥`(同上:只影响显示)。 */
  unitPrefix?: string
  /** 数字显示的单位后缀,如 `元` / `%` / `台`(同上:只影响显示)。 */
  unitSuffix?: string
}

export interface DbRow {
  id: string
  cells: Record<string, CellValue> // key = column.id
}

/** 核心视图类型;DbView.type 放行任意字符串(前向兼容),渲染端未知类型回退表格。 */
export type DbViewType = 'table' | 'kanban' | 'calendar' | 'gallery' | 'chart' | 'form' | 'gantt'

/** 视图筛选条件(扁平 AND;op 语义见 viewQuery.ts,未知 op 视为恒真不丢行)。 */
export interface DbViewFilter {
  colId: string
  op: string
  /** empty/notempty/checked/unchecked 等一元 op 不用 value。 */
  value?: CellValue
}

/** 命名视图(AFFiNE/Notion 式):同一数据的多种呈现,嵌入块顶部 tab 切换。 */
export interface DbView {
  id: string
  name: string
  type: string
  /** kanban:分组列 id(select);chart:分组列 id(任意列);table:分组列 id(单选列 或 日期列)。缺 = 渲染端自动挑。 */
  groupBy?: string
  /** table 分组按**日期列**时的键档位:'day' = 落盘串前 10 位 `YYYY-MM-DD`,'month' = 前 7 位 `YYYY-MM`;
   *  缺 = day。单选列分组忽略本字段(纯逻辑 db/groupDate.ts)。 */
  groupUnit?: 'day' | 'month'
  /** table 层级树(2.9):自指关联列 id(type='rowlink' 且 refDb 指向本表,cell = 父行 id)。
   *  存在 = 表格体按父子缩进渲染;**孤儿(父行被筛掉/已删)当根**,树照常;环 / 超深 / 重复行 id 才整表退回平铺
   *  (纯逻辑 db/tree.ts buildTree —— 判据与理由以那份文件头为准,别在这儿各写一份)。
   *  与 groupBy 互斥,树优先(渲染端;菜单里分组区会灰掉)。 */
  treeCol?: string
  /** chart:图形(bar/line/donut);未知值渲染端回退 bar,不丢配置。 */
  chartKind?: string
  /** chart:聚合方式(count/sum/avg);缺 = count。 */
  agg?: string
  /** chart:聚合数值列 id(agg=sum/avg 时用;缺失或列已删 = 回退 count)。 */
  valueCol?: string
  /** calendar:日期列 id(基类 date 或 calendarDate);缺 = 自动挑第一个日期列。 */
  dateCol?: string
  /** 每视图筛选(全部满足才显示);缺 = 不筛。 */
  filters?: DbViewFilter[]
  /** 筛选逻辑:'or' = 任一条件满足;缺/其他 = 全部满足(AND)。 */
  filterMode?: string
  /** 每视图排序(落盘持久,不再是临时视图态);缺 = 文件行序。 */
  sort?: { colId: string; dir: 'asc' | 'desc' }
  /** 多列排序(按序逐层比较);写端保持 sort = sorts[0] 镜像(旧应用只认 sort,读端优先 sorts)。 */
  sorts?: Array<{ colId: string; dir: 'asc' | 'desc' }>
  /** 本视图隐藏的列 id(首列身份列不可隐藏,渲染端强制)。 */
  hidden?: string[]
  /** 本视图独立列序(列 id 序;缺 = 跟全局 columns 数组序)。解析规则(db/viewCols.ts orderColumns):
   *  首列(columns[0],标题列)恒在 0 位、不受本字段影响;没提到的列按全局序补在后;已不存在的列 id 忽略。
   *  存在即「拖表头调列序」写这里而不写 columns;与 widths 由同一个开关一起开/关。 */
  order?: string[]
  /** 本视图独立列宽(colId → px;缺 = 跟全局 column.width)。**存在即整体替代**全局宽:视图里没条目的列一律弹性,
   *  不回落 column.width(否则独立视图里双击复位又把全局宽请回来)。`{}` 是合法的「开了但没拖过」态,不是空值。 */
  widths?: Record<string, number>
  /** 表格视图页脚统计:colId → 统计方式(count/sum/avg/min/max/checked/unchecked)。 */
  stats?: Record<string, string>
  /** form(表单视图,type='form'):字段集 = columns 序 − hidden − 计算列 − 盖章列(渲染端算,不落盘);
   *  提交 = 一次 addRow(整行一个 mutate / 一次落盘 / 引擎一次 row_added)。 */
  form?: DbViewForm
  /** gantt(甘特视图,type='gantt'):横条的起止列与缩放;只读 v1(无拖拽改期)。 */
  gantt?: DbViewGantt
}

/** 甘特视图配置(DbView.gantt)。键指列 id,只认 calendarDate 列;指向不存在/非 calendarDate 列的项渲染端一律回落(不报错)。 */
export interface DbViewGantt {
  /** 开始列 id;缺 = 第一个 calendarDate 列。单元格是区间(`a/b`)且 endCol 缺/同列时,条从 a 铺到 b。 */
  startCol?: string
  /** 结束列 id;缺 = startCol(单日值 → 一天宽的条)。 */
  endCol?: string
  /** 时间轴刻度;缺 = day。 */
  scale?: 'day' | 'week'
}

/** 表单视图配置(DbView.form)。键都指列 id;指向不存在/隐藏/计算/盖章列的项渲染端一律忽略(不报错)。 */
export interface DbViewForm {
  /** 必填列 id;为空(空串/空数组/null/缺)不提交。 */
  required?: string[]
  /** 默认值(colId → 值),打开表单即预填;⚠️ 不得含盖章列/计算列(UI 不给选,addRow 里盖章压最后、提交前再剥一次)。 */
  defaults?: Record<string, CellValue>
  /** 每字段说明文案(colId → 文案)。 */
  desc?: Record<string, string>
  /** 表单标题;缺 = 视图名。 */
  title?: string
  /** 提交按钮文案;缺 = 「提交」。 */
  submitText?: string
  /** 提交后:stay = 留在表单并清空(缺省);table = 跳到本库第一个表格视图。 */
  after?: 'stay' | 'table'
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
  /** 命名视图列表;缺 = 单「表格」默认视图(旧文件零迁移,首次增改视图时才物化)。 */
  views?: DbView[]
}

/** 用户可选的列类型(picker 列表)。'page' 不在内:它是笔记视图自动创建的唯一身份列(Page Name),系统专用。 */
export const COLUMN_TYPES: ColumnType[] = ['text', 'number', 'checkbox', 'date', 'select', 'multiselect', 'url']

/** 笔记视图内置身份列的 id(= cell key);单元格值 = 笔记标题/文件名。一张视图至多一个。 */
export const PAGE_NAME_KEY = '__page_name'

const cellValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()])
/** 视图筛选 / 关联候选限定(DbColumn.refFilter)共用同一条件形状:单源,别各写各的。 */
const dbViewFilterSchema = z.object({ colId: z.string().min(1), op: z.string().min(1), value: cellValueSchema.optional() })
const dbColumnSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  // 放行任意非空 type 字符串:插件注册的自定义类型(渲染层折算成 baseType)才能写盘不被拒。
  // 值本身仍由 cellValueSchema 严格校验,未知类型只会渲染回退为文本,不丢数据。
  type: z.string().min(1),
  options: z.array(z.string()).optional(),
  width: z.number().positive().optional(),
  formula: z.string().optional(),
  refDb: z.string().optional(),
  // ⚠️ z.object 默认 strip 未知键:DbColumn 接口新增字段必须同步加到这里,否则读端 parseDb
  // 与写端 dbFileSchema.parse 各剥一次 → 用户开的配置保存即丢、零报错(schema.test 的往返用例会抓)。
  multiple: z.boolean().optional(),
  titleCol: z.string().optional(),
  refFilter: z.array(dbViewFilterSchema).optional(),
  refFilterMode: z.enum(['and', 'or']).optional(),
  lookupRel: z.string().optional(),
  lookupBackCol: z.string().optional(),
  lookupCol: z.string().optional(),
  lookupAgg: z.string().optional(),
  lookupKind: z.enum(['links']).optional(),
  prefix: z.string().optional(),
  // 数字显示格式(接口 DbColumn.precision / unitPrefix / unitSuffix;strip 陷阱同上)。
  // precision 是整数且夹在 [0,6]:超界的配置一律拒进(渲染端 clampPrecision 再兜一层,坏文件不至于崩 Intl)。
  precision: z.number().int().min(0).max(6).optional(),
  unitPrefix: z.string().optional(),
  unitSuffix: z.string().optional(),
})
const dbRowSchema = z.object({
  id: z.string().min(1),
  cells: z.record(z.string(), cellValueSchema),
})
const dbViewSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  type: z.string().min(1), // 未知类型放行:渲染端回退表格,不丢配置
  groupBy: z.string().optional(),
  // 表格日期分组档位 / 表格层级树列(接口 DbView.groupUnit / treeCol;strip 陷阱同上,漏这里 = 菜单一选保存即丢)
  groupUnit: z.enum(['day', 'month']).optional(),
  treeCol: z.string().optional(),
  chartKind: z.string().optional(),
  agg: z.string().optional(),
  valueCol: z.string().optional(),
  dateCol: z.string().optional(),
  filters: z.array(dbViewFilterSchema).optional(),
  filterMode: z.string().optional(),
  sort: z.object({ colId: z.string().min(1), dir: z.enum(['asc', 'desc']) }).optional(),
  sorts: z.array(z.object({ colId: z.string().min(1), dir: z.enum(['asc', 'desc']) })).optional(),
  hidden: z.array(z.string()).optional(),
  // 每视图列序 / 列宽(接口 DbView.order / widths;strip 陷阱同上,漏这里 = 开关一开保存即丢)
  order: z.array(z.string()).optional(),
  widths: z.record(z.string(), z.number().positive()).optional(),
  stats: z.record(z.string(), z.string()).optional(),
  // 表单视图嵌套配置:接口 DbViewForm 加字段必须同步到这里(strip 陷阱同上)。
  form: z.object({
    required: z.array(z.string()).optional(),
    defaults: z.record(z.string(), cellValueSchema).optional(),
    desc: z.record(z.string(), z.string()).optional(),
    title: z.string().optional(),
    submitText: z.string().optional(),
    after: z.enum(['stay', 'table']).optional(),
  }).optional(),
  // 甘特视图嵌套配置:接口 DbViewGantt 加字段必须同步到这里(strip 陷阱同上)。
  gantt: z.object({
    startCol: z.string().optional(),
    endCol: z.string().optional(),
    scale: z.enum(['day', 'week']).optional(),
  }).optional(),
})
export const dbFileSchema = z.object({
  version: z.number().int().min(1),
  name: z.string(),
  source: z.object({ folder: z.string() }).optional(),
  columns: z.array(dbColumnSchema),
  rows: z.array(dbRowSchema),
  views: z.array(dbViewSchema).optional(),
})

/** 短随机 id(列/行):8 位 base36,表格规模下碰撞可忽略。 */
export const dbId = (): string => Math.random().toString(36).slice(2, 10)

/** 隐式默认视图:views 缺/空 = 单「表格」(旧文件零迁移;首次增改视图时才物化)。 */
export const DEFAULT_DB_VIEW: DbView = { id: 'v-default', name: '表格', type: 'table' }
export const viewsOf = (d: DbFile): DbView[] => (d.views?.length ? d.views : [DEFAULT_DB_VIEW])

/** 读端排序解析:sorts 优先,回落单列 sort(写端保持 sort = sorts[0] 镜像,旧应用仍可读)。 */
export const sortsOf = (v: DbView): Array<{ colId: string; dir: 'asc' | 'desc' }> =>
  v.sorts?.length ? v.sorts : v.sort ? [v.sort] : []

/** 新数据库种子:1 个文本列 + 1 个空行(创建即可打字,不是空壳)。 */
export function emptyDb(name: string): DbFile {
  return {
    version: DB_VERSION,
    name,
    // 默认「标题 + 文本」两列:只给一列身份列的话,新建的表第一件事永远是手动加一列
    // 才能记点东西。首列恒为身份列(columns[0]),第二列给正文。
    columns: [
      { id: dbId(), name: '标题', type: 'text' },
      { id: dbId(), name: '文本', type: 'text' },
    ],
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
 *  首启即让 Calendar Space 有内容。type 用注册类型字符串(依赖 DbColumn.type: string + zod z.string())。
 *
 *  ⚠️ 日期必须**相对播种当天**算,不能写死绝对日期:待办视图的「逾期」桶恒展开置顶且不受任何
 *  窗口裁剪,写死的种子过几周就变成用户打开应用第一眼看到的「逾期 53 天 欢迎使用 Calendar Space」——
 *  红色是这个面板最稀缺的信号,不能让给内置演示数据。 */
export function seedCalendarDb(today = new Date()): DbFile {
  const nameId = dbId()
  const dateId = dbId()
  const doneId = dbId()
  const day = (n: number): string => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + n)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  return {
    version: DB_VERSION,
    name: '我的日历',
    columns: [
      { id: nameId, name: '名称', type: 'text' },
      { id: dateId, name: '日期', type: 'calendarDate' },
      { id: doneId, name: '完成', type: 'checkbox' },
    ],
    rows: [
      { id: dbId(), cells: { [nameId]: '欢迎使用 Calendar Space', [dateId]: `${day(0)}T10:00/${day(0)}T11:00`, [doneId]: true } },
      { id: dbId(), cells: { [nameId]: '整理本周任务', [dateId]: day(1) } },
      { id: dbId(), cells: { [nameId]: '项目评审', [dateId]: `${day(2)}T14:00/${day(2)}T15:30` } },
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
