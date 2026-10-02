/** 笔记属性面板(Notion properties / Obsidian properties):编辑 frontmatter 里除 amadeus_* 外的键值。
 *  数据源 = manifest.fmExtra(编译器原文保留)。**提交是行级的**(评审 2026-09-27 D-20):改一个键 = 只重写那个键的
 *  行(pageFrontmatter.patchYamlText / renameYamlKey),别的键的原文(`007`、`1.10`、20 位整数、`0x1F`、注释、
 *  flow 写法、多行块)逐字不动;旧版整块 parse→stringify,改一个键就把别的键改值、注释丢光。多行字符串用多行框编辑,
 *  换行不被单行框压扁。嵌套结构只读展示,请去源码模式编辑。
 *
 *  插件文件类型的 fm 键(如画布的 `canvas` 几何键,FileTypeContribution.fmKeys 声明):
 *  **只在展示层隐藏**,模型(entries)永远持全量 —— 行级提交根本不碰没改的键,隐藏键就结构性地不可能被抹掉;
 *  此刻的 fm 解析不了就不提交(绝不拿空列表重建)。⚠️ 千万别改成「先 filter 再整块重建」:那会让任意一次属性编辑
 *  静默删掉插件数据(毁档级,2026-08-14 评审 P0)。契约仪器:amadeusProperties.model.test.ts。
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
 *  (DOM)、unified-page.check 的 PR 组(真浏览器三变体)。
 *
 *  **C-19(评审 2026-09-27)**:新增属性先选类型(文本 / 数字 / 勾选 / 日期 / 列表),写盘为对应的 YAML 类型
 *  ('' / 0 / false / 今天 / []);键名是 tags / aliases 时缺省列表。仍是行级提交(setKey → patchYamlText),
 *  别的键逐字不动。展开状态按库记在本机(viewMemory.readPropsOpen),不写 md。新增后焦点落到新行的值框。
 *  值里的 `[[x]]` 渲染成可点的双链(点空白处进入编辑);索引侧把它们计入反链(shared/amadeus/linkIndex)。
 *  仪器:amadeusProperties.c19.test.ts。 */
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { Check, Plus, X } from 'lucide-react'
import { usePageStore, useScopedPageStore } from '@amadeus/store/pageStore'
import { matchFileType } from '@amadeus/plugins/pluginStore'
import { readPropsOpen, writePropsOpen } from '@amadeus/unified/viewMemory'
import { patchYamlText, renameYamlKey } from '@amadeus-shared/db/pageFrontmatter'
import { linkTarget } from '@amadeus-shared/links'
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
  'amprops.keyPlaceholder': { zh: '属性名', en: 'Property name' },
  'amprops.type': { zh: '属性类型', en: 'Property type' },
  'amprops.type.text': { zh: '文本', en: 'Text' },
  'amprops.type.number': { zh: '数字', en: 'Number' },
  'amprops.type.checkbox': { zh: '勾选', en: 'Checkbox' },
  'amprops.type.date': { zh: '日期', en: 'Date' },
  'amprops.type.list': { zh: '列表', en: 'List' },
  'amprops.addConfirm': { zh: '添加', en: 'Add' },
  'amprops.addCancel': { zh: '取消', en: 'Cancel' },
  'amprops.linksHint': { zh: '点链接跳转，点空白处编辑', en: 'Click a link to open it; click elsewhere to edit' },
})

/** 新增属性可选的类型(C-19)。 */
export type PropType = 'text' | 'number' | 'checkbox' | 'date' | 'list'
export const PROP_TYPES: PropType[] = ['text', 'number', 'checkbox', 'date', 'list']

/** 按类型写入的空值:YAML 里就是对应类型(`n: 0`、`done: false`、`due: 2026-09-28`、`tags: []`),
 *  值编辑器按值的运行时类型派发控件 —— 写对类型,控件就对。日期取本机今天。 */
export function emptyValueFor(type: PropType, now: Date = new Date()): unknown {
  switch (type) {
    case 'number': return 0
    case 'checkbox': return false
    case 'date': return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    case 'list': return []
    default: return ''
  }
}

/** 键名的缺省类型:tags / aliases(及单数写法)是列表(接 L-14 / L-13 的索引口径),其余文本。 */
export const defaultTypeForKey = (key: string): PropType => (/^(tags?|alias(es)?|cssclass(es)?)$/i.test(key.trim()) ? 'list' : 'text')

