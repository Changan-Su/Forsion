/** 待办清单的标题列 = 待办 Chat Box(`format: 'inline'`)写的行内 Markdown(2026-11-21 用户定「存 Markdown 各处渲染」)。
 *  哪张表算待办清单、以及不可点的画法,表格格子和任务卡共用这一份。 */
import type { ReactNode } from 'react'
import type { DbColumn } from '@amadeus-shared/db/schema'
import { memberOf } from '../../store/calendarConfigStore'
import { HUMAN_CAL } from '../../store/humanCalendarIo'
import { parseInlineMarkdown } from '../../../components/chatbox/chatBoxMarkdown'

/** 待办清单(日历成员且映射的完成列仍是勾选列,或人类日历)且首列是文本:返回首列 id,否则 null。 */
export function todoTitleColumn(vault: string, byVault: Parameters<typeof memberOf>[1], dbPath: string, columns: readonly Pick<DbColumn, 'id' | 'type'>[]): string | null {
  const first = columns[0]
  if (!first || first.type !== 'text') return null
  if (dbPath === HUMAN_CAL) return first.id
  const check = memberOf(vault, byVault, dbPath)?.checkboxCol // only while the mapped Done column still is one
  return check && columns.some((c) => c.id === check && c.type === 'checkbox') ? first.id : null
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
    return <span key={i}>{node}</span>
  })
}
