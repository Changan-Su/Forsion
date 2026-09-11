import { describe, expect, it } from 'vitest'
import { AUTO_COLUMN_MAX, AUTO_COLUMN_MIN, autoColumnWidths, estimatedTextWidth } from './autoColumnWidth'

describe('多维表自适应列宽', () => {
  it('短枚举列收在最小宽，长主内容列按内容展开', () => {
    const columns = [{ id: 'user', name: '用户' }, { id: 'role', name: '角色' }]
    const rows = [
      { user: 'someone_1788504658526', role: 'USER' },
      { user: 'Forsion_Official', role: 'ADMIN' },
    ]
    const widths = autoColumnWidths(columns, rows, (row, column) => ({ text: row[column.id as 'user' | 'role'] }))
    expect(widths.role).toBe(AUTO_COLUMN_MIN)
    expect(widths.user).toBeGreaterThan(widths.role)
  })

  it('副内容不进入样本时，无论多长都不会改变列宽', () => {
    const columns = [{ id: 'name', name: '模型' }]
    const shortSub = [{ primary: 'ChatGPT 5 Mini', sub: 'auxiliary' }]
    const longSub = [{ primary: 'ChatGPT 5 Mini', sub: 'x'.repeat(2_000) }]
    const a = autoColumnWidths(columns, shortSub, (row) => ({ text: row.primary }))
    const b = autoColumnWidths(columns, longSub, (row) => ({ text: row.primary }))
    expect(b).toEqual(a)
  })

  it('chip / 操作按钮计入各自内边距，极长主内容仍受最大宽保护', () => {
    const columns = [{ id: 'tags', name: '标签' }, { id: 'actions', name: '操作' }, { id: 'note', name: '说明' }]
    const rows = [{ id: 'r1' }]
    const widths = autoColumnWidths(columns, rows, (_row, column) => {
      if (column.id === 'tags') return { kind: 'chips', pieces: ['产品', '设计'] }
      if (column.id === 'actions') return { kind: 'actions', pieces: ['编辑', '删除'] }
      return { text: '很长'.repeat(500) }
    })
    expect(widths.tags).toBeGreaterThan(AUTO_COLUMN_MIN)
    expect(widths.actions).toBeGreaterThan(AUTO_COLUMN_MIN)
    expect(widths.note).toBe(AUTO_COLUMN_MAX)
    expect(estimatedTextWidth('角色')).toBeGreaterThan(estimatedTextWidth('Role'))
  })
})