/** 值里是否含 `[[x]]` 双链(C-19:渲染成可点链接)。 */
const hasWikiLink = (s: string): boolean => /\[\[[^\]\n]+\]\]/.test(s)

export interface FmEntry { key: string; value: unknown }

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

/** 草稿冲洗登记处(评审 2026-09-27 C-02):宿主提供 = 草稿可以在失焦之外被冲洗 ——
 *  ① 卸载:键盘导航换篇(Cmd+Alt+←、Cmd+Shift+[)/ 关标签时框还聚焦着,React 不给已脱离的节点派 onBlur,正在打的字就丢了;
 *  ② 宿主落盘冲洗:beforeunload、换库 / 切号 / 退出握手(registerUnifiedPipe.flush)。
 *  只有 UnifiedPage 提供:它按路径建实例(key 含路径),卸载冲洗必然落回本篇。v3 PageView 刻意不提供 —— 那里的 store 换页时
 *  先换篇、后卸载行,卸载冲洗会把上一篇的草稿写进下一篇。 */
export const PropsDraftFlushContext = createContext<Set<() => void> | null>(null)

/** 受控草稿:draft=null → 显示 current(外部改动即时可见);第一击键记下 base。
 *  conflict = 有草稿、同一字段在编辑期间被别处改了(current 已离开 base),**且失焦真会拿草稿盖掉它** ——
 *  与 draftToCommit 同一判据:草稿(归一后)等于 base 或 current 时失焦零写入、外部值胜出,这时再标冲突、
 *  提示「失焦后以你的输入为准」就和结果相反(收口 N-6 / E5)。
 *  escDiscards:'conflict' = 只有冲突时 Esc 才放弃草稿(单行框);'never' = Esc 从不放弃(原文框,见文件头 N-3)。
 *  norm:比较前的归一(数字框 / 键名框去首尾空白),冲突判据与失焦提交共用。
 *  enterCommits:单行框回车 = 失焦提交(键盘离开,C-02);多行框 / 原文框回车照常换行。
 *  commit:失焦之外的冲洗(见 PropsDraftFlushContext)用它提交;失焦仍由调用方拿 settle() 的返回值提交。 */
function useFieldDraft(current: string, commit: (v: string) => void, { escDiscards = 'conflict', norm = (s: string) => s, enterCommits = false }: {
  escDiscards?: 'conflict' | 'never'
  norm?: (s: string) => string
  enterCommits?: boolean
} = {}) {
  const [draft, setDraftState] = useState<string | null>(null)
  const [base, setBaseState] = useState(current)
  // 最新值镜像:冲洗(卸载 cleanup / 宿主调用)不在渲染里,读它;draft/base 随 setter **同步**更新 ——
  // 失焦提交后紧跟着卸载(同一 tick),卸载冲洗读到的已经是 null,不会再提交一次。
  const live = useRef({ draft, base, current, norm, commit })
  live.current.current = current
  live.current.norm = norm
  live.current.commit = commit
  const setDraft = (v: string | null): void => { live.current.draft = v; setDraftState(v) }
  const setBase = (v: string): void => { live.current.base = v; setBaseState(v) }
  const flushers = useContext(PropsDraftFlushContext)
  useLayoutEffect(() => {
    if (!flushers) return
    // 冲洗 = 提交 + 把基线挪到已提交的值,草稿留在框里继续打(宿主冲洗不该把人踢出输入框);之后改回原值也能再提交,
    // prop 跟上后 current === base,不误标冲突。卸载时同一个函数最后跑一次(useLayoutEffect 的 cleanup 在节点
    // 脱离之前、父级卸载冲洗之前执行)。
    const flush = (): void => {
      const L = live.current
      const n = draftToCommit(L.draft, L.base, L.current, L.norm)
      if (n === null) return
      setBase(n)
      L.commit(n)
    }
    flushers.add(flush)
    return () => {
      flushers.delete(flush)
      flush()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flushers])
  const conflict = draft !== null && current !== base && draftToCommit(draft, base, current, norm) !== null
  /** Esc:**标着冲突**才吞键 —— 放弃草稿 = 接受外部值(不 blur:blur 会拿旧闭包里的草稿去提交)。
   *  没冲突 / 原文框:不处理、照常冒泡,草稿留着(放弃不进撤销栈,无冲突时清草稿 = 不可恢复地丢字,收口 N-3)。
   *  ⚠️ 输入法组合中的 Esc 是「取消候选」,不是放弃草稿:不判组合态会把已上屏的字连同草稿一起清掉、
   *  失焦零写入(静默吞字)。keyCode 229 兜 Safari 类「compositionend 先于 keydown」的时序。回车同一道组合闸(选词回车)。
   *  仪器:amadeusProperties.draft.test.ts、unified-page.check PR5(真 CDP 组合)。 */
  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter' && enterCommits) {
      e.preventDefault()
      e.currentTarget.blur() // → onBlur → settle → 提交
      return
    }
    if (e.key !== 'Escape' || escDiscards === 'never' || !conflict) return
    e.preventDefault()
    e.stopPropagation()
    setDraft(null)
  }
  return {
    shown: draft ?? current,
    conflict,
    change: (v: string): void => {
      if (live.current.draft === null) setBase(live.current.current)
      setDraft(v)
    },
    /** 失焦收口:草稿一律清掉(之后显示回到 prop),返回需要提交的文本或 null。 */
    settle: (): string | null => {
      const L = live.current
      const n = draftToCommit(L.draft, L.base, L.current, L.norm)
      setDraft(null)
      return n
    },
    onKeyDown,
  }
}

