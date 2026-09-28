/** 笔记属性面板(Notion properties / Obsidian properties):编辑 frontmatter 里除 amadeus_* 外的键值。
 *  数据源 = manifest.fmExtra(编译器原文保留);面板编辑提交时经 yaml 重排(注释在此时丢失——
 *  只在源码模式改则逐字保留)。嵌套结构只读展示,请去源码模式编辑。
 *
 *  插件文件类型的 fm 键(如画布的 `canvas` 几何键,FileTypeContribution.fmKeys 声明):
 *  **只在展示层隐藏**,模型(entries)永远持全量 —— commit 走全量列表,隐藏键就结构性地
 *  不可能被抹掉。⚠️ 千万别改成「先 filter 再 commit」:那会让任意一次属性编辑静默删掉
 *  插件数据(毁档级,2026-08-14 评审 P0)。契约仪器:amadeusProperties.model.test.ts。
 *  该不变式只覆盖 entries 模式;坏 YAML 的原文模式刻意全透明(行级剥离在坏 YAML 上不可靠),
 *  插件文件在原文模式顶部给警示行。
 *
 *  **文本类输入一律受控 + 本地草稿**(键名、字符串/数字/日期值、坏 YAML 原文框;评审 2026-09-27 C-01 P0):
 *  没打过字 = 草稿为空 = 显示当前 prop —— 外部改写 / 源码模式自改 / 回灌即时可见;失焦只在「真改了」
 *  时提交(判据 draftToCommit)。⚠️ 别改回 `defaultValue` + 失焦比较 DOM 值:DOM 里是挂载时的旧值,
 *  外部改动后「白点一下」就把旧值写回盘(外部改动静默回滚,源码模式刚改的也被撤回)。
 *  聚焦打字中同一字段被外部改了:草稿本地胜(不吞正在打的字),这里只做字段级冲突标记;整篇被盖掉那版的
 *  冲突副本 + toast 在 UnifiedPage 保存链(D-03)。
 *  **Esc 只在单行框(值框/键名框)标着 conflict 时放弃草稿 = 接受外部值**(收口 N-3):放弃不进撤销栈,没有冲突
 *  时按 Esc 就清掉一行草稿 = 用户一按手滑、Cmd+Z 也找不回;坏 YAML 原文框**从不**以 Esc 放弃(一段多行修复
 *  一键全没),冲突时撤销回原样再失焦即采用外部版本。不放弃的 Esc 原样冒泡(不吞)。输入法组合中的 Esc 只取消
 *  候选,不动草稿。仪器:amadeusProperties.model.test.ts(判据)、amadeusProperties.draft.test.ts
 *  (DOM)、unified-page.check 的 PR 组(真浏览器三变体)。 */
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { Plus, X } from 'lucide-react'
import { usePageStore, useScopedPageStore } from '@amadeus/store/pageStore'
import { matchFileType } from '@amadeus/plugins/pluginStore'
import { askString } from '@amadeus/components/askString'
import { registerMessages, useI18n } from './i18n'

registerMessages({
  'amprops.add': { zh: '添加属性', en: 'Add property' },
  'amprops.addLabel': { zh: '写入笔记 frontmatter 的键名', en: 'Key name written to the note frontmatter' },
  'amprops.reservedKey': { zh: 'amadeus_* 是保留键', en: 'amadeus_* keys are reserved' },
  'amprops.pluginManaged': { zh: '该键由插件管理', en: 'This key is managed by a plugin' },
  'amprops.chipRaw': { zh: '属性（原文）', en: 'Properties (raw)' },
  'amprops.chipCount': { zh: '属性 {n}', en: 'Properties {n}' },
  'amprops.empty': { zh: '还没有属性。', en: 'No properties yet.' },
  'amprops.delete': { zh: '删除属性', en: 'Delete property' },
  'amprops.pluginKeysWarn': { zh: '⚠️ 本文件含插件数据键（{keys}），修复 YAML 时请勿改动那几行。', en: '⚠️ This file contains plugin data keys ({keys}) — leave those lines untouched while fixing the YAML.' },
  'amprops.nestedHint': { zh: '嵌套结构请在源码模式编辑', en: 'Edit nested values in source mode' },
  'amprops.chipsPlaceholder': { zh: '回车添加…', en: 'Press Enter to add…' },
  'amprops.conflict': { zh: '此处已在别处改为「{v}」。失焦后以你的输入为准，按 Esc 放弃你的输入。', en: 'Changed elsewhere to "{v}". Leaving the field keeps your input; press Esc to discard it.' },
  'amprops.conflictRaw': { zh: '这段已在别处被改动。失焦后以你的输入为准；撤销你的改动再失焦则采用别处的版本。', en: 'Changed elsewhere. Leaving the field keeps your input; undo your edits first to take the other version.' },
})

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

