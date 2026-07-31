// Popup for [[ autocomplete. Suggests pages AND vault files (fuzzy) and lets the user insert one.
// Obsidian 式:候选不按 basename 去重 —— 每个路径一行(名字加粗 + 目录副标题),重名时插入
// 带路径的链接 `dir/Name|Name`(「唯一即最短」);onPick 收到的就是最终 [[ ]] 内文。
// 文件(.db/附件)候选保留扩展名(文件命名空间凭扩展名区分页面,见 lib/vaultFiles),带小图标。
// Only intercepts navigation keys (Arrow/Enter/Tab/Esc) in the capture phase — letters
// and Backspace fall through to ProseMirror so the in-document query keeps updating.

import { useEffect, useState } from 'react'
import { OverlayAt } from '../../lib/clampMenu'
import { pickWikiResults, type Cand } from './wikiRank'
import { isFileRef } from '../../lib/vaultFiles'
import { pageKey } from '@amadeus-shared/links'
import { AttachmentIcon, DatabaseTableViewIcon } from '../../components/icons'
import { usePageStore } from '../../store/pageStore'

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

export function WikiSuggest({ query, left, top, anchorTop, getPageNames, getFiles, onPick, onClose, allowCreate = true }: Props) {
  const [active, setActive] = useState(0)
  const icons = usePageStore((s) => s.icons) // 页面 emoji(path 键);非 vault 候选池查不到 → 无图标,天然兼容

  const cands: Cand[] = [
    ...getPageNames().map((p) => ({ path: p, base: baseName(p), file: false })),
    ...(getFiles?.() ?? []).map((p) => ({ path: p, base: fileBase(p), file: true })),
  ]
  const dupes = new Map<string, number>()
  for (const c of cands) dupes.set(candKey(c), (dupes.get(candKey(c)) ?? 0) + 1)
  // 排序 + 文件保底名额见 ./wikiRank(附件/数据库曾被页面整页挤掉,单测钉在 wikiRank.test.ts)。
  const results = pickWikiResults(cands, query)
  const q = query.trim()
  // 查询串本身像文件名([[xxx.db]])时不给「新建链接」:createWikiPage 会造出 xxx.db.md 怪胎。
  const showCreate =
    allowCreate && q.length > 0 && !isFileRef(q) && !cands.some((c) => candKey(c) === pageKey(q))
  const total = results.length + (showCreate ? 1 : 0)

  /** 「唯一即最短」:basename 全库唯一 → 裸名;重名 → `dir/Name|Name`(路径解析 + 别名显示)。 */
  const linkInner = (c: Cand): string => {
    if ((dupes.get(candKey(c)) ?? 0) <= 1) return c.base
    const path = c.path.replace(/\\/g, '/')
    return `${c.file ? path : path.replace(/\.md$/i, '')}|${c.base}`
  }

  useEffect(() => {
    setActive(0)
  }, [query])

  useEffect(() => {
    const pick = (i: number): void => {
      if (showCreate && i === results.length) onPick(q)
      else if (results[i]) onPick(linkInner(results[i]))
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
    if (showCreate && i === results.length) onPick(q)
    else if (results[i]) onPick(linkInner(results[i]))
  }

  if (total === 0) return null

  return (
    <OverlayAt className="wiki-suggest" x={left} y={top} anchorTop={anchorTop} role="menu">
      {results.map((c, i) => (
        <button
          key={(c.file ? 'f:' : 'p:') + c.path}
          className="wiki-item"
          data-active={i === active || undefined}
          onMouseEnter={() => setActive(i)}
          onMouseDown={(e) => {
            e.preventDefault()
            pick(i)
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
          <span className="wiki-item-path">{dirOf(c.path) || '/'}</span>
        </button>
      ))}
      {showCreate && (
        <button
          className="wiki-item wiki-create"
          data-active={active === results.length || undefined}
          onMouseEnter={() => setActive(results.length)}
          onMouseDown={(e) => {
            e.preventDefault()
            pick(results.length)
          }}
          role="menuitem"
        >
          新建链接 “{q}”
        </button>
      )}
    </OverlayAt>
  )
}
