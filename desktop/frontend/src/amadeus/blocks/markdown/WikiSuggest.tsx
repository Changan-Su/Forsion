// Popup for [[ autocomplete. Suggests pages AND vault files (fuzzy) and lets the user insert one.
// 候选不按 basename 去重 —— 每个路径一行,重名时插入带路径的链接 `dir/Name|Name`(「唯一即最短」);
// onPick 收到的就是最终 [[ ]] 内文。行是单行密排(与 slash / ctx 菜单同一 28px 正典),目录**只在重名时**
// 作右侧灰字 —— 不然两个 README 长得一样而 linkInner 悄悄选了一个(用户 09-05:「路径可以去掉」)。
// 文件(.db/附件)候选保留扩展名(文件命名空间凭扩展名区分页面,见 lib/vaultFiles),带小图标。
// L-13(评审 2026-09-27):fm `aliases:` 也是候选(选中插 `[[笔记|别名]]`);`[[笔记#` 之后列目标笔记的标题、
// `[[笔记#^` 之后只列已有的块 ID(`[[#` = 本篇);带 `#` / `|` / `^` 的查询不给「新建链接」行。
// Only intercepts navigation keys (Arrow/Enter/Tab/Esc) in the capture phase — letters
// and Backspace fall through to ProseMirror so the in-document query keeps updating.

import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react'
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
import { registerMessages, useI18n } from '../../../i18n'

registerMessages({
  'wiki.sec.date': { zh: '日期', en: 'Date' },
  'wiki.sec.page': { zh: '链接到页面', en: 'Link to page' },
  'wiki.create': { zh: '新建链接 “{q}”', en: 'New link “{q}”' },
  'wiki.aliasOf': { zh: '别名 → {name}', en: 'Alias → {name}' },
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
  /** 链接所在笔记(vault 相对路径):`[[名#` 按它就近解析目标,`[[#` 就是它本身。缺 = 不做 `#` / `^` 补全。 */
  sourcePath?: string
}

/** 一行候选:section 变化处出分组标签(只在 @ 的日期 / 页面两区)。 */
interface Row {
  key: string
  name: ReactNode
  hint?: string
  create?: boolean
  section?: 'date' | 'page'
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

export function WikiSuggest({ query, left, top, anchorTop, getPageNames, getFiles, onPick, onPickRaw, onClose, editorFocused, sourcePath, allowCreate = true, dates = false }: Props) {
  const [active, setActive] = useState(0)
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
    const showCreate =
      allowCreate && q.length > 0 && !isFileRef(q) && !/[#|^]/.test(q)
      && !cands.some((c) => (c.alias ? c.alias.toLowerCase() === q.toLowerCase() : candKey(c) === pageKey(q)))
    if (showCreate) rows.push({ key: 'create', name: t('wiki.create', { q }), create: true, pick: () => onPick(q) })
  }
  const total = rows.length

  useEffect(() => {
    setActive(0)
  }, [query])

  // ⚠️ useLayoutEffect 而非 useEffect:被动 effect 的 cleanup 排在提交之后的调度任务里,面板已经
  // 从 DOM 消失、旧监听器却还挂在 window 上 —— 那个窗口里的 Enter 仍会被吞,甚至按**过期的**
  // results 选中错误页面(Codex 评审)。layout effect 在提交时同步摘除,窗口为零。
  useLayoutEffect(() => {
    // 面板无内容时 render 早退(total === 0),但 effect 照跑 —— 不加这道闸,一个看不见的面板
    // 仍在捕获阶段吞掉 Enter/Tab/↑↓(用户实报「@ 之后回车换不了行」)。见 allowCreate 注释的契约。
    if (total === 0) return
    const onKey = (e: KeyboardEvent): void => {
      // IME 组字中一律放行(L-08):拼音选词就是 ↓ / Enter,被面板抢走就成了「回车直接插入候选」。
      // `【【` 转成 `[[` 之后用户多半还在中文输入法下,这是高频路径。Process/229 覆盖 isComposing
      // 尚未置位的首帧(同 SlashMenu / PasteAsMenu)。
      if (e.isComposing || e.key === 'Process' || e.keyCode === 229) return
      if (editorFocused && !editorFocused()) return // 焦点已在编辑器之外:放行(L-04)
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
        rows[active]?.pick()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  if (total === 0) return null

  // 键盘选中项滚进可视区(block:'nearest' 已可见时是空操作,鼠标 hover 不会乱跳);同 slash。
  const reveal = (i: number) => (i === active ? (el: HTMLButtonElement | null) => el?.scrollIntoView({ block: 'nearest' }) : undefined)

  return (
    // 按下面板空白/分组标签/滚动条不夺编辑器焦点:失焦即关(L-04)后,不拦这一下面板会自己关掉。
    <OverlayAt className="wiki-suggest" x={left} y={top} anchorTop={anchorTop} role="menu" onMouseDown={(e) => e.preventDefault()}>
      {rows.map((r, i) => (
        <RowButton key={r.key} r={r} i={i} active={active} setActive={setActive} reveal={reveal}
          // 分组标签只在 @ 提及场景(Notion 的 Date / Link to page);[[ 只有页面,标签是噪音。
          label={dates && r.section && r.section !== rows[i - 1]?.section ? t(r.section === 'date' ? 'wiki.sec.date' : 'wiki.sec.page') : undefined}
        />
      ))}
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
