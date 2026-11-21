// @vitest-environment happy-dom
/** 待办清单的标题列是待办 Chat Box(format: 'inline')写的行内 Markdown(11-21):表格里照格式显示,看板等视图读纯文字;
 *  不是待办清单的表(不在日历里 / 没有完成列)的文本格照旧只认 [[双链]],`**` 原样显示。真挂 DatabaseEmbed,dbStore 直接喂数据。 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as React from 'react'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { DbFile } from '@amadeus-shared/db/schema'

vi.mock('../../api', () => ({ amadeus: {} }))
await import('./DatabaseEmbed') // 收集阶段先转译整张模块图,见 dbCellWikilink.test
const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean; React: typeof React }
g.IS_REACT_ACT_ENVIRONMENT = true
g.React = React

const REF = '待办.db'
const VAULT = '/v'
const TITLE = '**会前材料**：设计 [[评审议程]] snake_case'
const mkDb = (): DbFile => ({
  version: 1, name: '待办',
  columns: [{ id: 'name', name: '事项', type: 'text' }, { id: 'date', name: '日期', type: 'calendarDate' }, { id: 'done', name: '完成', type: 'checkbox' }],
  rows: [{ id: 'r1', cells: { name: TITLE } }],
} as unknown as DbFile)

let root: Root | null = null
const host = (): HTMLElement => document.getElementById('host')!

async function mount(member: { dateCol: string; checkboxCol?: string } | null): Promise<void> {
  const { DatabaseEmbed } = await import('./DatabaseEmbed')
  const { useDbStore } = await import('../../store/dbStore')
  const { usePageStore } = await import('../../store/pageStore')
  const { useCalendarConfig } = await import('../../store/calendarConfigStore')
  usePageStore.setState({ pages: ['评审议程.md'], vaultRoot: VAULT }) // first: a vault switch clears the db store
  useDbStore.setState({ entries: { [REF]: { status: 'ok', path: REF, data: mkDb() } } })
  useCalendarConfig.setState({ byVault: { [VAULT]: { colors: {}, hidden: [], defaultDbPath: null, members: member ? { [REF]: member } : {}, migrated: true } as never } })
  document.body.innerHTML = '<div id="host"></div>'
  root = createRoot(host())
  await act(async () => { root!.render(createElement(DatabaseEmbed, { target: REF, pagePath: 'n.md' })) })
}

describe('待办清单标题列的行内 Markdown', () => {
  beforeEach(() => { root?.unmount(); root = null })

  it('在日历里、有完成列:表格照格式显示,双链可点,没有标记符号', async () => {
    await mount({ dateCol: 'date', checkboxCol: 'done' })
    const cell = host().querySelector('.amx-db-value-text')!
    expect(cell.querySelector('strong')?.textContent).toBe('会前材料')
    expect(cell.querySelector('.amx-db-wikilink')?.textContent).toBe('评审议程')
    expect(cell.textContent).toBe('会前材料：设计 评审议程 snake_case')
  })
  it('点进编辑态:输入框里是原文(带标记)', async () => {
    await mount({ dateCol: 'date', checkboxCol: 'done' })
    await act(async () => { host().querySelector<HTMLElement>('.amx-db-value-display')!.click() })
    expect(host().querySelector<HTMLInputElement>('.amx-db-input')!.value).toBe(TITLE)
  })
  it('只在日历里、没有完成列(纯日程表):照旧,`**` 原样', async () => {
    await mount({ dateCol: 'date' })
    const cell = host().querySelector('.amx-db-value-text')!
    expect(cell.querySelector('strong')).toBeNull()
    expect(cell.textContent).toBe('**会前材料**：设计 评审议程 snake_case')
  })
  it('不在日历里:照旧', async () => {
    await mount(null)
    expect(host().querySelector('.amx-db-value-text strong')).toBeNull()
  })
})
