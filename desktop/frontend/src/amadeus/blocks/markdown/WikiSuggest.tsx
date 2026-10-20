// Popup for [[ autocomplete. Suggests pages AND vault files (fuzzy) and lets the user insert one.
// 候选不按 basename 去重 —— 每个路径一行,重名时插入带路径的链接 `dir/Name|Name`(「唯一即最短」);
// onPick 收到的就是最终 [[ ]] 内文。行是单行密排(与 slash / ctx 菜单同一 28px 正典),目录**只在重名时**
// 作右侧灰字 —— 不然两个 README 长得一样而 linkInner 悄悄选了一个(用户 09-05:「路径可以去掉」)。
// 文件(.db/附件)候选保留扩展名(文件命名空间凭扩展名区分页面,见 lib/vaultFiles),带小图标。
// L-13(评审 2026-09-27):fm `aliases:` 也是候选(选中插 `[[笔记|别名]]`);`[[笔记#` 之后列目标笔记的标题、
// `[[笔记#^` 之后只列已有的块 ID(`[[#` = 本篇);带 `#` / `|` / `^` 的查询不给「新建链接」行。
// 应用 / 窗口引用(shared/appRefs.ts):宿主有 `window.tangu.appRefs` 时 `[[` 面板多出开着的窗口与应用两类候选,
// 顶上一排分类胶囊(全部 / 窗口 / 应用 / 笔记,←/→ 切);选中插 `[[app://…|名字]]` / `[[window://…|标题]]`。
// 没有这个接口(网页版 / 手机 / 非 macOS)、`@` 提及、`#` 锚点补全都不出分类条,面板与从前逐字相同。
// Only intercepts navigation keys (Arrow/Enter/Tab/Esc) in the capture phase — letters
// and Backspace fall through to ProseMirror so the in-document query keeps updating.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { OverlayAt } from '../../lib/clampMenu'
import { pickWikiResults, type Cand } from './wikiRank'
import { isFileRef } from '../../lib/vaultFiles'
import { pageKey, resolvePageName } from '@amadeus-shared/links'
import { AttachmentIcon, DatabaseTableViewIcon } from '../../components/icons'
import { dateCandidates } from './dateQuery'
import { usePageStore } from '../../store/pageStore'
import { useVaultAliases } from '../../lib/vaultAliases'
import { fuzzyScore } from '../../lib/fuzzy'
import { amadeus } from '../../api'
import { unifiedBody, unifiedHeadings } from '../../unified/lifecycle'
import { anchorSafe, blockIdsOf, headingsOf, parseSubQuery } from './wikiSubpath'
import { readTangu, type TanguAgentInfo } from '../../plugins/tanguSeam'
import { Bot } from 'lucide-react'
import { registerMessages, useI18n } from '../../../i18n'
import type { AppRefList } from '../../../../../shared/appRefs'
import { AppRefIcon, appRefsSupported } from '../../../components/appRefs'
import { useCapsuleSlide } from '../../../components/capsuleTabs'
import { ALL_APPS, ALL_WINDOWS, appRefInner, isAppRefQuery, mentionCats, moveWikiCat, pickAppRefs, wikiCats, type AppRefCand, type WikiCat } from './wikiAppRefs'
import './slashCategories.css'

registerMessages({
  'wiki.sec.agent': { zh: '交办 Agent', en: 'Assign to an agent' },
  'wiki.agentTask': { zh: '新建任务块', en: 'New task block' },
  'wiki.sec.date': { zh: '日期', en: 'Date' },
  'wiki.sec.page': { zh: '链接到页面', en: 'Link to page' },
  'wiki.sec.window': { zh: '窗口', en: 'Windows' },
  'wiki.sec.app': { zh: '应用', en: 'Apps' },
  'wiki.create': { zh: '新建链接 “{q}”', en: 'New link “{q}”' },
  'wiki.aliasOf': { zh: '别名 → {name}', en: 'Alias → {name}' },
  'wiki.tab.label': { zh: '候选分类', en: 'Suggestion categories' },
  'wiki.tab.all': { zh: '全部', en: 'All' },
  'wiki.tab.window': { zh: '窗口', en: 'Windows' },
  'wiki.tab.app': { zh: '应用', en: 'Apps' },
  'wiki.tab.note': { zh: '笔记', en: 'Notes' },
  'wiki.tab.agent': { zh: 'Agent', en: 'Agents' },
  'wiki.tab.date': { zh: '日期', en: 'Dates' },
  'wiki.tab.empty': { zh: '这一类里没有匹配的', en: 'Nothing matches in this category' },
})

