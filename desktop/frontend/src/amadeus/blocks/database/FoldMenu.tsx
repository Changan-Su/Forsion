/** 规则行折叠(DbView.fold)的两块界面:视图条上的「行折叠」设置弹层 + 汇总行里的「混合值」单元格。
 *  纯逻辑在 shared/db/foldRows.ts;DatabaseEmbed 只负责接线(管道 / 汇总行 / 展开态)。 */
import type { ReactNode } from 'react'
import { FOLD_DEFAULT_MINUTES, foldMinutesOf, type FoldMixedValue } from '@amadeus-shared/db/foldRows'
import type { CellValue, DbColumn, DbView, DbViewFold } from '@amadeus-shared/db/schema'
import { registerMessages, useI18n } from '../../../i18n'
import './grouping.css'
import './foldRows.css'

registerMessages({
  'dbfold.title': { zh: '行折叠', en: 'Fold rows' },
  'dbfold.hint': { zh: '键相同的行收成一条汇总行：数字求和，不同的值列出内容；点汇总行展开。', en: 'Rows with the same key collapse into one summary row: numbers are summed, differing values are listed. Click a summary row to expand it.' },
  'dbfold.by': { zh: '折叠键（值相同才折）', en: 'Fold key (same value)' },
  'dbfold.time': { zh: '时间窗列', en: 'Time window column' },
  'dbfold.timeNone': { zh: '不按时间', en: 'None' },
  'dbfold.minutes': { zh: '时间窗（分钟）', en: 'Window (minutes)' },
  'dbfold.off': { zh: '关闭行折叠', en: 'Turn off folding' },
  'dbfold.blocked': { zh: '层级视图下不折叠（父子缩进优先）', en: 'Not available while the hierarchy is on' },
  'dbfold.noCols': { zh: '没有可用的列', en: 'No columns available' },
  'dbfold.expand': { zh: '展开全部', en: 'Expand all' },
  'dbfold.collapse': { zh: '折叠全部', en: 'Collapse all' },
  'dbfold.count': { zh: '{n} 行', en: '{n} rows' },
  'dbfold.toggle': { zh: '展开 / 收起这 {n} 行', en: 'Expand / collapse these {n} rows' },
  'dbfold.more': { zh: '等 {n} 项', en: '+{n} more' },
})

/** 写回视图的规则:by 与 timeCol 都空 = 整个字段清掉(别留一个 `{}` 让「开没开」靠键数判)。 */
const cleanFold = (f: DbViewFold): DbViewFold | undefined => {
  const by = (f.by ?? []).filter(Boolean)
  if (!by.length && !f.timeCol) return undefined
  return { ...(by.length ? { by } : {}), ...(f.timeCol ? { timeCol: f.timeCol, minutes: foldMinutesOf(f) } : {}) }
}