/** 失焦提交判据(C-01):返回要提交的(归一后)文本,不该写就返回 null。
 *  - draft=null = 没打过字(白点一下)→ 不写;
 *  - 归一后等于 base(开始编辑那一刻的值)= 打了又改回 → 不写;
 *  - 等于 current(当前 prop)= 无差别 → 不写。
 *  ⚠️ 只比 current 不够:打字又删回原值、期间外部改了同一字段 → 拿原值比新 prop 恒不等,旧值就被写回。 */
export function draftToCommit(draft: string | null, base: string, current: string, norm: (s: string) => string = (s) => s): string | null {
  if (draft === null) return null
  const d = norm(draft)
  return d === norm(base) || d === norm(current) ? null : d
}

/** 受控草稿:draft=null → 显示 current(外部改动即时可见);第一击键记下 base。
 *  conflict = 有草稿、同一字段在编辑期间被别处改了(current 已离开 base),**且失焦真会拿草稿盖掉它** ——
 *  与 draftToCommit 同一判据:草稿(归一后)等于 base 或 current 时失焦零写入、外部值胜出,这时再标冲突、
 *  提示「失焦后以你的输入为准」就和结果相反(收口 N-6 / E5)。
 *  escDiscards:'conflict' = 只有冲突时 Esc 才放弃草稿(单行框);'never' = Esc 从不放弃(原文框,见文件头 N-3)。
 *  norm:比较前的归一(数字框 / 键名框去首尾空白),冲突判据与失焦提交共用。 */
function useFieldDraft(current: string, escDiscards: 'conflict' | 'never' = 'conflict', norm: (s: string) => string = (s) => s) {
  const [draft, setDraft] = useState<string | null>(null)
  const [base, setBase] = useState(current)
  const conflict = draft !== null && current !== base && draftToCommit(draft, base, current, norm) !== null
  return {
    shown: draft ?? current,
    conflict,
    change: (v: string): void => {
      if (draft === null) setBase(current)
      setDraft(v)
    },
    /** 失焦收口:草稿一律清掉(之后显示回到 prop),返回需要提交的文本或 null。 */
    settle: (): string | null => {
      setDraft(null)
      return draftToCommit(draft, base, current, norm)
    },
    /** Esc:**标着冲突**才吞键 —— 放弃草稿 = 接受外部值(不 blur:blur 会拿旧闭包里的草稿去提交)。
     *  没冲突 / 原文框:不处理、照常冒泡,草稿留着(放弃不进撤销栈,无冲突时清草稿 = 不可恢复地丢字,收口 N-3)。
     *  ⚠️ 输入法组合中的 Esc 是「取消候选」,不是放弃草稿:不判组合态会把已上屏的字连同草稿一起清掉、
     *  失焦零写入(静默吞字)。keyCode 229 兜 Safari 类「compositionend 先于 keydown」的时序。
     *  仪器:amadeusProperties.draft.test.ts、unified-page.check PR5(真 CDP 组合)。 */
    onEscape: (e: KeyboardEvent<HTMLElement>): void => {
      if (e.key !== 'Escape' || e.nativeEvent.isComposing || e.keyCode === 229 || escDiscards === 'never' || !conflict) return
      e.preventDefault()
      e.stopPropagation()
      setDraft(null)
    },
  }
}

