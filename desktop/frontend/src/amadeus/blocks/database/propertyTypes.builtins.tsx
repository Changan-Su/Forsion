/** 内置属性类型:todo(勾选,但仅被 ToDo List View 识别)+ calendarDate(带时刻/起止的日期,被 Calendar View 识别)
 *  + relation(关联页面,存 [[链接]])+ autonumber(自动编号,建行时 max+1)+ created(创建时间,建行时盖章)
 *  + person(人员,值 = 显示名,Cell/候选集合住 PersonCell.tsx)。
 *  经属性注册表注册(与三方插件同一入口),自我 dogfood 该 API。
 *  side-effect import 于 bootstrap,始终在场(视图依赖它们,故不做成可禁用插件)。 */
import { useState, type MouseEvent as ReactMouseEvent } from 'react'
import { parseCalDate, splitSide } from '@amadeus-shared/db/calDate'
import { fmtCalDateL } from '@amadeus/lib/calDateFmt'
import { pageKey } from '@amadeus-shared/links'
import { fuzzyScore } from '../../lib/fuzzy'
import { usePageStore } from '../../store/pageStore'
import { CheckBoxCheckSolidIcon, DateTimeIcon, LinkedPageIcon, NumberIcon, TodayIcon } from '../../components/icons'
import { registerPropertyType, type PropCellProps } from './propertyTypes'
import { OverlayAt } from '../../lib/clampMenu'
import { User } from 'lucide-react'
import { PersonCell, PERSON_TYPE } from './PersonCell'
import { registerMessages, useI18n } from '../../../i18n'
export { isPersonCol, personCandidates, PERSON_TYPE } from './PersonCell'

registerMessages({
  // 单元格 / 弹层文案
  'dbbuiltins.date': { zh: '日期', en: 'Date' },
  'dbbuiltins.end': { zh: '结束', en: 'End' },
  'dbbuiltins.allDayHint': { zh: '留空 = 全天', en: 'Leave blank for all day' },
  'dbbuiltins.setEnd': { zh: '设置结束时间', en: 'Set end time' },
  'dbbuiltins.empty': { zh: '空', en: 'Empty' },
  'dbbuiltins.clear': { zh: '清空', en: 'Clear' },
  'dbbuiltins.changeRelation': { zh: '更换关联页面', en: 'Change linked page' },
  'dbbuiltins.searchPages': { zh: '搜索页面…', en: 'Search pages…' },
  'dbbuiltins.noMatch': { zh: '无匹配页面', en: 'No matching pages' },
  'dbbuiltins.clearRelation': { zh: '清空关联', en: 'Clear relation' },
  // 属性类型显示名(见文末 registerBuiltinPropertyTypes 的说明:label 位置放的是 i18n 键)
  'dbbuiltins.type.todo': { zh: '待办', en: 'To-do' },
  'dbbuiltins.type.calendarDate': { zh: '日期', en: 'Date' },
  'dbbuiltins.type.relation': { zh: '关联', en: 'Relation' },
  'dbbuiltins.type.autonumber': { zh: '自动编号', en: 'Auto-number' },
  'dbbuiltins.type.created': { zh: '创建时间', en: 'Created time' },
})

// ── todo:baseType=checkbox,渲染同勾选框 ──────────────────────────────────────
function TodoCell({ value, onChange }: PropCellProps) {
  return (
    <input
      className="amx-db-checkbox"
      type="checkbox"
      checked={value === true}
      onChange={(e) => onChange(e.target.checked ? true : undefined)}
    />
  )
}

