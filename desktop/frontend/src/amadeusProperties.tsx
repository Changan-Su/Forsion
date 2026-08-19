/** 笔记属性面板(Notion properties / Obsidian properties):编辑 frontmatter 里除 amadeus_* 外的键值。
 *  数据源 = manifest.fmExtra(编译器原文保留);面板编辑提交时经 yaml 重排(注释在此时丢失——
 *  只在源码模式改则逐字保留)。嵌套结构只读展示,请去源码模式编辑。
 *
 *  插件文件类型的 fm 键(如画布的 `canvas` 几何键,FileTypeContribution.fmKeys 声明):
 *  **只在展示层隐藏**,模型(entries)永远持全量 —— commit 走全量列表,隐藏键就结构性地
 *  不可能被抹掉。⚠️ 千万别改成「先 filter 再 commit」:那会让任意一次属性编辑静默删掉
 *  插件数据(毁档级,2026-08-14 评审 P0)。契约仪器:amadeusProperties.model.test.ts。
 *  该不变式只覆盖 entries 模式;坏 YAML 的原文模式刻意全透明(行级剥离在坏 YAML 上不可靠),
 *  插件文件在原文模式顶部给警示行。 */
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { Plus, X } from 'lucide-react'
import { usePageStore, useScopedPageStore } from '@amadeus/store/pageStore'
import { matchFileType } from '@amadeus/plugins/pluginStore'
import { askString } from '@amadeus/components/askString'

export interface FmEntry { key: string; value: unknown }
type Entry = FmEntry

/** fmExtra 文本 → 全量键值列表(顺序保留);解析不了 → ok:false 走原文模式。 */
export function parseFmEntries(fmExtra: string): { ok: boolean; entries: FmEntry[] } {
  if (!fmExtra.trim()) return { ok: true, entries: [] }
  try {
    const v: unknown = parseYaml(fmExtra)
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return { ok: true, entries: Object.entries(v as Record<string, unknown>).map(([key, value]) => ({ key, value })) }
    }
  } catch { /* 非法 YAML → 原文模式 */ }
  return { ok: false, entries: [] }
}

/** 全量键值列表 → fmExtra YAML(编译器四个精确保留键剔除;顺序=列表顺序)。 */
export function fmEntriesToYaml(entries: FmEntry[]): string {
  const obj: Record<string, unknown> = {}
  for (const e of entries) {
    const k = e.key.trim()
    // 只滤编译器的四个精确保留键(与 split.ts AMADEUS_FM_KEY 一致)——
    // 外来工具的 amadeus_created 之类前缀键属于用户数据,不能顺手删掉。
    if (!k || /^(amadeus_page|amadeus_schema|amadeus_layout|amadeus_canvas|amadeus_next_id)$/.test(k)) continue
    obj[k] = e.value
  }
  return Object.keys(obj).length ? stringifyYaml(obj).trimEnd() : ''
}

const isScalarArray = (v: unknown): v is unknown[] => Array.isArray(v) && v.every((x) => x === null || typeof x !== 'object')