interface Props {
  query: string
  left: number
  top: number
  /** 光标行上沿:下方放不下时翻到上方展开(见 lib/clampMenu → engine menuAnchor)。 */
  anchorTop?: number
  getPageNames: () => string[]
  /** vault 非笔记文件(.db/附件);缺 = 只补全页面(PlainMarkdownEditor)。 */
  getFiles?: () => string[]
  /** 参数 = 最终 [[ ]] 内文(裸名或 `dir/Name|Name`);创建行传原查询串。 */
  onPick: (linkInner: string) => void
  onClose: () => void
  /** false = 不提供「新建链接」行(@ 提及场景:无匹配即整体消失,不劫持 Enter)。 */
  allowCreate?: boolean
  /** true(@ 提及场景)= 查询串同时喂给 dateCandidates,命中就在页面候选**之上**多出日期行
   *  (`@r` → 提醒、`@t` → 今天/明天、`@2200` → 日程/提醒;裸 `@` 三条全给)。Notion 的 `@` 菜单
   *  同款分区(Date / Link to page)。选中走 onPickRaw 而不是 onPick —— 插入的是字面
   *  `@2026-09-01T14:30`,不是 `[[ ]]`。 */
  dates?: boolean
  /** 日期候选的插入回调;调用方负责把它写进文档(见 MarkdownBlock.pickMentionRaw)。 */
  onPickRaw?: (text: string) => void
  /** 宿主编辑器是否持焦。不持焦时一个键都不拦(L-04):失焦后标题框/聊天框里的 ↑↓/Enter 不许被吞。 */
  editorFocused?: () => boolean
  /** 光标后面是不是还有查询词的字(用户回到词中间改错字):是的话 ←/→ 不拿去切分类。不给 = 恒在词尾。 */
  caretMidWord?: () => boolean
  /** 链接所在笔记(vault 相对路径):`[[名#` 按它就近解析目标,`[[#` 就是它本身。缺 = 不做 `#` / `^` 补全。 */
  sourcePath?: string
  agents?: TanguAgentInfo[]
  onPickAgent?: (slug: string) => void
}

/** 一行候选:section 变化处出分组标签(只在 @ 的日期 / 页面两区)。 */
interface Row {
  key: string
  name: ReactNode
  hint?: string
  create?: boolean
  section?: 'date' | 'page' | 'agent' | 'window' | 'app'
  pick: () => void
}

type SubItem = { label: string; insert: string; hint?: string }

/** `[[名#…` 的目标笔记里的标题 / 块 ID(开着的 v4 实例现取,否则读盘);目标解析不到 = null。 */
function useSubItems(target: string | null, kind: 'heading' | 'block' | null): SubItem[] | null {
  const [items, setItems] = useState<SubItem[] | null>(null)
  useEffect(() => {
    if (!target || !kind) { setItems(null); return }
    let live = true
    const done = (md: string | null): void => {
      if (!live) return
      if (md == null) { setItems([]); return }
      setItems(kind === 'heading'
        ? headingsOf(md).map((h) => ({ label: h.text, insert: h.text, hint: `H${h.level}` }))
        : blockIdsOf(md).map((b) => ({ label: `^${b.id}`, insert: `^${b.id}`, hint: b.preview })))
    }
    const live1 = kind === 'heading' ? unifiedHeadings(target) : null
    if (live1) {
      setItems(live1.map((h) => ({ label: anchorSafe(h.text), insert: anchorSafe(h.text), hint: `H${h.level}` })).filter((x) => x.insert))
    } else {
      const body = unifiedBody(target)
      if (body != null) done(body)
      else void amadeus?.readTextFile?.(target).then((t) => done(t), () => done(null))
    }
    return () => { live = false }
  }, [target, kind])
  return items
}

