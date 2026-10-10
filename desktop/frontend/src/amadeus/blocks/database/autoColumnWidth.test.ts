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
    // 同样两个字符,中文比拉丁字母宽(按字符类别估,不按字符数)。别拿「角色 / Role」比:系统字体下 Role 实测更宽
    expect(estimatedTextWidth('角色')).toBeGreaterThan(estimatedTextWidth('Ro'))
  })

  // 实测真值:13px / 400 字重,整串在真浏览器里量(canvas measureText 与 DOM 宽一致),2026-10-10。
  // 两列 = 默认界面字体 Hanken Grotesk / 系统字体(genesis-glass 主题的 --font-ui,macOS 上是 SF)。
  // 改字符类别或系数前先重量一遍(DESIGN「自动列宽是排版的一部分」);别为了让列窄一点把这里的数改小。
  const MEASURED: [text: string, hanken: number, system: number][] = [
    ['phone_13900000001_1791006181995', 221.6, 231],
    ['xuanxichen636@gmail.com', 157.9, 166.8],
    ['FORSION_OFFICIAL_ACCOUNT', 179.6, 191.9],
    ['2026-10-10 14:03', 102.4, 109.9],
    ['4000 8888 2345 6789', 126.6, 140.1],
    ['Research database interactions · 交互调研', 245.7, 253.6],
    ['项目记录（第二版），已完成', 162.5, 162.5],
    ['www.communications-management.com', 234.4, 246.4],
    ['Windows Media Manager', 146.6, 151.9],
    ['suspended', 63.4, 66.9],
    ['11111111111', 80.1, 65.5],
    // 校准不许把任何字符估得比原来窄:这两个原先在最宽一档,挪去和大写同档后系统字体下反而会被截(评审抓到)
    ['&'.repeat(20), 178.4, 183.4],
    ['#'.repeat(20), 181.7, 162.2],
  ]
  // 列宽 = 估宽 + 24;其中 16 是单元格左右内边距、1 是右边线,剩下 7 才是估算可以少算的上限
  const SLACK = 7

  it.each(MEASURED)('主内容「%s」的估宽盖得住两套界面字体下的实测宽', (text, hanken, system) => {
    expect(estimatedTextWidth(text) + SLACK).toBeGreaterThanOrEqual(Math.max(hanken, system))
  })

  it('数字等宽:「1」和别的数字一样宽(默认界面字体的数字是等宽的,把 1 当窄字符会裁掉手机号、时间戳的末尾)', () => {
    expect(estimatedTextWidth('1111')).toBe(estimatedTextWidth('0000'))
  })

  it('带头像的机器用户名整行可见(后台用户表里末尾两位被裁掉的那一例)', () => {
    const widths = autoColumnWidths([{ id: 'user', name: '用户' }], [{}], () => ({ text: 'phone_13900000001_1791006181995', avatar: true }))
    expect(widths.user).toBeGreaterThanOrEqual(267) // 221.6 文字 + 16 内边距 + 28 头像与间距 + 1 边线
  })
})
