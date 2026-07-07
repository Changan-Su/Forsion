/** Calendar 右栏 = mini 月历(上) + 日历配置(下),竖向分屏。
 *  mini:主题色标今天;当主区 focus 的是 Calendar View 时,额外用淡色条标出其当前可见日期区间
 *  (实时跟随滚动),点某日则请求主区丝滑跳转。非 Calendar 主视图时这些效果关闭。
 *  配置:列出全部含「日历日期」列的多维表,每库可设颜色/显隐/默认库(按 vault 存 localStorage)。 */
import { useEffect, useMemo, useState } from 'react'
import { useWorkspace, activeMainPanel } from '@lcl/engine'
import { usePageStore } from '../amadeus/store/pageStore'
import { useAggregatedDatabases } from '../amadeus/store/dbAggregateStore'
import { useCalendarConfig, colorForDb, isHidden, defaultDbPath } from '../amadeus/store/calendarConfigStore'
import { useCalendarNav } from '../amadeus/store/calendarNavStore'
import { WEEKDAYS, addDays, diffDays, fmtStamp, monthGridDays, monthLabel, startOfDay, toLocalDate } from './calendar/dateUtils'

export function CalendarConfigView() {
  return (
    <div className="amx-calside">
      <MiniCalendar />
      <ConfigList />
    </div>
  )
}

const firstOfMonth = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), 1)

function MiniCalendar() {
  // 主区当前显示的视图是否为 Calendar(取主区组的 activePanel,侧栏获得焦点也不算切走)。
  const focused = useWorkspace((s) => {
    void s.mainTabs // refreshTabs 在激活/布局变化时改它 → 触发本 selector 重算
    const p = s.api ? activeMainPanel(s.api) : null
    return ((p?.params ?? {}) as { __type?: string }).__type === 'calendar'
  })
  const visibleStart = useCalendarNav((s) => s.visibleStart)
  const visibleEnd = useCalendarNav((s) => s.visibleEnd)
  const requestJump = useCalendarNav((s) => s.requestJump)

  const today = useMemo(() => startOfDay(new Date()), [])
  const [month, setMonth] = useState<Date>(() => firstOfMonth(today))

  // Calendar 滚动改变可见区间 → mini 翻到区间中点所在月,让淡色条始终可见(实时跟随)。
  useEffect(() => {
    if (focused && visibleStart && visibleEnd) {
      const a = toLocalDate(visibleStart)
      const mid = addDays(a, Math.floor(diffDays(toLocalDate(visibleEnd), a) / 2))
      setMonth(firstOfMonth(mid))
    }
  }, [focused, visibleStart, visibleEnd])

  const grid = useMemo(() => monthGridDays(month), [month])
  const todayStr = fmtStamp(today, true)
  const inBand = (d: Date): boolean => {
    if (!focused || !visibleStart || !visibleEnd) return false
    const s = fmtStamp(d, true)
    return s >= visibleStart && s <= visibleEnd
  }
  const pick = (d: Date): void => {
    setMonth(firstOfMonth(d))
    if (focused) requestJump(fmtStamp(d, true))
  }

  return (
    <div className="amx-mini">
      <div className="amx-mini-head">
        <button className="amx-mini-nav" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label="上个月">‹</button>
        <span className="amx-mini-title">{monthLabel(month)}</span>
        <button className="amx-mini-nav" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label="下个月">›</button>
      </div>
      <div className="amx-mini-dow">
        {WEEKDAYS.map((w) => (
          <span key={w}>{w}</span>
        ))}
      </div>
      <div className="amx-mini-grid">
        {grid.map((d) => {
          const out = d.getMonth() !== month.getMonth()
          const isToday = fmtStamp(d, true) === todayStr
          return (
            <button
              key={+d}
              className={`amx-mini-day${out ? ' out' : ''}${isToday ? ' today' : ''}${inBand(d) ? ' band' : ''}`}
              onClick={() => pick(d)}
              title={focused ? '跳转到这一天' : undefined}
            >
              {d.getDate()}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function ConfigList() {
  const vault = usePageStore((s) => s.vaultRoot) ?? ''
  const dbs = useAggregatedDatabases('calendarDate')
  const byVault = useCalendarConfig((s) => s.byVault)
  const setColor = useCalendarConfig((s) => s.setColor)
  const toggleHidden = useCalendarConfig((s) => s.toggleHidden)
  const setDefault = useCalendarConfig((s) => s.setDefault)

  const def = defaultDbPath(vault, byVault)
  return (
    <div className="amx-calcfg">
      <div className="amx-calcfg-head">日历</div>
      {dbs.length === 0 && <div className="amx-calcfg-empty">没有含「日历日期」列的多维表。</div>}
      <div className="amx-calcfg-list">
        {dbs.map((db, di) => {
          const color = colorForDb(vault, byVault, db.path, di)
          const visible = !isHidden(vault, byVault, db.path)
          const isDefault = def ? def === db.path : di === 0 // 未显式设默认时,首个隐式为默认
          return (
            <div className="amx-calcfg-row" key={db.path}>
              <span className="amx-calcfg-swatch" style={{ background: visible ? color : 'transparent', borderColor: color }}>
                <input type="color" value={color} onChange={(e) => setColor(vault, db.path, e.target.value)} title="事件颜色" />
              </span>
              <span className={`amx-calcfg-name${visible ? '' : ' off'}`} title={db.name}>{db.name}</span>
              <button
                className={`amx-calcfg-def${isDefault ? ' on' : ''}`}
                onClick={() => setDefault(vault, db.path)}
                title="设为新建事件的默认多维表"
              >
                ★
              </button>
              <input
                type="checkbox"
                className="amx-calcfg-vis"
                checked={visible}
                onChange={() => toggleHidden(vault, db.path)}
                title="在日历中显示"
              />
            </div>
          )
        })}
      </div>
      {dbs.length > 0 && <div className="amx-calcfg-hint">★=新建默认库 · 勾选=是否显示 · 点色块改颜色</div>}
    </div>
  )
}