function baseName(p: string): string {
  return (p.split(/[\\/]/).pop() ?? p).replace(/\.md$/i, '')
}

function fileBase(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

function dirOf(p: string): string {
  const q = p.replace(/\\/g, '/')
  const i = q.lastIndexOf('/')
  return i === -1 ? '' : q.slice(0, i)
}

/** 重名判定 key:页面剥 .md 小写(pageKey),文件含扩展名小写 —— 两命名空间天然分立。 */
const candKey = (c: Cand): string => (c.file ? c.base.toLowerCase() : pageKey(c.base))

export function WikiSuggest({ query, left, top, anchorTop, getPageNames, getFiles, onPick, onPickRaw, onClose, editorFocused, caretMidWord, sourcePath, agents = [], onPickAgent, allowCreate = true, dates = false }: Props) {
  const [active, setActive] = useState(0)
  const [, refreshAgents] = useState(0)
  const agentMentions = !!onPickAgent
  useEffect(() => agentMentions ? readTangu()?.subscribeAgents?.(() => refreshAgents((n) => n + 1)) : undefined, [agentMentions])
  const roster = agentMentions ? readTangu()?.agents?.() ?? agents : agents
  const { t } = useI18n()
  const icons = usePageStore((s) => s.icons) // 页面 emoji(path 键);非 vault 候选池查不到 → 无图标,天然兼容
  const aliasMap = useVaultAliases()

  const pageNames = getPageNames()
  const cands: Cand[] = [
    ...pageNames.map((p) => ({ path: p, base: baseName(p), file: false })),
    ...(getFiles?.() ?? []).map((p) => ({ path: p, base: fileBase(p), file: true })),
    // 别名只挂在本候选池里有的笔记上(非笔记库宿主传空页面表 → 一条别名也不会串进来)
    ...pageNames.flatMap((p) => (aliasMap[p] ?? []).map((a) => ({ path: p, base: a, file: false, alias: a }))),
  ]
  const dupes = new Map<string, number>()
  for (const c of cands) if (!c.alias) dupes.set(candKey(c), (dupes.get(candKey(c)) ?? 0) + 1)
  const q = query.trim()

  // `[[名#标题` / `[[名#^块`(L-13):目标 = 按链接所在笔记就近解析;`[[#…` = 本篇。
  const sub = dates ? null : parseSubQuery(query) // @ 提及不做锚点补全
  const subTarget = sub ? (sub.name ? resolvePageName(sub.name, pageNames, sourcePath) : sourcePath || null) : null
  const subItems = useSubItems(subTarget, sub ? sub.kind : null)

  /** 「唯一即最短」:basename 全库唯一 → 裸名;重名 → `dir/Name|Name`(路径解析 + 别名显示)。
   *  别名候选 → `名|别名`(名同样按唯一即最短)。 */
  const linkInner = (c: Cand): string => {
    if (c.alias) {
      const page = { path: c.path, base: baseName(c.path), file: false }
      const name = (dupes.get(candKey(page)) ?? 0) <= 1 ? page.base : c.path.replace(/\\/g, '/').replace(/\.md$/i, '')
      return `${name}|${c.alias}`
    }
    if ((dupes.get(candKey(c)) ?? 0) <= 1) return c.base
    const path = c.path.replace(/\\/g, '/')
    return `${c.file ? path : path.replace(/\.md$/i, '')}|${c.base}`
  }

  const rows: Row[] = []
  if (sub) {
    // 目标解析不到 / 还没读回来 = 空表 → 面板整体不出现,Enter 照常(不再默认高亮「新建 `Alpha#`」)。
    const ranked = (subItems ?? [])
      .map((it) => ({ it, s: fuzzyScore(sub.q, it.insert.replace(/^\^/, '')) }))
      .filter((x) => x.s !== null)
      .sort((a, b) => (b.s as number) - (a.s as number))
      .slice(0, 8)
    for (const { it } of ranked) {
      rows.push({ key: `s:${it.insert}`, name: it.label, hint: it.hint, pick: () => onPick(`${sub.name}#${it.insert}`) })
    }
  } else {
    if (onPickAgent) for (const agent of roster.filter((a) => !q || fuzzyScore(q, a.name) !== null || fuzzyScore(q, a.slug) !== null).slice(0, 6)) {
      rows.push({ key: `agent:${agent.slug}`, name: <><Bot size="1em" aria-hidden="true" />{agent.name}</>, hint: t('wiki.agentTask'), section: 'agent', pick: () => onPickAgent(agent.slug) })
    }
    const dateCands = dates ? dateCandidates(query) : []
    for (const d of dateCands) rows.push({ key: `d:${d.insert}`, name: d.label, hint: d.hint, section: 'date', pick: () => onPickRaw?.(d.insert) })
    // 排序 + 文件保底名额见 ./wikiRank(附件/数据库曾被页面整页挤掉,单测钉在 wikiRank.test.ts)。
    for (const c of pickWikiResults(cands, query)) {
      rows.push({
        key: (c.file ? 'f:' : c.alias ? `a:${c.alias}:` : 'p:') + c.path,
        name: (
          <>
            {c.file ? (
              <span className="wiki-item-ficon" aria-hidden>
                {/\.db$/i.test(c.base) ? <DatabaseTableViewIcon /> : <AttachmentIcon />}
              </span>
            ) : (
              icons[c.path] && (
                <span className="wiki-item-ficon" aria-hidden>
                  {icons[c.path]}
                </span>
              )
            )}
            {c.base}
          </>
        ),
        hint: c.alias ? t('wiki.aliasOf', { name: baseName(c.path) }) : (dupes.get(candKey(c)) ?? 0) > 1 ? dirOf(c.path) || '/' : undefined,
        section: 'page',
        pick: () => onPick(linkInner(c)),
      })
    }
    // 查询串本身像文件名([[xxx.db]])时不给「新建链接」:createWikiPage 会造出 xxx.db.md 怪胎。
    // 带 `#` `|` `^`(锚点 / 别名 / 块)也不给:回车会插出 `[[Alpha#]]` 这类空锚点链接(L-13)。
    // 手写到一半的 `[[app://…` / `[[window://…` 是应用 / 窗口引用,不是笔记名:同样不给。
    const showCreate =
      allowCreate && q.length > 0 && !isFileRef(q) && !/[#|^]/.test(q) && !isAppRefQuery(q)
      && !cands.some((c) => (c.alias ? c.alias.toLowerCase() === q.toLowerCase() : candKey(c) === pageKey(q)))
    if (showCreate) rows.push({ key: 'create', name: t('wiki.create', { q }), create: true, pick: () => onPick(q) })
  }

  // ── 应用 / 窗口候选 + 分类条(见顶注)。列表在面板打开时取一次;取回来之前这两类先空着。
  const hostApps = !dates && appRefsSupported()
  const [appList, setAppList] = useState<AppRefList | null>(null)
  useEffect(() => {
    if (!hostApps) return
    let live = true
    void window.tangu?.appRefs?.list().then((l) => { if (live) setAppList(l) }, () => {})
    return () => { live = false }
  }, [hostApps])
  const offerApps = hostApps && !sub // @ 提及的分类条不含窗口 / 应用
  const cats = dates ? mentionCats(!!onPickAgent && roster.length > 0, cands.length > 0) : wikiCats(offerApps, cands.length > 0)
  const tabbed = cats.length > 0
  const [catChoice, setCatChoice] = useState<WikiCat>('all')
  const cat = cats.includes(catChoice) ? catChoice : 'all'
  const appRow = (c: AppRefCand): Row => ({
    key: `${c.ref.kind}:${c.ref.id}:${c.ref.name}`,
    name: <><AppRefIcon id={c.ref.id} />{c.ref.name}</>,
    hint: c.hint,
    section: c.ref.kind,
    pick: () => onPick(appRefInner(c.ref)),
  })
  const winRows = offerApps ? pickAppRefs(appList, query, 'window').map(appRow) : []
  const appRows = offerApps ? pickAppRefs(appList, query, 'app').map(appRow) : []
  // 「全部」= 从前那一列原样在前(第一行、回车选中的还是它),窗口 / 应用各露几条跟在后面。
  const allRows = [...rows, ...winRows.slice(0, ALL_WINDOWS), ...appRows.slice(0, ALL_APPS)]
  const shown = cat === 'all' ? allRows : cat === 'window' ? winRows : cat === 'app' ? appRows
    : dates ? rows.filter((r) => r.section === (cat === 'note' ? 'page' : cat)) : rows // @:Agent / 日期 / 笔记按行的分区筛
  const total = shown.length
  // 哪一类都没有东西 → 面板整体不出现(同从前);只是当前这一类空着 → 留着分类条,好切回去。
  const visible = allRows.length > 0
  const tabsRef = useCapsuleSlide<HTMLDivElement>(tabbed && visible ? cat : '') // 分类条不在场时给空键:它出现的那一拍才重新量

  // 切类别不许挪面板:同一个 query 内只长不缩(同斜杠菜单 —— 面板开在光标上方时一缩,分类条就从鼠标底下滑走)。
  const shellEl = useRef<HTMLDivElement | null>(null)
  const [heightFloor, setHeightFloor] = useState<{ query: string; height: number } | null>(null)
  const minHeight = tabbed && heightFloor?.query === query ? heightFloor.height : undefined
  useLayoutEffect(() => {
    if (!tabbed) return
    const height = shellEl.current?.offsetHeight ?? 0
    if (height > (minHeight ?? 0)) setHeightFloor({ query, height })
  })

  useEffect(() => {
    setActive(0)
  }, [query])

  // ⚠️ useLayoutEffect 而非 useEffect:被动 effect 的 cleanup 排在提交之后的调度任务里,面板已经
  // 从 DOM 消失、旧监听器却还挂在 window 上 —— 那个窗口里的 Enter 仍会被吞,甚至按**过期的**
  // results 选中错误页面(Codex 评审)。layout effect 在提交时同步摘除,窗口为零。
  useLayoutEffect(() => {
    // 面板无内容时 render 早退(total === 0),但 effect 照跑 —— 不加这道闸,一个看不见的面板
    // 仍在捕获阶段吞掉 Enter/Tab/↑↓(用户实报「@ 之后回车换不了行」)。见 allowCreate 注释的契约。
    if (!visible) return
    const onKey = (e: KeyboardEvent): void => {
      // IME 组字中一律放行(L-08):拼音选词就是 ↓ / Enter,被面板抢走就成了「回车直接插入候选」。
      // `【【` 转成 `[[` 之后用户多半还在中文输入法下,这是高频路径。Process/229 覆盖 isComposing
      // 尚未置位的首帧(同 SlashMenu / PasteAsMenu)。
      if (e.isComposing || e.key === 'Process' || e.keyCode === 229) return
      if (editorFocused && !editorFocused()) return // 焦点已在编辑器之外:放行(L-04)
      // 有分类条时 ←/→ 切类别:分类像是接在查询词后面的几个字(规则见 moveWikiCat)—— 在「全部」上按 ← 是移光标回去改字,
      // 光标回到词中间后两个键都只移光标。带修饰键的不拦:⌘← / ⌥← / Shift+← 照旧挪光标、扩选。
      const nextCat = e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || (cat === 'all' && caretMidWord?.()) ? null : moveWikiCat(cats, cat, e.key)
      if (nextCat) {
        e.preventDefault()
        e.stopPropagation()
        setCatChoice(nextCat)
        setActive(0)
        return
      }
      if (total === 0 && e.key !== 'Escape') return // 当前这一类空着:只认 Esc,回车 / ↑↓ 照常落进编辑器
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        setActive((a) => Math.min(a + 1, total - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        setActive((a) => Math.max(a - 1, 0))
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        e.stopPropagation()
        shown[active]?.pick()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  if (!visible) return null

  // 键盘选中项滚进可视区(block:'nearest' 已可见时是空操作,鼠标 hover 不会乱跳);同 slash。
  const reveal = (i: number) => (i === active ? (el: HTMLButtonElement | null) => el?.scrollIntoView({ block: 'nearest' }) : undefined)

  const list = shown.map((r, i) => (
    <RowButton key={r.key} r={r} i={i} active={active} setActive={setActive} reveal={reveal}
      // 分组标签只在 @ 提及场景(Notion 的 Date / Link to page)与带分类条的「全部」(笔记、窗口、应用混在一列);
      // 只有页面的 [[ 面板里标签是噪音。
      label={(dates || tabbed) && cat === 'all' && r.section && r.section !== shown[i - 1]?.section ? t(`wiki.sec.${r.section}`) : undefined}
    />
  ))

  if (!tabbed) return (
    // 按下面板空白/分组标签/滚动条不夺编辑器焦点:失焦即关(L-04)后,不拦这一下面板会自己关掉。
    <OverlayAt className="wiki-suggest" x={left} y={top} anchorTop={anchorTop} role="menu" onMouseDown={(e) => e.preventDefault()}>
      {list}
    </OverlayAt>
  )
  return (
    <OverlayAt className="wiki-suggest wiki-suggest-tabbed" x={left} y={top} anchorTop={anchorTop} style={{ minHeight }}
      innerRef={(el) => { shellEl.current = el }} onMouseDown={(e) => e.preventDefault()}>
      <div className="wiki-tabs cap-tabs" role="tablist" aria-label={t('wiki.tab.label')} ref={tabsRef}>
        {cats.map((c) => (
          <button key={c} type="button" className="wiki-tab" role="tab" data-category={c} aria-selected={c === cat}
            tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => { setCatChoice(c); setActive(0) }}>
            {t(`wiki.tab.${c}`)}
          </button>
        ))}
      </div>
      <div className="wiki-suggest-list" role="menu">
        {list}
        {total === 0 && <div className="slash-empty">{t('wiki.tab.empty')}</div>}
      </div>
    </OverlayAt>
  )
}

function RowButton({ r, i, active, setActive, reveal, label }: {
  r: Row
  i: number
  active: number
  setActive: (i: number) => void
  reveal: (i: number) => ((el: HTMLButtonElement | null) => void) | undefined
  label?: string
}) {
  return (
    <>
      {label && <div className="slash-group-label">{label}</div>}
      <button
        className={r.create ? 'wiki-item wiki-create' : 'wiki-item'}
        data-active={i === active || undefined}
        ref={reveal(i)}
        onMouseEnter={() => setActive(i)}
        onMouseDown={(e) => {
          e.preventDefault()
          r.pick()
        }}
        role="menuitem"
      >
        {/* 同其余行包进 .wiki-item-name 拿 ellipsis:裸文本是匿名 flex item,min-width:auto 不可收缩,
            长查询串会把面板顶出横向滚动(评审实测 panel scrollWidth 354 > clientWidth 318)。 */}
        <span className="wiki-item-name">{r.name}</span>
        {r.hint && <span className="wiki-item-hint">{r.hint}</span>}
      </button>
    </>
  )
}