export function AmadeusPropertiesPanel({ fmExtra: fmProp, onCommit }: {
  /** 缺省 = pageStore.manifest.fmExtra(v3 老路径);unified 传显式 fm 文本 + onCommit 走自己的管线。 */
  fmExtra?: string
  onCommit?: (yaml: string) => void
} = {}) {
  const activePage = usePageStore((s) => s.activePage)
  const storeFm = usePageStore((s) => s.manifest?.fmExtra ?? '')
  // 写操作走本面板的 store:插件文件视图(画布文档模式)也挂这面板,活动面板门面
  // usePageStore.getState() 在那里解析到隔壁编辑器面板,fm 会写进别人那篇。
  const scoped = useScopedPageStore()
  const external = fmProp !== undefined
  const fmExtra = external ? fmProp : storeFm
  const [open, setOpen] = useState(false)
  useEffect(() => { setOpen(false) }, [activePage])

  const parsed = useMemo(() => parseFmEntries(fmExtra), [fmExtra])
  // 插件文件类型声明的 fm 键只做**展示隐藏**(用户手改会弄坏插件数据,普通笔记也没这些键);
  // 模型仍持全量,行编辑按 idx 回写全量列表。unified(external)不会是插件页,恒不隐藏。
  const hiddenKeys = useMemo(() => {
    const ft = !external && activePage ? matchFileType(activePage) : undefined
    return new Set(ft?.fmKeys ?? [])
  }, [external, activePage])
  const visible = useMemo(
    () => parsed.entries.map((e, idx) => ({ ...e, idx })).filter((e) => !hiddenKeys.has(e.key)),
    [parsed, hiddenKeys],
  )

  if (!external && !activePage) return null

  const commitYaml = (yaml: string): void => {
    if (onCommit) onCommit(yaml)
    else scoped.getState().setFmExtra(yaml)
  }
  /** ⚠️ 只许喂**全量** entries(含隐藏的插件键)—— 见文件头 P0 注。 */
  const commit = (entries: Entry[]): void => {
    commitYaml(fmEntriesToYaml(entries))
  }

  const addProp = async (): Promise<void> => {
    const name = (await askString('添加属性', '', { label: '写入笔记 frontmatter 的键名' }))?.trim()
    if (!name) return
    if (/^amadeus_/.test(name)) { window.alert('amadeus_* 是保留键'); return }
    if (hiddenKeys.has(name)) { window.alert('该键由插件管理'); return }
    if (parsed.entries.some((e) => e.key === name)) return
    commit([...parsed.entries, { key: name, value: '' }])
    setOpen(true)
  }

  const count = parsed.ok ? visible.length : null

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
          {visible.length === 0 && <div className="amx-props-empty">还没有属性。</div>}
          {visible.map((e) => (
            <div className="amx-prop-row" key={`${activePage}:${e.idx}:${e.key}`}>
              <input
                className="amx-prop-key"
                defaultValue={e.key}
                onBlur={(ev) => {
                  const k = ev.target.value.trim()
                  // 改成保留键/插件键或撞已有键(含隐藏键)→ 拒绝并回显原名(否则 commit 会静默删值/合并覆盖)。
                  const invalid = /^(amadeus_page|amadeus_schema|amadeus_layout|amadeus_canvas|amadeus_next_id)$/.test(k)
                    || hiddenKeys.has(k)
                    || parsed.entries.some((x, j) => j !== e.idx && x.key === k)
                  if (!k || k === e.key || invalid) { ev.target.value = e.key; return }
                  commit(parsed.entries.map((x, j) => (j === e.idx ? { ...x, key: k } : x)))
                }}
              />
              <ValueEditor value={e.value} onCommit={(v) => commit(parsed.entries.map((x, j) => (j === e.idx ? { ...x, value: v } : x)))} />
              <button className="amx-prop-del" title="删除属性" onClick={() => commit(parsed.entries.filter((_, j) => j !== e.idx))}><X size={12} /></button>
            </div>
          ))}
        </div>
      ) : (
        // YAML 解析不了(罕见写法)→ 原文直编,不破坏内容。未改动不提交(白点一下不应重写文件)。
        // ⚠️ 隐藏键在这一面**藏不了**:坏 YAML 上行级定位不可靠,剥了拼不回反而更危险(整段
        // 覆盖会静默抹键)—— 保持全透明 + 插件文件给一行警示,修复责任交还用户。
        <>
          {hiddenKeys.size > 0 && (
            <div className="amx-props-empty">⚠️ 本文件含插件数据键({[...hiddenKeys].join(', ')}),修复 YAML 时请勿改动那几行。</div>
          )}
          <textarea
            className="amx-props-raw"
            defaultValue={fmExtra}
            spellCheck={false}
            onBlur={(e) => { if (e.target.value !== fmExtra) commitYaml(e.target.value) }}
          />
        </>
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