export function AmadeusPropertiesPanel({ fmExtra: fmProp, onCommit, readOnly = false, notePath }: {
  /** 缺省 = pageStore.manifest.fmExtra(v3 老路径);unified 传显式 fm 文本 + onCommit 走自己的管线。 */
  fmExtra?: string
  onCommit?: (yaml: string) => void
  /** 只读(公开分享页):只展示键值,不出添加/删除/编辑控件;坏 YAML 原文也只展示不可改。 */
  readOnly?: boolean
  /** 本面板所属笔记(值里的 `[[x]]` 按它就近解析);缺 = activePage(v4 不设 activePage,unified 显式传)。 */
  notePath?: string
} = {}) {
  const { t } = useI18n()
  const activePage = usePageStore((s) => s.activePage)
  const vaultRoot = usePageStore((s) => s.vaultRoot)
  const storeFm = usePageStore((s) => s.manifest?.fmExtra ?? '')
  // 写操作走本面板的 store:插件文件视图(画布文档模式)也挂这面板,活动面板门面
  // usePageStore.getState() 在那里解析到隔壁编辑器面板,fm 会写进别人那篇。
  const scoped = useScopedPageStore()
  const external = fmProp !== undefined
  const fmExtra = external ? fmProp : storeFm
  // 提交一律基于**此刻**的 fm 文本(C-02):行的卸载冲洗跑在本轮 commit 的 mutation 阶段,行里的闭包还是上一轮的,
  // 拿旧快照提交会把这期间别处改的键改回去(addProp 的 askString 等待期同理)。渲染期同步 —— layout effect 更新
  // 要等到 mutation 之后,来不及。
  const fmNow = useRef(fmExtra)
  fmNow.current = fmExtra
  // 展开状态按库记在本机(C-19):原先是组件局部 state、换篇即重置(v4 按路径重建实例)→ 每打开一篇都折叠。
  const [open, setOpenState] = useState(() => readPropsOpen(vaultRoot) ?? false)
  useEffect(() => { setOpenState(readPropsOpen(vaultRoot) ?? false) }, [vaultRoot])
  const setOpen = (next: boolean | ((o: boolean) => boolean)): void => {
    setOpenState((o) => {
      const v = typeof next === 'function' ? next(o) : next
      writePropsOpen(vaultRoot, v)
      return v
    })
  }
  const [adding, setAdding] = useState(false)
  /** 刚新增的键:渲染后把焦点送进它那一行的值框(fm 经 onCommit 异步回来,新行下一轮才出现)。 */
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const sourcePath = notePath ?? activePage ?? undefined
  const openLink = (inner: string): void => {
    const name = linkTarget(inner)
    if (name) scoped.getState().openWikiLink(name, sourcePath)
  }

  const parsed = useMemo(() => parseFmEntries(fmExtra), [fmExtra])
  // 插件文件类型声明的 fm 键只做**展示隐藏**(用户手改会弄坏插件数据,普通笔记也没这些键);
  // 模型仍持全量;行编辑是行级提交,只动被编辑的键(D-20)。unified(external)不会是插件页,恒不隐藏。
  const hiddenKeys = useMemo(() => {
    const ft = !external && activePage ? matchFileType(activePage) : undefined
    return new Set(ft?.fmKeys ?? [])
  }, [external, activePage])
  const visible = useMemo(
    () => parsed.entries.map((e, idx) => ({ ...e, idx })).filter((e) => !hiddenKeys.has(e.key)),
    [parsed, hiddenKeys],
  )
  useEffect(() => {
    if (!focusKey) return
    const row = [...(rootRef.current?.querySelectorAll<HTMLElement>('.amx-prop-row[data-key]') ?? [])].find((r) => r.dataset.key === focusKey)
    const el = row?.querySelector<HTMLElement>('input:not(.amx-prop-key), textarea, .amx-prop-links')
    if (!el) return // 行还没回来(v3 store 异步)→ 下一轮 parsed 变了再试
    el.focus()
    if (el.classList.contains('amx-prop-links')) el.click() // 链接展示态:点一下进编辑
    setFocusKey(null)
  }, [focusKey, parsed])

  if (!external && !activePage) return null

  const commitYaml = (yaml: string): void => {
    if (onCommit) onCommit(yaml)
    else scoped.getState().setFmExtra(yaml)
  }
  /** 行级提交(D-20):text = 只改了被编辑那个键的新全文(隐藏的插件键结构性地不被碰到)。null = 此刻的 fm 已经
   *  解析不了(编辑期间被别处改坏)→ 不提交:面板随即切原文模式,绝不拿空列表重建去抹掉整块。 */
  const commit = (text: string | null): void => {
    if (text !== null) commitYaml(text)
  }
  const setKey = (key: string, v: unknown): void => commit(patchYamlText(fmNow.current, { [key]: v }))

  /** 新增一行(C-19):键名 + 类型 → 按类型写空值(行级提交),焦点送进新行的值框。返回 false = 没加(留在新增行)。 */
  const addProp = (rawName: string, type: PropType): boolean => {
    const name = rawName.trim()
    if (!name) return false
    if (/^amadeus_/.test(name)) { window.alert(t('amprops.reservedKey')); return false }
    if (hiddenKeys.has(name)) { window.alert(t('amprops.pluginManaged')); return false }
    if (!parseFmEntries(fmNow.current).entries.some((e) => e.key === name)) setKey(name, emptyValueFor(type))
    setFocusKey(name) // 已存在 = 直接去编辑那一行
    return true
  }

  const count = parsed.ok ? visible.length : null

  return (
    // 零属性时整条只在指针经过标题区 / 本条、或键盘焦点进来时露出(10-02 用户拍板 v7;CSS 在 amadeus-host.css)。
    <div className={`amx-props${count === 0 && !open ? ' is-empty' : ''}`} ref={rootRef}>
      <div className="amx-props-bar">
        <button className="amx-props-chip" onClick={() => setOpen((o) => !o)}>
          {count === null ? t('amprops.chipRaw') : t('amprops.chipCount', { n: count })}{open ? ' ▾' : ' ▸'}
        </button>
        {!readOnly && <button className="amx-props-add" title={t('amprops.add')} onClick={() => { setOpen(true); if (parsed.ok) setAdding(true) }}><Plus size={12} /></button>}
      </div>
      {open && (parsed.ok ? (
        <div className="amx-props-rows">
          {visible.length === 0 && !adding && <div className="amx-props-empty">{t('amprops.empty')}</div>}
          {visible.map((e) => readOnly ? (
            <div className="amx-prop-row amx-prop-row-ro" key={`${activePage}:${e.idx}:${e.key}`}>
              <span className="amx-prop-key">{e.key}</span>
              <ValueStatic value={e.value} />
            </div>
          ) : (
            // 行身份 = 键名(YAML 映射里唯一;重复键解析失败走原文模式)。不带 idx:别处插/删一个键
            // 会让下方各行 idx 平移,带 idx 就整片重挂、正在打的草稿被静默丢掉。提交按键名、基于此刻的 fm(fmNow)。
            <div className="amx-prop-row" key={`${activePage}:${e.key}`} data-key={e.key}>
              <KeyNameInput
                name={e.key}
                onRename={(k) => {
                  // 改成保留键/插件键或撞已有键(含隐藏键)→ 拒绝并回显原名(否则 commit 会静默删值/合并覆盖)。
                  const invalid = /^(amadeus_page|amadeus_schema|amadeus_layout|amadeus_canvas|amadeus_next_id)$/.test(k)
                    || hiddenKeys.has(k)
                    || parseFmEntries(fmNow.current).entries.some((x) => x.key !== e.key && x.key === k)
                  if (!k || invalid) return
                  commit(renameYamlKey(fmNow.current, e.key, k))
                }}
              />
              <ValueEditor value={e.value} onCommit={(v) => setKey(e.key, v)} onOpenLink={openLink} />
              <button className="amx-prop-del" title={t('amprops.delete')} onClick={() => setKey(e.key, undefined)}><X size={12} /></button>
            </div>
          ))}
          {adding && !readOnly && (
            <NewPropRow
              onAdd={(name, type) => { if (addProp(name, type)) setAdding(false) }}
              onCancel={() => setAdding(false)}
            />
          )}
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
  const commit = (v: string): void => { if (!readOnly) onCommit(v) }
  const f = useFieldDraft(text, commit, { escDiscards: 'never' }) // 多行草稿:Esc 从不放弃(收口 N-3,见文件头)
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
        if (next !== null) commit(next)
      }}
    />
  )
}

/** 键名框:受控草稿;失焦只在真改了时交给 onRename(校验不过 = 草稿已清,自然回显原名)。 */
function KeyNameInput({ name, onRename }: { name: string; onRename: (k: string) => void }) {
  const f = useFieldDraft(name, onRename, { norm: (s) => s.trim(), enterCommits: true })
  return (
    <input
      className="amx-prop-key"
      value={f.shown}
      onChange={(e) => f.change(e.target.value)}
      onKeyDown={f.onKeyDown}
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

/** 新增属性行(C-19):键名框 + 类型选择。回车(非组字)/ ✓ 提交,Esc / × 放弃;键名是 tags / aliases 时类型缺省列表
 *  (用户动过类型选择之后不再跟着键名改)。 */
function NewPropRow({ onAdd, onCancel }: { onAdd: (name: string, type: PropType) => void; onCancel: () => void }) {
  const { t } = useI18n()
  const [name, setName] = useState('')
  const [type, setType] = useState<PropType>('text')
  const [typeTouched, setTypeTouched] = useState(false)
  const shownType = typeTouched ? type : defaultTypeForKey(name)
  return (
    <div className="amx-prop-row amx-prop-new">
      <input
        className="amx-prop-key"
        autoFocus
        value={name}
        placeholder={t('amprops.keyPlaceholder')}
        aria-label={t('amprops.addLabel')}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return // 输入法选词回车不是提交
          if (e.key === 'Enter') { e.preventDefault(); onAdd(name, shownType) } else if (e.key === 'Escape') { e.preventDefault(); onCancel() }
        }}
      />
      <select
        className="amx-prop-type"
        aria-label={t('amprops.type')}
        value={shownType}
        onChange={(e) => { setType(e.target.value as PropType); setTypeTouched(true) }}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onCancel() } }}
      >
        {PROP_TYPES.map((ty) => <option key={ty} value={ty}>{t(`amprops.type.${ty}`)}</option>)}
      </select>
      <button className="amx-prop-del amx-prop-new-btn" title={t('amprops.addConfirm')} aria-label={t('amprops.addConfirm')} onClick={() => onAdd(name, shownType)}><Check size={12} /></button>
      <button className="amx-prop-del amx-prop-new-btn" title={t('amprops.addCancel')} aria-label={t('amprops.addCancel')} onClick={onCancel}><X size={12} /></button>
    </div>
  )
}

