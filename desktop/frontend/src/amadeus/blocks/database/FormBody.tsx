/**
 * 表单视图体(view.type='form'):字段纵排,填一份本地草稿,提交 = **一次** addRow(draft)
 * (整行一个 mutate / 一次落盘 / 引擎一次 row_added;绝不 addRow 后逐 setCell)。
 *
 * 单元格复用表格同款 <Cell>(照 RowEditor 那条路,不造第三个分发点)—— Cell / OptionsPop / CellEnv
 * 都是 DatabaseEmbed 的模块私有,这里经 renderCell / renderOptions 回调拿到,别反向 import 成环。
 * 字段集 / 必填 / 清洗的规则全在 formLogic.ts(纯逻辑,有单测)。
 */
import { useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import type { CellValue, DbColumn, DbFile, DbRow, DbView } from '@amadeus-shared/db/schema'
import { cleanDraft, formDefaults, formFields, missingRequired } from './formLogic'
import { resolveBaseType } from './propertyTypes'
import { registerMessages, useI18n } from '../../../i18n'
import './formBody.css'

registerMessages({
  'dbform.noFields': { zh: '没有可填写的字段(计算列与自动编号/创建时间不进表单)。', en: 'No fillable fields — formula, auto-number and created-time columns never appear in a form.' },
  'dbform.required': { zh: '必填', en: 'Required' },
  'dbform.submit': { zh: '提交', en: 'Submit' },
  'dbform.done': { zh: '已提交 {n} 条', en: '{n} submitted' },
  'dbform.defaultUnsupported': { zh: '默认值:不支持', en: 'Default value: not supported' },
  'dbform.defaultChecked': { zh: '默认勾选', en: 'Checked by default' },
  'dbform.defaultValue': { zh: '默认值', en: 'Default value' },
  'dbform.defaultNone': { zh: '默认值:无', en: 'Default value: none' },
  'dbform.defaultCsv': { zh: '默认值(逗号分隔)', en: 'Default value (comma-separated)' },
})

export type FormSetCell = (rowId: string, colId: string, v: CellValue | undefined) => void
/** 草稿行的 id(Cell 的 setCell 契约带 rowId;草稿只有这一行,值不落盘)。 */
export const FORM_DRAFT_ROW_ID = '__form_draft'

export function FormBody({ db, view, renderCell, renderOptions, colIcon, onSubmit, onGoTable }: {
  db: DbFile
  view: DbView
  /** 渲染一格(DatabaseEmbed 里包一层 <Cell>)。 */
  renderCell: (row: DbRow, col: DbColumn, setCell: FormSetCell, openOptions: (e: ReactMouseEvent) => void) => ReactNode
  /** select/多选的选项弹层(DatabaseEmbed 里包一层 <OptionsPop>)。 */
  renderOptions: (p: { col: DbColumn; row: DbRow; x: number; y: number; setCell: FormSetCell; onClose: () => void }) => ReactNode
  colIcon: (type: string) => ReactNode
  /** 提交:调用方就是 addRow(draft),盖章在它里面压最后。 */
  onSubmit: (draft: Record<string, CellValue>) => void
  /** after='table' 时跳到本库第一个表格视图。 */
  onGoTable: () => void
}) {
  const { t } = useI18n()
  const fields = formFields(db.columns, view)
  const cfg = view.form ?? {}
  const [draft, setDraft] = useState<Record<string, CellValue>>(() => formDefaults(view, fields))
  const [errs, setErrs] = useState<Set<string>>(new Set())
  const [done, setDone] = useState(0) // 本次挂载已提交条数(留在表单时给个回执)
  const [opt, setOpt] = useState<{ colId: string; x: number; y: number } | null>(null)
  const row: DbRow = { id: FORM_DRAFT_ROW_ID, cells: draft }
  const optCol = opt ? fields.find((c) => c.id === opt.colId) : undefined

  // Cell 清空一格给的是 undefined:必须 delete 键,存成 { k: undefined } 会让写盘校验静默拒掉整行。
  const setCell: FormSetCell = (_rowId, colId, v) => {
    setDraft((d) => {
      const n = { ...d }
      if (v === undefined) delete n[colId]
      else n[colId] = v
      return n
    })
    if (errs.has(colId)) setErrs((e) => { const n = new Set(e); n.delete(colId); return n })
  }
  const submit = (): void => {
    const miss = missingRequired(fields, cfg.required, draft)
    if (miss.length) { setErrs(new Set(miss.map((c) => c.id))); return }
    onSubmit(cleanDraft(draft, fields))
    // 先清草稿再跳:库里没有表格视图时 onGoTable 是空操作,表单仍挂着,留着刚提交的值 = 再点一下就重复建行
    setDraft(formDefaults(view, fields))
    setErrs(new Set())
    setDone((n) => n + 1)
    if (cfg.after === 'table') onGoTable()
  }

  if (!fields.length) return <div className="amx-db-state">{t('dbform.noFields')}</div>
  const required = new Set(cfg.required ?? [])
  return (
    <div className="amx-db-form" data-view={view.id}>
      <div className="amx-db-form-title">{cfg.title?.trim() || view.name}</div>
      {fields.map((col) => {
        const bad = errs.has(col.id)
        return (
          <div key={col.id} className="amx-db-form-field" data-col={col.id} data-required={required.has(col.id) || undefined} data-err={bad || undefined}>
            <span className="amx-db-form-label">
              <span className="amx-db-th-icon" aria-hidden>{colIcon(col.type)}</span>
              {col.name}
              {required.has(col.id) && <span className="amx-db-form-req" aria-label={t('dbform.required')}>*</span>}
            </span>
            {cfg.desc?.[col.id] && <span className="amx-db-form-desc">{cfg.desc[col.id]}</span>}
            <div className="amx-db-form-cell">
              {renderCell(row, col, setCell, (e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                setOpt({ colId: col.id, x: Math.min(r.left, window.innerWidth - 250), y: Math.min(r.bottom + 4, window.innerHeight - 260) })
              })}
            </div>
            {bad && <span className="amx-db-form-err">{t('dbform.required')}</span>}
          </div>
        )
      })}
      <div className="amx-db-form-foot">
        <button className="amx-db-newbtn amx-db-form-submit" onClick={submit}>{cfg.submitText?.trim() || t('dbform.submit')}</button>
        {done > 0 && <span className="amx-db-form-done">{t('dbform.done', { n: done })}</span>}
      </div>
      {opt && optCol && renderOptions({ col: optCol, row, x: opt.x, y: opt.y, setCell, onClose: () => setOpt(null) })}
    </div>
  )
}

/** 视图菜单里的「默认值」编辑:按列基类给最朴素的控件(勾选/数字/日期/单选/文本;多选按逗号拆)。
 *  值语义与 coerceForDisplay 同款。ponytail: 关联表/附件列不给默认值(picker 太重,表单里现选)。 */
export function FormDefaultInput({ col, value, onChange }: { col: DbColumn; value: CellValue | undefined; onChange: (v: CellValue | undefined) => void }) {
  const { t } = useI18n()
  const base = resolveBaseType(col.type)
  const blurEnter = (e: KeyboardEvent<HTMLInputElement>): void => { if (e.key === 'Enter') e.currentTarget.blur() }
  if (col.type === 'rowlink' || col.type === 'file') return <span className="amx-db-blank amx-db-formcfg-na">{t('dbform.defaultUnsupported')}</span>
  const k = JSON.stringify(value ?? null) // 外部值变了(切视图 / 别处改)重置非受控输入
  switch (base) {
    case 'checkbox':
      return <label className="amx-db-formcfg-chk"><input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked ? true : undefined)} /> {t('dbform.defaultChecked')}</label>
    case 'number':
      return <input key={k} type="number" className="amx-db-pop-input" placeholder={t('dbform.defaultValue')} defaultValue={typeof value === 'number' ? value : ''} onKeyDown={blurEnter}
        onBlur={(e) => { const n = Number.parseFloat(e.target.value); onChange(Number.isFinite(n) ? n : undefined) }} />
    case 'date':
      return <input key={k} type="date" className="amx-db-pop-input" defaultValue={typeof value === 'string' ? value : ''} onKeyDown={blurEnter}
        onBlur={(e) => onChange(e.target.value || undefined)} />
    case 'select':
      return (
        <select className="amx-db-pop-input" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value || undefined)}>
          <option value="">{t('dbform.defaultNone')}</option>
          {(col.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      )
    case 'multiselect':
      return <input key={k} className="amx-db-pop-input" placeholder={t('dbform.defaultCsv')} defaultValue={Array.isArray(value) ? value.join(', ') : ''} onKeyDown={blurEnter}
        onBlur={(e) => { const arr = e.target.value.split(/[,，]/).map((x) => x.trim()).filter(Boolean); onChange(arr.length ? arr : undefined) }} />
    default:
      return <input key={k} className="amx-db-pop-input" placeholder={t('dbform.defaultValue')} defaultValue={typeof value === 'string' ? value : ''} onKeyDown={blurEnter}
        onBlur={(e) => onChange(e.target.value.trim() || undefined)} />
  }
}