export function FoldMenu({ view, keyCols, timeCols, blocked, onPatch, onExpandAll }: {
  view: DbView
  /** 可当折叠键的列(与属性分组同一批可比类型)。 */
  keyCols: DbColumn[]
  /** 可当时间窗的列(日期系)。 */
  timeCols: DbColumn[]
  /** 层级树开着:折叠不生效,只写明理由,**不悄悄清掉配置**(关掉层级后原样回来)。 */
  blocked?: boolean
  onPatch: (patch: Partial<DbView>) => void
  onExpandAll: (expand: boolean) => void
}) {
  const { t } = useI18n()
  const fold = view.fold ?? {}
  const by = fold.by ?? []
  const set = (next: DbViewFold): void => onPatch({ fold: cleanFold(next) })
  const on = !!cleanFold(fold)
  return (
    <div className="amx-db-group-menu amx-db-fold-menu">
      <strong>{t('dbfold.title')}</strong>
      <div className="amx-db-fold-hint">{blocked ? t('dbfold.blocked') : t('dbfold.hint')}</div>
      <div className="amx-db-pop-sec">{t('dbfold.by')}</div>
      <div className="amx-db-group-options">
        {keyCols.filter((c) => c.id !== fold.timeCol).map((c) => {
          const picked = by.includes(c.id)
          return (
            <label key={c.id} className="amx-db-group-option" data-fold-key={c.id}>
              <input type="checkbox" checked={picked} onChange={() => set({ ...fold, by: picked ? by.filter((x) => x !== c.id) : [...by, c.id] })} />
              <span className="amx-db-group-option-name" title={c.name}>{c.name}</span>
            </label>
          )
        })}
        {keyCols.length === 0 && <div className="amx-db-blank">{t('dbfold.noCols')}</div>}
      </div>
      <label className="amx-db-group-setting">{t('dbfold.time')}
        <select aria-label={t('dbfold.time')} value={fold.timeCol ?? ''}
          onChange={(e) => set({ ...fold, timeCol: e.target.value || undefined, by: by.filter((x) => x !== e.target.value) })}>
          <option value="">{t('dbfold.timeNone')}</option>
          {timeCols.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      {fold.timeCol && (
        <label className="amx-db-group-setting">{t('dbfold.minutes')}
          {/* defaultValue + blur 提交:受控数字框在清空重打的半路会被回落值顶回去 */}
          <input className="amx-db-fold-minutes" type="number" min={1} step={5} aria-label={t('dbfold.minutes')}
            key={foldMinutesOf(fold)} defaultValue={foldMinutesOf(fold)}
            onBlur={(e) => { const n = Number(e.target.value); set({ ...fold, minutes: Number.isFinite(n) && n > 0 ? n : FOLD_DEFAULT_MINUTES }) }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
        </label>
      )}
      {on && !blocked && (
        <div className="amx-db-group-bulk">
          <button onClick={() => onExpandAll(true)}>{t('dbfold.expand')}</button>
          <button onClick={() => onExpandAll(false)}>{t('dbfold.collapse')}</button>
        </div>
      )}
      {on && <button className="amx-db-opt amx-db-opt-clear" onClick={() => onPatch({ fold: undefined })}>{t('dbfold.off')}</button>}
    </div>
  )
}

const MIXED_MAX = 4

/** 「混合值」格的文案拆解(渲染与自适应列宽共用一份 —— 两处各拼各的,列宽就会按另一段文字估)。
 *  date → 一段「最早 – 最晚」(同日后半只留时刻);其余 → 前 4 种值(带次数)+ 剩余种数。 */
export function foldMixedParts(kind: string, values: FoldMixedValue[], label: (m: FoldMixedValue) => string): { range?: { text: string; full: string }; parts: string[]; rest: number } {
  if (kind === 'date') {
    const dated = values.filter((m) => m.value !== null && m.value !== '')
    if (!dated.length) return { parts: [], rest: 0 }
    const a = label(dated[0])
    const b = label(dated[dated.length - 1])
    // 「2026-09-21 14:03 – 2026-09-21 14:27」同一天:后半只留时刻
    const sameDay = a.length > 11 && b.length > 11 && a.slice(0, 11) === b.slice(0, 11)
    return { range: { text: a === b ? a : `${a} – ${sameDay ? b.slice(11) : b}`, full: `${a} – ${b}` }, parts: [], rest: 0 }
  }
  const withCount = (m: FoldMixedValue): string => (m.count > 1 ? `${label(m)} ×${m.count}` : label(m))
  return { parts: values.slice(0, MIXED_MAX).map(withCount), rest: Math.max(0, values.length - MIXED_MAX) }
}

/** 汇总行里「成员值不止一种」的那一格:列出包含的内容(带次数)。日期画「最早 – 最晚」;
 *  单选 / 勾选画芯片,色调借样本成员行的宿主装饰(toneOf)。超过 4 种收成「等 N 项」,全量在 title 里。 */
export function FoldMixedCell({ kind, values, fmt, toneOf }: {
  kind: string
  values: FoldMixedValue[]
  fmt: (v: CellValue, rowId: string) => string
  toneOf?: (rowId: string) => string | undefined
}) {
  const { t } = useI18n()
  const label = (m: FoldMixedValue): string => fmt(m.value, m.rowId) || t('dbgroup.empty')
  const { range, parts, rest } = foldMixedParts(kind, values, label)
  if (kind === 'date') {
    if (!range) return <span className="amx-db-blank">{t('dbembed.blank')}</span>
    return <span className="amx-db-rocell amx-db-foldmixed" title={range.full}><span className="amx-db-rotext"><span className="amx-db-roprimary">{range.text}</span></span></span>
  }
  const title = values.map((m) => (m.count > 1 ? `${label(m)} ×${m.count}` : label(m))).join('\n')
  const chip = kind === 'select' || kind === 'checkbox'
  const nodes: ReactNode[] = parts.map((text, i) => (chip
    ? <span key={i} className={`amx-db-chip amx-db-chip--${toneOf?.(values[i].rowId) ?? 'muted'}`}>{text}</span>
    : <span key={i} className="amx-db-foldval">{text}{i < parts.length - 1 || rest > 0 ? ' · ' : ''}</span>))
  return (
    <span className="amx-db-rocell amx-db-foldmixed" title={title} data-mixed={values.length}>
      <span className="amx-db-rotext"><span className="amx-db-roprimary">
        {nodes}
        {rest > 0 && <span className="amx-db-foldmore">{t('dbfold.more', { n: rest })}</span>}
      </span></span>
    </span>
  )
}
