import { describe, expect, it } from 'vitest'
import { icsToAggDb, ICS_DESCRIPTION_COL, ICS_LOCATION_COL, ICS_URL_COL } from './icsCalendarStore'

const sub = { id: 's', name: '工作日历', url: '' }
const base = { allDay: false, start: '2026-11-18T09:00', end: '2026-11-18T10:00' }

describe('icsToAggDb 地点 / 说明 / 链接三列(2026-11-15)', () => {
  it('这本日历里有事件带哪一项,就多哪一列;每行只在有值时带 cell', () => {
    const db = icsToAggDb(sub, [
      { ...base, uid: 'a', summary: '评审', location: '3 楼', url: 'https://x.test/a' },
      { ...base, uid: 'b', summary: '站会' },
    ])
    expect(db.columns.map((c) => c.id)).toEqual(['name', 'date', ICS_LOCATION_COL, ICS_URL_COL])
    expect(db.columns.find((c) => c.id === ICS_URL_COL)?.type).toBe('url')
    expect(db.rows[0].cells).toMatchObject({ [ICS_LOCATION_COL]: '3 楼', [ICS_URL_COL]: 'https://x.test/a' })
    expect(db.rows[1].cells).not.toHaveProperty(ICS_LOCATION_COL)
    expect(db.columns.some((c) => c.id === ICS_DESCRIPTION_COL)).toBe(false)
  })
  it('一项都没有:还是老的两列(老缓存 / 不带地点的日历不变)', () => {
    expect(icsToAggDb(sub, [{ ...base, uid: 'a', summary: '会' }]).columns.map((c) => c.id)).toEqual(['name', 'date'])
  })
})