// ── calendarDate:baseType=text,存 `start[/end]`,每侧 = 日期 [+ 可选时间] ────────
/** 日期(必填)+ 时间(可选,留空=全天)+ 可选结束。直接契合「可设时间可不设,不设=全天」。 */
export function CalDateFields({ value, onChange, autoFocus }: { value: string | null; onChange(v: string | undefined): void; autoFocus?: boolean }) {
  const { t } = useI18n()
  const cur = parseCalDate(value ?? '')
  const s = cur ? splitSide(cur.start) : { date: '', time: '' }
  const e = cur?.end ? splitSide(cur.end) : null
  const hasEnd = !!cur?.end

  const build = (sDate: string, sTime: string, eDate: string, eTime: string, withEnd: boolean): void => {
    if (!sDate) return onChange(undefined) // 无日期 = 清空
    const start = sTime ? `${sDate}T${sTime}` : sDate
    if (withEnd && eDate) {
      const end = eTime ? `${eDate}T${eTime}` : eDate
      return onChange(`${start}/${end}`)
    }
    onChange(start)
  }

  return (
    <>
      <label className="amx-cal-row">
        <span>{t('dbbuiltins.date')}</span>
        <input type="date" value={s.date} autoFocus={autoFocus} onChange={(ev) => build(ev.target.value, s.time, e?.date ?? s.date, e?.time ?? '', hasEnd)} />
        <input type="time" className="amx-cal-timein" value={s.time} title={t('dbbuiltins.allDayHint')} onChange={(ev) => build(s.date, ev.target.value, e?.date ?? s.date, e?.time ?? '', hasEnd)} />
      </label>
      {hasEnd && (
        <label className="amx-cal-row">
          <span>{t('dbbuiltins.end')}</span>
          <input type="date" value={e?.date ?? s.date} onChange={(ev) => build(s.date, s.time, ev.target.value, e?.time ?? s.time, true)} />
          <input type="time" className="amx-cal-timein" value={e?.time ?? ''} title={t('dbbuiltins.allDayHint')} onChange={(ev) => build(s.date, s.time, e?.date ?? s.date, ev.target.value, true)} />
        </label>
      )}
      <label className="amx-cal-check">
        <input
          type="checkbox"
          checked={hasEnd}
          onChange={(ev) => {
            if (!cur) return
            if (ev.target.checked) build(s.date, s.time, s.date, s.time, true) // 结束默认 = 开始
            else build(s.date, s.time, '', '', false)
          }}
        />{' '}
        {t('dbbuiltins.setEnd')}
      </label>
    </>
  )
}

function CalendarDateCell({ value, onChange }: PropCellProps) {
  const { t } = useI18n()
  const raw = typeof value === 'string' ? value : ''
  const cur = parseCalDate(raw)
  const [pos, setPos] = useState<{ x: number; y: number; anchorTop: number } | null>(null)
  // 交按钮下沿 + 上沿,不预夹(预夹会让 OverlayAt 误判锚点再翻面,codex#2)
  const open = (e: ReactMouseEvent): void => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setPos({ x: r.left, y: r.bottom + 4, anchorTop: r.top })
  }
  return (
    <>
      <button className="amx-db-cellbtn" onClick={open}>
        {cur ? <span className="amx-cal-chip">{fmtCalDateL(cur)}</span> : <span className="amx-db-blank">{t('dbbuiltins.empty')}</span>}
      </button>
      {pos && (
        <div className="amx-db-popwrap" onMouseDown={() => setPos(null)}>
          <OverlayAt className="amx-db-pop amx-cal-pop" x={pos.x} y={pos.y} anchorTop={pos.anchorTop} onMouseDown={(e) => e.stopPropagation()}>
            <CalDateFields value={raw} onChange={onChange} autoFocus />
            {cur && (
              <button className="amx-db-opt amx-db-opt-clear" onClick={() => onChange(undefined)}>{t('dbbuiltins.clear')}</button>
            )}
          </OverlayAt>
        </div>
      )}
    </>
  )
}

// ── relation:baseType=text,存 `[[链接]]`(裸名或 dir/Name|Name);chip 点开笔记,✎ 换关联 ────
const REL_RE = /^\[\[([^\]\n]+)\]\]$/

function RelationCell({ value, onChange }: PropCellProps) {
  const { t } = useI18n()
  const raw = typeof value === 'string' ? value.trim() : ''
  const inner = REL_RE.exec(raw)?.[1] ?? ''
  const label = (inner.split('|')[1] ?? inner.split('|')[0] ?? '').trim()
  const [pos, setPos] = useState<{ x: number; y: number; anchorTop: number } | null>(null)
  const open = (e: ReactMouseEvent): void => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setPos({ x: r.left, y: r.bottom + 4, anchorTop: r.top })
  }
  return (
    <>
      {label ? (
        <div className="amx-db-urlcell">
          <button
            className="amx-db-wikilink"
            onClick={() => usePageStore.getState().openWikiLink(inner.split('|')[0].trim().replace(/\.md$/i, ''))}
            title={inner}
          >
            {label}
          </button>
          <button className="amx-db-edit" onClick={open} title={t('dbbuiltins.changeRelation')} aria-label="pick relation">✎</button>
        </div>
      ) : (
        <button className="amx-db-cellbtn" onClick={open}>
          {raw ? <span className="amx-db-urltext">{raw}</span> : <span className="amx-db-blank">{t('dbbuiltins.empty')}</span>}
        </button>
      )}
      {pos && (
        <RelationPicker
          x={pos.x}
          y={pos.y}
          anchorTop={pos.anchorTop}
          onClose={() => setPos(null)}
          onPick={(linkInner) => {
            onChange(linkInner ? `[[${linkInner}]]` : undefined)
            setPos(null)
          }}
        />
      )}
    </>
  )
}

