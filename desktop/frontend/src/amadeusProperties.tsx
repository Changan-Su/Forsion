/** 笔记属性面板(Notion properties / Obsidian properties):编辑 frontmatter 里除 amadeus_* 外的键值。
 *  数据源 = manifest.fmExtra(编译器原文保留);面板编辑提交时经 yaml 重排(注释在此时丢失——
 *  只在源码模式改则逐字保留)。嵌套结构只读展示,请去源码模式编辑。 */
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { Plus, X } from 'lucide-react'
import { usePageStore } from '@amadeus/store/pageStore'
import { askString } from '@amadeus/components/askString'

const ps = () => usePageStore.getState()

interface Entry { key: string; value: unknown }

const isScalarArray = (v: unknown): v is unknown[] => Array.isArray(v) && v.every((x) => x === null || typeof x !== 'object')

export function AmadeusPropertiesPanel() {
  const activePage = usePageStore((s) => s.activePage)
  const fmExtra = usePageStore((s) => s.manifest?.fmExtra ?? '')
  const [open, setOpen] = useState(false)
  useEffect(() => { setOpen(false) }, [activePage])

  const parsed = useMemo(() => {
    if (!fmExtra.trim()) return { ok: true as const, entries: [] as Entry[] }
    try {
      const v: unknown = parseYaml(fmExtra)
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        return { ok: true as const, entries: Object.entries(v as Record<string, unknown>).map(([key, value]) => ({ key, value })) }
      }
    } catch { /* 非法 YAML → 原文模式 */ }
    return { ok: false as const, entries: [] as Entry[] }
  }, [fmExtra])

  if (!activePage) return null

  const commit = (entries: Entry[]): void => {
    const obj: Record<string, unknown> = {}
    for (const e of entries) {
      const k = e.key.trim()
      // 只滤编译器的四个精确保留键(与 split.ts AMADEUS_FM_KEY 一致)——
      // 外来工具的 amadeus_created 之类前缀键属于用户数据,不能顺手删掉。
      if (!k || /^(amadeus_page|amadeus_schema|amadeus_layout|amadeus_next_id)$/.test(k)) continue
      obj[k] = e.value
    }
    ps().setFmExtra(Object.keys(obj).length ? stringifyYaml(obj).trimEnd() : '')
  }

  const addProp = async (): Promise<void> => {
    const name = (await askString('添加属性', '', { label: '写入笔记 frontmatter 的键名' }))?.trim()
    if (!name) return
    if (/^amadeus_/.test(name)) { window.alert('amadeus_* 是保留键'); return }
    if (parsed.entries.some((e) => e.key === name)) return
    commit([...parsed.entries, { key: name, value: '' }])
    setOpen(true)
  }

  const count = parsed.ok ? parsed.entries.length : null

  return (
    <div className="amx-props">
      <div className="amx-props-bar">
        <button className="amx-props-chip" onClick={() => setOpen((o) => !o)}>
          {count === null ? '属性(原文)' : `属性 ${count}`}{open ? ' ▾' : ' ▸'}
        </button>
        <button className="amx-props-add" title="添加属性" onClick={() => void addProp()}><Plus size={12} /></button>
      </div>
      {open && (parsed.ok ? (
        <div className="amx-props-rows">
          {parsed.entries.length === 0 && <div className="amx-props-empty">还没有属性。</div>}
          {parsed.entries.map((e, i) => (
            <div className="amx-prop-row" key={`${activePage}:${i}:${e.key}`}>
              <input
                className="amx-prop-key"
                defaultValue={e.key}
                onBlur={(ev) => {
                  const k = ev.target.value.trim()
                  // 改成保留键或撞已有键 → 拒绝并回显原名(否则 commit 会静默删值/合并覆盖)。
                  const invalid = /^(amadeus_page|amadeus_schema|amadeus_layout|amadeus_next_id)$/.test(k)
                    || parsed.entries.some((x, j) => j !== i && x.key === k)
                  if (!k || k === e.key || invalid) { ev.target.value = e.key; return }
                  commit(parsed.entries.map((x, j) => (j === i ? { ...x, key: k } : x)))
                }}
              />
              <ValueEditor value={e.value} onCommit={(v) => commit(parsed.entries.map((x, j) => (j === i ? { ...x, value: v } : x)))} />
              <button className="amx-prop-del" title="删除属性" onClick={() => commit(parsed.entries.filter((_, j) => j !== i))}><X size={12} /></button>
            </div>
          ))}
        </div>
      ) : (
        // YAML 解析不了(罕见写法)→ 原文直编,不破坏内容。未改动不提交(白点一下不应重写文件)。
        <textarea
          className="amx-props-raw"
          defaultValue={fmExtra}
          spellCheck={false}
          onBlur={(e) => { if (e.target.value !== fmExtra) ps().setFmExtra(e.target.value) }}
        />
      ))}
    </div>
  )
}

function ValueEditor({ value, onCommit }: { value: unknown; onCommit: (v: unknown) => void }) {
  if (typeof value === 'boolean') {
    return <input type="checkbox" className="amx-prop-check" checked={value} onChange={(e) => onCommit(e.target.checked)} />
  }
  if (isScalarArray(value)) {
    return <ChipsEditor items={value.map((x) => String(x ?? ''))} onCommit={onCommit} />
  }
  if (typeof value === 'number') {
    return (
      <input
        className="amx-prop-input"
        defaultValue={String(value)}
        onBlur={(e) => {
          const t = e.target.value.trim()
          if (t === String(value)) return // 未改不提交
          const n = Number(t)
          onCommit(t !== '' && !Number.isNaN(n) ? n : t)
        }}
      />
    )
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return <input type="date" className="amx-prop-input" defaultValue={value} onChange={(e) => { if (e.target.value && e.target.value !== value) onCommit(e.target.value) }} />
  }
  if (typeof value === 'string' || value == null) {
    return <input className="amx-prop-input" defaultValue={value ?? ''} onBlur={(e) => { if (e.target.value !== (value ?? '')) onCommit(e.target.value) }} />
  }
  return <span className="amx-prop-nested" title="嵌套结构请在源码模式编辑">{stringifyYaml(value).trimEnd()}</span>
}

/** 字符串数组(tags 等):chips + 回车追加、× 移除。 */
function ChipsEditor({ items, onCommit }: { items: string[]; onCommit: (v: string[]) => void }) {
  const [draft, setDraft] = useState('')
  const add = (): void => {
    const t = draft.trim()
    setDraft('')
    if (t && !items.includes(t)) onCommit([...items, t])
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add() }
    else if (e.key === 'Backspace' && !draft && items.length) onCommit(items.slice(0, -1))
  }
  return (
    <div className="amx-prop-chips">
      {items.map((t, i) => (
        <span className="amx-chip" key={`${i}:${t}`}>
          {t}
          <button className="amx-chip-x" onClick={() => onCommit(items.filter((_, j) => j !== i))}><X size={10} /></button>
        </span>
      ))}
      <input value={draft} placeholder={items.length ? '' : '回车添加…'} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} onBlur={add} />
    </div>
  )
}
