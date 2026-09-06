// Popup for [[ autocomplete. Suggests pages AND vault files (fuzzy) and lets the user insert one.
// 候选不按 basename 去重 —— 每个路径一行,重名时插入带路径的链接 `dir/Name|Name`(「唯一即最短」);
// onPick 收到的就是最终 [[ ]] 内文。行是单行密排(与 slash / ctx 菜单同一 28px 正典),目录**只在重名时**
// 作右侧灰字 —— 不然两个 README 长得一样而 linkInner 悄悄选了一个(用户 09-05:「路径可以去掉」)。
// 文件(.db/附件)候选保留扩展名(文件命名空间凭扩展名区分页面,见 lib/vaultFiles),带小图标。
// Only intercepts navigation keys (Arrow/Enter/Tab/Esc) in the capture phase — letters
// and Backspace fall through to ProseMirror so the in-document query keeps updating.

import { useEffect, useLayoutEffect, useState } from 'react'
import { OverlayAt } from '../../lib/clampMenu'
import { pickWikiResults, type Cand } from './wikiRank'
import { isFileRef } from '../../lib/vaultFiles'
import { pageKey } from '@amadeus-shared/links'
import { AttachmentIcon, DatabaseTableViewIcon } from '../../components/icons'
import { dateCandidates } from './dateQuery'
import { usePageStore } from '../../store/pageStore'
import { registerMessages, useI18n } from '../../../i18n'

registerMessages({
  'wiki.sec.date': { zh: '日期', en: 'Date' },
  'wiki.sec.page': { zh: '链接到页面', en: 'Link to page' },
  'wiki.create': { zh: '新建链接 “{q}”', en: 'New link “{q}”' },
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

export function WikiSuggest({ query, left, top, anchorTop, getPageNames, getFiles, onPick, onPickRaw, onClose, allowCreate = true, dates = false }: Props) {
  const [active, setActive] = useState(0)
  const { t } = useI18n()
  const icons = usePageStore((s) => s.icons) // 页面 emoji(path 键);非 vault 候选池查不到 → 无图标,天然兼容

  const cands: Cand[] = [
    ...getPageNames().map((p) => ({ path: p, base: baseName(p), file: false })),
    ...(getFiles?.() ?? []).map((p) => ({ path: p, base: fileBase(p), file: true })),
  ]
  const dupes = new Map<string, number>()
  for (const c of cands) dupes.set(candKey(c), (dupes.get(candKey(c)) ?? 0) + 1)
  // 排序 + 文件保底名额见 ./wikiRank(附件/数据库曾被页面整页挤掉,单测钉在 wikiRank.test.ts)。
  const results = pickWikiResults(cands, query)
  const dateCands = dates ? dateCandidates(query) : []
  const q = query.trim()
  // 查询串本身像文件名([[xxx.db]])时不给「新建链接」:createWikiPage 会造出 xxx.db.md 怪胎。
  const showCreate =
    allowCreate && q.length > 0 && !isFileRef(q) && !cands.some((c) => candKey(c) === pageKey(q))
  const total = dateCands.length + results.length + (showCreate ? 1 : 0)

  /** 「唯一即最短」:basename 全库唯一 → 裸名;重名 → `dir/Name|Name`(路径解析 + 别名显示)。 */
  const linkInner = (c: Cand): string => {
    if ((dupes.get(candKey(c)) ?? 0) <= 1) return c.base
    const path = c.path.replace(/\\/g, '/')
    return `${c.file ? path : path.replace(/\.md$/i, '')}|${c.base}`
  }

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
    const pick = (i: number): void => {
      if (dateCands[i]) onPickRaw?.(dateCands[i].insert)
      else if (showCreate && i === dateCands.length + results.length) onPick(q)
      else if (results[i - dateCands.length]) onPick(linkInner(results[i - dateCands.length]))
    }
    const onKey = (e: KeyboardEvent): void => {
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
        pick(active)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const pick = (i: number): void => {
    if (dateCands[i]) onPickRaw?.(dateCands[i].insert)
    else if (showCreate && i === dateCands.length + results.length) onPick(q)
    else if (results[i - dateCands.length]) onPick(linkInner(results[i - dateCands.length]))
  }

  if (total === 0) return null

  // 键盘选中项滚进可视区(block:'nearest' 已可见时是空操作,鼠标 hover 不会乱跳);同 slash。
  const reveal = (i: number) => (i === active ? (el: HTMLButtonElement | null) => el?.scrollIntoView({ block: 'nearest' }) : undefined)

  return (
    <OverlayAt className="wiki-suggest" x={left} y={top} anchorTop={anchorTop} role="menu">
      {/* 分组标签只在 @ 提及场景(Notion 的 Date / Link to page);[[ 只有页面,标签是噪音。 */}
      {dates && dateCands.length > 0 && <div className="slash-group-label">{t('wiki.sec.date')}</div>}
      {dateCands.map((d, i) => (
        <button
          key={d.insert}
          className="wiki-item"
          data-active={i === active || undefined}
          ref={reveal(i)}
          onMouseEnter={() => setActive(i)}
          onMouseDown={(e) => {
            e.preventDefault()
            pick(i)
          }}
          role="menuitem"
        >
          <span className="wiki-item-name">{d.label}</span>
          <span className="wiki-item-hint">{d.hint}</span>
        </button>
      ))}
      {dates && results.length > 0 && <div className="slash-group-label">{t('wiki.sec.page')}</div>}
      {results.map((c, i) => (
        <button
          key={(c.file ? 'f:' : 'p:') + c.path}
          className="wiki-item"
          data-active={i + dateCands.length === active || undefined}
          ref={reveal(i + dateCands.length)}
          onMouseEnter={() => setActive(i + dateCands.length)}
          onMouseDown={(e) => {
            e.preventDefault()
            pick(i + dateCands.length)
          }}
          role="menuitem"
        >
          <span className="wiki-item-name">
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
          </span>
          {(dupes.get(candKey(c)) ?? 0) > 1 && <span className="wiki-item-hint">{dirOf(c.path) || '/'}</span>}
        </button>
      ))}
      {showCreate && (
        <button
          className="wiki-item wiki-create"
          data-active={active === dateCands.length + results.length || undefined}
          ref={reveal(dateCands.length + results.length)}
          onMouseEnter={() => setActive(dateCands.length + results.length)}
          onMouseDown={(e) => {
            e.preventDefault()
            pick(dateCands.length + results.length)
          }}
          role="menuitem"
        >
          {/* 同其余行包进 .wiki-item-name 拿 ellipsis:裸文本是匿名 flex item,min-width:auto 不可收缩,
              长查询串会把面板顶出横向滚动(评审实测 panel scrollWidth 354 > clientWidth 318)。 */}
          <span className="wiki-item-name">{t('wiki.create', { q })}</span>
        </button>
      )}
    </OverlayAt>
  )
}