/** 值里的 `[[x]]` 拆段渲染:链接可点(按下即开、不进编辑),其余是纯文本。 */
function WikiText({ text, onOpenLink }: { text: string; onOpenLink: (inner: string) => void }) {
  const parts: ReactNode[] = []
  const re = /\[\[([^\]\n]+)\]\]/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    const inner = m[1]
    const bar = inner.indexOf('|')
    parts.push(
      <span
        key={m.index}
        className="amx-prop-link"
        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onOpenLink(inner) }}
        onClick={(e) => e.stopPropagation()} // 不让随后的 click 冒到展示框 → 进编辑态
      >
        {bar >= 0 ? inner.slice(bar + 1) : inner}
      </span>,
    )
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts}</>
}

/** 含 `[[x]]` 的文本值:平时渲染成双链(可点),点空白处 / 聚焦回车进入原来的文本框编辑(草稿契约不分叉,仍走 TextValueInput)。 */
function LinkTextValue({ value, onCommit, onOpenLink }: { value: string; onCommit: (v: string) => void; onOpenLink: (inner: string) => void }) {
  const { t } = useI18n()
  const [editing, setEditing] = useState(false)
  if (editing) return <TextValueInput current={value} autoFocus onCommit={onCommit} onDone={() => setEditing(false)} />
  return (
    <div
      className="amx-prop-input amx-prop-links"
      tabIndex={0}
      title={t('amprops.linksHint')}
      onClick={() => setEditing(true)}
      onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); setEditing(true) } }}
    >
      <WikiText text={value} onOpenLink={onOpenLink} />
    </div>
  )
}