/** 页面选择器:模糊搜索全库笔记,「唯一即最短」插入(与 [[ 补全同语义)。
 *  关联列与 text 单元格的 [[ 补全共用这一份 —— 别再复制一套搜索/重名消歧。 */
export function RelationPicker({ x, y, anchorTop, onPick, onClose }: {
  x: number
  y: number
  /** 触发按钮/输入框的上沿:下方放不下时浮层翻到它之上,不盖住源单元格(见 engine/menuAnchor)。 */
  anchorTop?: number
  onPick: (linkInner: string | null) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const [q, setQ] = useState('')
  const pages = usePageStore.getState().pages
  const base = (p: string): string => (p.split(/[\\/]/).pop() ?? p).replace(/\.md$/i, '')
  const dupes = new Map<string, number>()
  for (const p of pages) dupes.set(pageKey(base(p)), (dupes.get(pageKey(base(p))) ?? 0) + 1)
  const results = (q
    ? pages
        .map((p) => {
          const sName = fuzzyScore(q, base(p))
          const s = sName !== null ? sName + 1000 : fuzzyScore(q, p)
          return s === null ? null : { p, s }
        })
        .filter((x): x is { p: string; s: number } => x !== null)
        .sort((a, b) => b.s - a.s)
        .map((x) => x.p)
    : pages
  ).slice(0, 12)
  const linkInner = (p: string): string =>
    (dupes.get(pageKey(base(p))) ?? 0) > 1 ? `${p.replace(/\\/g, '/').replace(/\.md$/i, '')}|${base(p)}` : base(p)
  return (
    <div className="amx-db-popwrap" onMouseDown={onClose}>
      <OverlayAt className="amx-db-pop" x={x} y={y} anchorTop={anchorTop} onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="amx-db-pop-input"
          autoFocus
          placeholder={t('dbbuiltins.searchPages')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
            else if (e.key === 'Enter' && results[0]) onPick(linkInner(results[0]))
          }}
        />
        <div className="amx-db-pop-list">
          {results.map((p) => (
            <button key={p} className="amx-db-opt" onClick={() => onPick(linkInner(p))}>
              <span className="amx-db-relname">{base(p)}</span>
              <span className="amx-db-relpath">{p.replace(/\\/g, '/').split('/').slice(0, -1).join('/') || '/'}</span>
            </button>
          ))}
          {results.length === 0 && <div className="amx-db-blank">{t('dbbuiltins.noMatch')}</div>}
        </div>
        <button className="amx-db-opt amx-db-opt-clear" onClick={() => onPick(null)}>{t('dbbuiltins.clearRelation')}</button>
      </OverlayAt>
    </div>
  )
}

// ── autonumber:baseType=number,cell 存纯数字;显示 `column.prefix + 数字`(如 PC-12)。只读:不调 onChange ────
//    切类型不回填:已有行仍空,只有之后新建的行被盖章(与 Notion 一致)。
function AutoNumberCell({ value, column }: PropCellProps) {
  const { t } = useI18n()
  // value 已被 coerceForDisplay(number) 折算:空 = null 不是 ''
  if (typeof value !== 'number') return <span className="amx-db-blank">{t('dbbuiltins.empty')}</span>
  return <span className="amx-db-computed amx-db-autonum">{(column?.prefix ?? '') + value}</span>
}
/** 建行初值 = 表里已有编号的最大值 + 1(非数字 cell 忽略;空表 → 1)。 */
export const nextAutoNumber = (rows: { cells: Record<string, unknown> }[], colId: string): number =>
  Math.max(0, ...rows.map((r) => (typeof r.cells[colId] === 'number' ? (r.cells[colId] as number) : 0))) + 1