export function AmadeusPropertiesPanel({ fmExtra: fmProp, onCommit, readOnly = false }: {
  /** 缺省 = pageStore.manifest.fmExtra(v3 老路径);unified 传显式 fm 文本 + onCommit 走自己的管线。 */
  fmExtra?: string
  onCommit?: (yaml: string) => void
  /** 只读(公开分享页):只展示键值,不出添加/删除/编辑控件;坏 YAML 原文也只展示不可改。 */
  readOnly?: boolean
} = {}) {
  const { t } = useI18n()
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
    const name = (await askString(t('amprops.add'), '', { label: t('amprops.addLabel') }))?.trim()
    if (!name) return
    if (/^amadeus_/.test(name)) { window.alert(t('amprops.reservedKey')); return }
    if (hiddenKeys.has(name)) { window.alert(t('amprops.pluginManaged')); return }
    if (parsed.entries.some((e) => e.key === name)) return
    commit([...parsed.entries, { key: name, value: '' }])
    setOpen(true)
  }

  const count = parsed.ok ? visible.length : null

  return (
    <div className="amx-props">
      <div className="amx-props-bar">
        <button className="amx-props-chip" onClick={() => setOpen((o) => !o)}>
          {count === null ? t('amprops.chipRaw') : t('amprops.chipCount', { n: count })}{open ? ' ▾' : ' ▸'}
        </button>
        {!readOnly && <button className="amx-props-add" title={t('amprops.add')} onClick={() => void addProp()}><Plus size={12} /></button>}
      </div>
      {open && (parsed.ok ? (
        <div className="amx-props-rows">
          {visible.length === 0 && <div className="amx-props-empty">{t('amprops.empty')}</div>}
          {visible.map((e) => readOnly ? (
            <div className="amx-prop-row amx-prop-row-ro" key={`${activePage}:${e.idx}:${e.key}`}>
              <span className="amx-prop-key">{e.key}</span>
              <ValueStatic value={e.value} />
            </div>
          ) : (
            // 行身份 = 键名(YAML 映射里唯一;重复键解析失败走原文模式)。不带 idx:别处插/删一个键
            // 会让下方各行 idx 平移,带 idx 就整片重挂、正在打的草稿被静默丢掉。提交仍按当期 e.idx 写全量。
            <div className="amx-prop-row" key={`${activePage}:${e.key}`}>
              <KeyNameInput
                name={e.key}
                onRename={(k) => {
                  // 改成保留键/插件键或撞已有键(含隐藏键)→ 拒绝并回显原名(否则 commit 会静默删值/合并覆盖)。
                  const invalid = /^(amadeus_page|amadeus_schema|amadeus_layout|amadeus_canvas|amadeus_next_id)$/.test(k)
                    || hiddenKeys.has(k)
                    || parsed.entries.some((x, j) => j !== e.idx && x.key === k)
                  if (!k || invalid) return
                  commit(parsed.entries.map((x, j) => (j === e.idx ? { ...x, key: k } : x)))
                }}
              />
              <ValueEditor value={e.value} onCommit={(v) => commit(parsed.entries.map((x, j) => (j === e.idx ? { ...x, value: v } : x)))} />
              <button className="amx-prop-del" title={t('amprops.delete')} onClick={() => commit(parsed.entries.filter((_, j) => j !== e.idx))}><X size={12} /></button>
            </div>
          ))}
        </div>
      ) : (
        // YAML 解析不了(罕见写法)→ 原文直编,不破坏内容。未改动不提交(白点一下不应重写文件)。
        // ⚠️ 隐藏键在这一面**藏不了**:坏 YAML 上行级定位不可靠,剥了拼不回反而更危险(整段
        // 覆盖会静默抹键)—— 保持全透明 + 插件文件给一行警示,修复责任交还用户。
        <>
          {hiddenKeys.size > 0 && (
            <div className="amx-props-empty">{t('amprops.pluginKeysWarn', { keys: [...hiddenKeys].join(', ') })}</div>
          )}
          <RawFmEditor text={fmExtra} readOnly={readOnly} onCommit={commitYaml} />
        </>
      ))}
    </div>
  )
}

/** 坏 YAML 原文框:受控草稿(C-01 变体 C —— 原 defaultValue 版外部改写后白点一下整段写回旧文)。 */
function RawFmEditor({ text, readOnly, onCommit }: { text: string; readOnly: boolean; onCommit: (yaml: string) => void }) {
  const { t } = useI18n()
  const f = useFieldDraft(text, 'never') // 多行草稿:Esc 从不放弃(收口 N-3,见文件头)
  return (
    <textarea
      className={`amx-props-raw${f.conflict ? ' amx-prop-conflict' : ''}`}
      value={f.shown}
      spellCheck={false}
      readOnly={readOnly}
      title={f.conflict ? t('amprops.conflictRaw') : undefined}
      onChange={(e) => { if (!readOnly) f.change(e.target.value) }}
      onBlur={() => {
        const next = f.settle()
        if (!readOnly && next !== null) onCommit(next)
      }}
    />
  )
}

/** 键名框:受控草稿;失焦只在真改了时交给 onRename(校验不过 = 草稿已清,自然回显原名)。 */
function KeyNameInput({ name, onRename }: { name: string; onRename: (k: string) => void }) {
  const f = useFieldDraft(name, 'conflict', (s) => s.trim())
  return (
    <input
      className="amx-prop-key"
      value={f.shown}
      onChange={(e) => f.change(e.target.value)}
      onKeyDown={f.onEscape}
      onBlur={() => {
        const k = f.settle()
        if (k !== null) onRename(k)
      }}
    />
  )
}

