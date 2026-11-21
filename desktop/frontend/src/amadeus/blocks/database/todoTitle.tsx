/** 待办清单的标题列 = 待办 Chat Box(`format: 'inline'`)写的行内 Markdown(2026-11-21 用户定「存 Markdown 各处渲染」)。
 *  哪张表算待办清单、以及不可点的画法,表格格子和任务卡共用这一份。 */
import { Fragment, type ReactNode } from 'react'
import type { DbColumn } from '@amadeus-shared/db/schema'
import { memberOf } from '../../store/calendarConfigStore'
import { HUMAN_CAL } from '../../store/humanCalendarIo'
import { parseInlineMarkdown } from '../../../components/chatbox/chatBoxMarkdown'

type Cols = readonly Pick<DbColumn, 'id' | 'type'>[]

/** 已知映射的完成列时(日历成员):完成列仍是勾选列、首列是文本 → 首列 id,否则 null。 */
export function todoTitleCol(columns: Cols, checkboxCol: string | undefined): string | null {
  const first = columns[0]
  if (!first || first.type !== 'text') return null
  return checkboxCol && columns.some((c) => c.id === checkboxCol && c.type === 'checkbox') ? first.id : null
}

/** 待办清单(日历成员且映射的完成列仍是勾选列,或人类日历)且首列是文本:返回首列 id,否则 null。 */
export function todoTitleColumn(vault: string, byVault: Parameters<typeof memberOf>[1], dbPath: string, columns: Cols): string | null {
  if (dbPath === HUMAN_CAL) return columns[0]?.type === 'text' ? columns[0].id : null
  return todoTitleCol(columns, memberOf(vault, byVault, dbPath)?.checkboxCol)
}

/** 照格式画、不接点击(点它就是点所在那一格 / 进编辑):双链和链接只画样子。 */
export function InlineMarkdownText({ md }: { md: string }): ReactNode {
  return parseInlineMarkdown(md).map((tok, i) => {
    let node: ReactNode = tok.wiki !== undefined ? <span className="amx-db-wikilink is-inert">{tok.text}</span> : tok.text
    if (tok.code) node = <code>{node}</code>
    if (tok.strike) node = <del>{node}</del>
    if (tok.em) node = <em>{node}</em>
    if (tok.strong) node = <strong>{node}</strong>
    if (tok.href !== undefined && tok.wiki === undefined) node = <span className="amx-db-url is-inert">{node}</span>
    return <Fragment key={i}>{node}</Fragment> // no wrapper: a plain title stays one text node, as before
  })
}