function ValueEditor({ value, onCommit, onOpenLink }: { value: unknown; onCommit: (v: unknown) => void; onOpenLink: (inner: string) => void }) {
  const { t } = useI18n()
  if (typeof value === 'boolean') {
    return <input type="checkbox" className="amx-prop-check" checked={value} onChange={(e) => onCommit(e.target.checked)} />
  }
  if (isScalarArray(value)) {
    return <ChipsEditor items={value.map((x) => String(x ?? ''))} onCommit={onCommit} onOpenLink={onOpenLink} />
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
  if (typeof value === 'string' && !value.includes('\n') && hasWikiLink(value)) {
    return <LinkTextValue value={value} onCommit={onCommit} onOpenLink={onOpenLink} />
  }
  if (typeof value === 'string' || value == null) {
    // 多行字符串(`desc: |` 之类)用多行框:单行框会把换行吃掉,一改就把整段压成一行(D-20)
    return <TextValueInput current={value ?? ''} multiline={typeof value === 'string' && value.includes('\n')} onCommit={onCommit} />
  }
  return <span className="amx-prop-nested" title={t('amprops.nestedHint')}>{stringifyYaml(value).trimEnd()}</span>
}

/** 字符串/数字值框:受控草稿,失焦只在真改了时提交(见文件头 C-01)。multiline = 多行字符串,换成多行框(D-20)。
 *  autoFocus / onDone:含双链的值从展示态切进来编辑(C-19),失焦提交后交回展示态。 */
function TextValueInput({ current, norm, multiline = false, autoFocus, onCommit, onDone }: { current: string; norm?: (s: string) => string; multiline?: boolean; autoFocus?: boolean; onCommit: (v: string) => void; onDone?: () => void }) {
  const { t } = useI18n()
  const f = useFieldDraft(current, onCommit, { norm, enterCommits: !multiline })
  const props = {
    className: `amx-prop-input${multiline ? ' amx-prop-multiline' : ''}${f.conflict ? ' amx-prop-conflict' : ''}`,
    value: f.shown,
    title: f.conflict ? t('amprops.conflict', { v: current }) : undefined,
    autoFocus,
    onKeyDown: f.onKeyDown,
    onBlur: () => {
      const next = f.settle()
      if (next !== null) onCommit(next)
      onDone?.()
    },
  }
  return multiline
    ? <textarea {...props} rows={Math.min(8, f.shown.replace(/\n$/, '').split('\n').length)} spellCheck={false} onChange={(e) => f.change(e.target.value)} />
    : <input {...props} onChange={(e) => f.change(e.target.value)} />
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

/** 字符串数组(tags 等):chips + 回车追加、× 移除。项是 `[[x]]` 时渲染成可点双链(C-19)。 */
function ChipsEditor({ items, onCommit, onOpenLink }: { items: string[]; onCommit: (v: string[]) => void; onOpenLink?: (inner: string) => void }) {
  const { t } = useI18n()
  const [draft, setDraft] = useState('')
  const add = (): void => {
    const next = draft.trim()
    setDraft('')
    if (next && !items.includes(next)) onCommit([...items, next])
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return // 输入法选词的回车 / 逗号不是提交(C-19)
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add() }
    else if (e.key === 'Backspace' && !draft && items.length) onCommit(items.slice(0, -1))
  }
  return (
    <div className="amx-prop-chips">
      {items.map((tag, i) => (
        <span className="amx-chip" key={`${i}:${tag}`}>
          {onOpenLink && hasWikiLink(tag) ? <WikiText text={tag} onOpenLink={onOpenLink} /> : tag}
          <button className="amx-chip-x" onClick={() => onCommit(items.filter((_, j) => j !== i))}><X size={10} /></button>
        </span>
      ))}
      <input value={draft} placeholder={items.length ? '' : t('amprops.chipsPlaceholder')} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} onBlur={add} />
    </div>
  )
}