/** 只读展示一个属性值(分享页):布尔 → 勾选符,标量数组 → chips,其余 → 文本;嵌套结构按 JSON 一行。 */
function ValueStatic({ value }: { value: unknown }) {
  if (typeof value === 'boolean') return <span className="amx-prop-check" aria-hidden>{value ? '☑' : '☐'}</span>
  if (isScalarArray(value)) {
    return (
      <span className="amx-prop-chips">
        {value.map((x, i) => <span key={i} className="amx-chip">{String(x ?? '')}</span>)}
      </span>
    )
  }
  if (value === null || value === undefined) return <span className="amx-prop-input" />
  if (typeof value === 'object') return <span className="amx-prop-input">{JSON.stringify(value)}</span>
  return <span className="amx-prop-input">{String(value)}</span>
}

function ValueEditor({ value, onCommit }: { value: unknown; onCommit: (v: unknown) => void }) {
  const { t } = useI18n()
  if (typeof value === 'boolean') {
    return <input type="checkbox" className="amx-prop-check" checked={value} onChange={(e) => onCommit(e.target.checked)} />
  }
  if (isScalarArray(value)) {
    return <ChipsEditor items={value.map((x) => String(x ?? ''))} onCommit={onCommit} />
  }
  if (typeof value === 'number') {
    return (
      <TextValueInput
        current={String(value)}
        norm={(s) => s.trim()}
        onCommit={(raw) => {
          const n = Number(raw)
          onCommit(raw !== '' && !Number.isNaN(n) ? n : raw)
        }}
      />
    )
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return <DateValueInput value={value} onCommit={onCommit} />
  }
  if (typeof value === 'string' || value == null) {
    return <TextValueInput current={value ?? ''} onCommit={onCommit} />
  }
  return <span className="amx-prop-nested" title={t('amprops.nestedHint')}>{stringifyYaml(value).trimEnd()}</span>
}

/** 字符串/数字值框:受控草稿,失焦只在真改了时提交(见文件头 C-01)。 */
function TextValueInput({ current, norm, onCommit }: { current: string; norm?: (s: string) => string; onCommit: (v: string) => void }) {
  const { t } = useI18n()
  const f = useFieldDraft(current, 'conflict', norm)
  return (
    <input
      className={`amx-prop-input${f.conflict ? ' amx-prop-conflict' : ''}`}
      value={f.shown}
      title={f.conflict ? t('amprops.conflict', { v: current }) : undefined}
      onChange={(e) => f.change(e.target.value)}
      onKeyDown={f.onEscape}
      onBlur={() => {
        const next = f.settle()
        if (next !== null) onCommit(next)
      }}
    />
  )
}

/** 日期框:选中即提交(原语义)。受控显示 prop;只在键盘分段输入的「半成品」态(value 为 '')持草稿 ——
 *  否则 React 会把受控 value 回写进去,清掉用户正在敲的那一段。外部改动在未持草稿时即时可见。 */
function DateValueInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [partial, setPartial] = useState(false)
  return (
    <input
      type="date"
      className="amx-prop-input"
      value={partial ? '' : value}
      onChange={(e) => {
        const v = e.target.value
        setPartial(!v)
        if (v && v !== value) onCommit(v)
      }}
      onBlur={() => setPartial(false)}
    />
  )
}

/** 字符串数组(tags 等):chips + 回车追加、× 移除。 */
function ChipsEditor({ items, onCommit }: { items: string[]; onCommit: (v: string[]) => void }) {
  const { t } = useI18n()
  const [draft, setDraft] = useState('')
  const add = (): void => {
    const next = draft.trim()
    setDraft('')
    if (next && !items.includes(next)) onCommit([...items, next])
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add() }
    else if (e.key === 'Backspace' && !draft && items.length) onCommit(items.slice(0, -1))
  }
  return (
    <div className="amx-prop-chips">
      {items.map((tag, i) => (
        <span className="amx-chip" key={`${i}:${tag}`}>
          {tag}
          <button className="amx-chip-x" onClick={() => onCommit(items.filter((_, j) => j !== i))}><X size={10} /></button>
        </span>
      ))}
      <input value={draft} placeholder={items.length ? '' : t('amprops.chipsPlaceholder')} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} onBlur={add} />
    </div>
  )
}