// ── created:baseType=text,存 `YYYY-MM-DDTHH:mm`(与 calendarDate 单侧串同款 → 能进日历、能按日期筛选;
//    DatabaseEmbed.isDateish / dbAggregateStore.isDateCol 点名认它)。只读:不调 onChange ────
/** 当前本地时刻 → `YYYY-MM-DDTHH:mm`(与 views/calendar/dateUtils.fmtStamp(d,false) 同格式;不反向 import 视图层)。 */
export const createdStamp = (d: Date = new Date()): string => {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
function CreatedCell({ value }: PropCellProps) {
  const { t } = useI18n()
  const raw = typeof value === 'string' ? value : ''
  if (!raw) return <span className="amx-db-blank">{t('dbbuiltins.empty')}</span>
  return <span className="amx-db-computed amx-db-created">{raw.replace('T', ' ')}</span>
}

/** 注册内置类型(bootstrap 期 side-effect import 触发一次)。
 *
 *  ⚠️ i18n:注册在**模块加载期**跑一次,写死的中文 label 会冻在那一刻、切语言不更新。所以内置类型的
 *  `label` 位置放的是 **i18n 键**,由唯一消费者 DatabaseEmbed.colMeta 原样转手给 `t(labelKey)` 在
 *  渲染时求值(t 查不到的键原样返回 —— 三方插件照旧直接写成品文案,两种形态都成立)。
 *  例外两个:person 的「人员」与 updated 的「修改时间」被 propertyTypes.builtins.test.ts 逐字断言
 *  (`expect(def.label).toBe('人员')`),换成键就红;那是测试侧的契约,等测试放宽后再一起改键。 */
let done = false
export function registerBuiltinPropertyTypes(): void {
  if (done) return
  done = true
  registerPropertyType({ type: 'todo', label: 'dbbuiltins.type.todo', icon: <CheckBoxCheckSolidIcon />, baseType: 'checkbox', Cell: TodoCell })
  registerPropertyType({
    type: 'calendarDate',
    label: 'dbbuiltins.type.calendarDate', // ponytail: 内部 id 仍 calendarDate(存储/迁移零改),用户只见「日期」= 标准富日期属性
    icon: <TodayIcon />,
    baseType: 'text',
    Cell: CalendarDateCell,
    sortValue: (v) => (typeof v === 'string' ? v : ''),
  })
  registerPropertyType({ type: 'relation', label: 'dbbuiltins.type.relation', icon: <LinkedPageIcon />, baseType: 'text', Cell: RelationCell })
  // ⚠️ 'autonumber' / 'created' 两个 id 与引擎 automation.ts 的 db_row_add 盖章是同名契约(propertyTypes.STAMPED_TYPES)
  registerPropertyType({
    type: 'autonumber',
    label: 'dbbuiltins.type.autonumber',
    icon: <NumberIcon />,
    baseType: 'number',
    Cell: AutoNumberCell,
    initialValue: ({ rows, column }) => nextAutoNumber(rows, column.id),
    sortValue: (v) => (typeof v === 'number' ? v : Number.NEGATIVE_INFINITY),
  })
  registerPropertyType({
    type: 'created',
    label: 'dbbuiltins.type.created',
    icon: <DateTimeIcon />,
    baseType: 'text',
    Cell: CreatedCell,
    initialValue: () => createdStamp(),
    sortValue: (v) => (typeof v === 'string' ? v : ''),
  })
  // updated(修改时间,2026-09-02):建行初值同 created;之后由 dbStore.mutate 对**内容真变了**的行重盖
  // (shared/amadeus/db/stamp.ts),引擎 automationDbAction 的 db_row_edit 同款。只读展示复用 CreatedCell。
  // ⚠️ 'updated' 同为引擎侧硬编码的同名契约(STAMPED_TYPES 三件)。
  registerPropertyType({
    type: 'updated',
    label: '修改时间', // ⚠️ 测试逐字断言(见文首 registerBuiltinPropertyTypes 注释),故未改成 i18n 键
    icon: <DateTimeIcon />,
    baseType: 'text',
    Cell: CreatedCell,
    initialValue: () => createdStamp(),
    sortValue: (v) => (typeof v === 'string' ? v : ''),
  })
  // person:值 = 显示名(baseType text,落盘/校验零改);候选 = 全库 person 列已用过的名字。Cell 与纯函数住 PersonCell.tsx
  registerPropertyType({
    type: PERSON_TYPE,
    label: '人员', // ⚠️ 同上:测试逐字断言 def.label === '人员'
    icon: <User size={14} />,
    baseType: 'text',
    Cell: PersonCell,
    sortValue: (v) => (typeof v === 'string' ? v : ''),
  })
}

registerBuiltinPropertyTypes()
