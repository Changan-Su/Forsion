/**
 * 页面级筛选栏 —— 一处改、全页跟随。
 *
 * 这条是「一屏挤了几个面板」与「**一个复合 view**」的分界线,所以它长在页面上,不长在任何一张卡里。
 *
 * 两个刻意的设计:
 *  · **按属性名筛,不按列 id**。一张仪表盘上的卡来自不同的 `.db`,列 id 各是各的;按名字找、
 *    找不到就那张卡不受这条影响(Notion global filter 同款规则,判定在 shared 层)。
 *  · **候选属性来自已经载入的那些 db**。不去扫全库 —— 你能筛的,就是这一页上真的有人在用的维度。
 */
import { useMemo, useState } from 'react'
import { Filter, Plus, X } from 'lucide-react'
import { useDbStore } from '@amadeus/store/dbStore'
import { resolveBaseType } from '@amadeus/blocks/database/propertyTypes'
import { FILTER_OPS, OP_LABEL, UNARY_OPS } from '@amadeus-shared/db/viewQuery'
import type { ColumnType } from '@amadeus-shared/db/schema'
import type { DashFilter } from '@amadeus-shared/dashboardData'
import { useEdgeNudge } from '@lcl/engine'
import { registerMessages, useI18n } from '../i18n'

registerMessages({
  'dashfilter.label': { zh: '筛选', en: 'Filter' },
  'dashfilter.remove': { zh: '去掉这条', en: 'Remove this filter' },
  'dashfilter.addTitle': { zh: '加一条筛选', en: 'Add a filter' },
  'dashfilter.noCards': { zh: '这一页还没有可筛的数据卡', en: 'No filterable data cards on this page yet' },
  'dashfilter.add': { zh: '加筛选', en: 'Add filter' },
  'dashfilter.pickOne': { zh: '选一个…', en: 'Pick one…' },
  'dashfilter.valuePlaceholder': { zh: '值', en: 'Value' },
  'dashfilter.commit': { zh: '加上', en: 'Add' },
})

interface PropOption {
  name: string
  kind: ColumnType
  options: string[]
}

/** 这一页上真的可筛的维度:已载入的每份 db 的列,按名字去重(同名不同类型 → 先到先得)。 */
function usePropOptions(): PropOption[] {
  const entries = useDbStore((s) => s.entries)
  return useMemo(() => {
    const byName = new Map<string, PropOption>()
    for (const e of Object.values(entries)) {
      if (e.status !== 'ok' || !e.data) continue
      for (const c of e.data.columns) {
        if (byName.has(c.name)) continue
        byName.set(c.name, { name: c.name, kind: resolveBaseType(c.type), options: c.options ?? [] })
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [entries])
}

export function DashFilterBar({ filters, editable, onChange }: {
  filters: DashFilter[]
  editable: boolean
  onChange: (next: DashFilter[]) => void
}) {
  const props = usePropOptions()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<{ prop: string; op: string; value: string } | null>(null)
  const fix = useEdgeNudge(open)
  const { t } = useI18n()

  // 锁定态没有筛选、也没得加 → 整条不占位(成品页不该顶着一条空工具条)。
  if (!filters.length && !editable) return null

  const start = (): void => {
    const first = props[0]
    if (!first) return
    setDraft({ prop: first.name, op: FILTER_OPS[first.kind]?.[0] ?? 'eq', value: '' })
    setOpen(true)
  }
  const cur = draft ? props.find((p) => p.name === draft.prop) : null
  const ops = cur ? FILTER_OPS[cur.kind] ?? ['eq'] : ['eq']

  const commit = (): void => {
    if (!draft) return
    const unary = UNARY_OPS.has(draft.op)
    if (!unary && !draft.value.trim()) return
    onChange([...filters, { prop: draft.prop, op: draft.op, ...(unary ? {} : { value: draft.value.trim() }) }])
    setDraft(null)
    setOpen(false)
  }

  return (
    <div className="dash-filterbar">
      <Filter size={12} className="dash-filterbar-label" />
      <span className="dash-filterbar-label">{t('dashfilter.label')}</span>
      {filters.map((f, i) => (
        <span className="dash-filter-chip" key={`${f.prop}-${f.op}-${i}`}>
          <b>{f.prop}</b>
          <span>{OP_LABEL[f.op] ?? f.op}</span>
          {f.value !== undefined && <span>{f.value}</span>}
          {editable && (
            <button title={t('dashfilter.remove')} onClick={() => onChange(filters.filter((_, j) => j !== i))}>
              <X size={11} />
            </button>
          )}
        </span>
      ))}
      {editable && (
        <span style={{ position: 'relative', display: 'inline-flex' }}>
          <button className="dash-filter-add" onClick={start} disabled={!props.length} title={props.length ? t('dashfilter.addTitle') : t('dashfilter.noCards')}>
            <Plus size={11} /> {t('dashfilter.add')}
          </button>
          {open && draft && (
            <>
              <div className="dash-menu-scrim" onClick={() => { setOpen(false); setDraft(null) }} />
              <div ref={fix.ref} className="dash-add-menu dash-filter-editor" style={fix.style}>
                <select value={draft.prop} onChange={(e) => {
                  const p = props.find((x) => x.name === e.target.value)
                  setDraft({ prop: e.target.value, op: (p && FILTER_OPS[p.kind]?.[0]) ?? 'eq', value: '' })
                }}>
                  {props.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
                </select>
                <select value={draft.op} onChange={(e) => setDraft({ ...draft, op: e.target.value })}>
                  {ops.map((op) => <option key={op} value={op}>{OP_LABEL[op] ?? op}</option>)}
                </select>
                {!UNARY_OPS.has(draft.op) && (
                  cur?.options.length
                    ? (
                      <select value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })}>
                        <option value="">{t('dashfilter.pickOne')}</option>
                        {cur.options.map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    )
                    : <input value={draft.value} placeholder={t('dashfilter.valuePlaceholder')} onChange={(e) => setDraft({ ...draft, value: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') commit() }} autoFocus />
                )}
                <button className="dash-filter-commit" onClick={commit}>{t('dashfilter.commit')}</button>
              </div>
            </>
          )}
        </span>
      )}
    </div>
  )
}
