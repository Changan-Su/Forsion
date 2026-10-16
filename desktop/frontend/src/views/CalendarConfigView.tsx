/** Calendar 左栏(2026-10-16 起;手机仍在右抽屉)= mini 月历(上) + 日历配置(下),竖向分屏。
 *  mini:主题色标今天;当主区 focus 的是 Calendar View 时,额外用淡色条标出其当前可见日期区间
 *  (实时跟随滚动),点某日则请求主区丝滑跳转。非 Calendar 主视图时这些效果关闭。
 *  配置:列出日历成员库(显式成员制,calendarMembers),每库可设颜色/显隐,并经 ⋯ 菜单
 *  改颜色/重命名/设默认/新标签打开/改列映射/移出日历;「日历」标题右边的 + 添加多维表 / 订阅 / 导入。
 *  一周开始于挪进了主区头部的「周▾」菜单。 */
import { useEffect, useMemo, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react'
import { useWorkspace, activeMainPanel } from '@lcl/engine'
import { ChevronLeft, ChevronRight, Database, Globe, Plus, Search, Upload } from 'lucide-react'
import { AstryxScope } from '../theme/astryxBridge'
import { askString } from '@amadeus/components/askString'
import { usePageStore } from '../amadeus/store/pageStore'
import { useDbStore } from '../amadeus/store/dbStore'
import { useCalendarMembers } from '../amadeus/store/calendarMembers'
import { useAllDatabases, isDateCol, type AggDb } from '../amadeus/store/dbAggregateStore'
import { useAgentCalDbs } from '../stores/agentScheduleStore'
import { useOtherVaultCalDbs } from '../stores/otherVaultCalStore'
import { MAX_IMPORT_BYTES, useIcsCalDbs, useIcsCalendars } from '../stores/icsCalendarStore'
import { icsCalendarName } from './calendar/ics'
import { useCalendarConfig, colorForDb, isHidden, defaultDbPath, memberOf } from '../amadeus/store/calendarConfigStore'
import { useCalendarNav } from '../amadeus/store/calendarNavStore'
import { openDb } from '../amadeusNav'
import { MemberColPicker } from './calendar/MemberColPicker'
import { weekdays, addDays, diffDays, fmtStamp, monthGridDays, monthLabel, startOfDay, toLocalDate, useWeekStart } from './calendar/dateUtils'
import { OverlayAt } from '@lcl/engine'
import { registerMessages, useI18n } from '../i18n'

registerMessages({
  'calcfg.prevMonth': { zh: '上个月', en: 'Previous month' },
  'calcfg.nextMonth': { zh: '下个月', en: 'Next month' },
  'calcfg.jumpToDay': { zh: '跳转到这一天', en: 'Jump to this day' },
  'calcfg.title': { zh: '日历', en: 'Calendars' },
  'calcfg.empty': { zh: '还没有加入日历的多维表。', en: 'No databases added to the calendar yet.' },
  'calcfg.eventColor': { zh: '事件颜色', en: 'Event color' },
  'calcfg.fetchFailed': { zh: '拉取失败', en: 'Fetch failed' },
  'calcfg.default': { zh: '默认', en: 'Default' },
  'calcfg.defaultHint': { zh: '新建的事件落在这里', en: 'New events go here' },
  'calcfg.showName': { zh: '在日历中显示「{name}」', en: 'Show “{name}” in the calendar' },
  'calcfg.srcAgent': { zh: 'Agent 日程（只读）', en: 'Agent schedule (read-only)' },
  'calcfg.srcOther': { zh: '{side} 的日历（只读）', en: 'Calendar from {side} (read-only)' },
  'calcfg.srcIcs': { zh: '外部日历（只读）', en: 'External calendar (read-only)' },
  'calcfg.more': { zh: '更多', en: 'More' },
  'calcfg.addCalendar': { zh: '添加日历', en: 'Add calendar' },
  'calcfg.addDatabase': { zh: '添加多维表', en: 'Add database' },
  'calcfg.subscribeExternal': { zh: '订阅外部日历', en: 'Subscribe to external calendar' },
  'calcfg.subscribeHint': {
    zh: '粘贴 .ics 订阅地址（Google / Outlook / Apple 日历「密钥地址」都行）',
    en: "Paste an .ics subscription URL (Google, Outlook, or Apple Calendar's private address all work)",
  },
  'calcfg.importIcs': { zh: '导入 .ics 文件', en: 'Import .ics file' },
  'calcfg.fileTooLarge': { zh: '文件过大（> {mb}MB）', en: 'File too large (over {mb} MB)' },
  'calcfg.notIcs': { zh: '这不是一个 .ics 日历文件', en: "That isn't an .ics calendar file" },
  'calcfg.readFailed': { zh: '读取失败：{msg}', en: 'Failed to read: {msg}' },
  'calcfg.renameCalendar': { zh: '重命名日历', en: 'Rename calendar' },
  'calcfg.renameSub': { zh: '重命名订阅', en: 'Rename subscription' },
  'calcfg.rename': { zh: '重命名', en: 'Rename' },
  'calcfg.refreshNow': { zh: '立即刷新', en: 'Refresh now' },
  'calcfg.unsubscribe': { zh: '取消订阅', en: 'Unsubscribe' },
  'calcfg.setDefaultDb': { zh: '设为默认日历', en: 'Set as default calendar' },
  'calcfg.openInNewTab': { zh: '在新标签打开', en: 'Open in new tab' },
  'calcfg.columnMapping': { zh: '日期与完成列…', en: 'Date and done columns…' },
  'calcfg.removeFromCalendar': { zh: '从日历移除', en: 'Remove from calendar' },
  'calcfg.searchDbPlaceholder': { zh: '搜索要加入日历的多维表…', en: 'Search databases to add to the calendar…' },
  'calcfg.noCandidates': { zh: '没有含日期属性的可添加多维表', en: 'No databases with a date property available to add' },
  'calcfg.footHint': { zh: '只有含「日期」属性的多维表会出现在这里', en: 'Only databases with a Date property appear here' },
})

export function CalendarConfigView() {
  return (
    <AstryxScope>
      <div className="amx-calside">
        <MiniCalendar />
        <ConfigList />
      </div>
    </AstryxScope>
  )
}

const firstOfMonth = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), 1)

function MiniCalendar() {
  const { t } = useI18n()
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

  const firstDow = useWeekStart()
  const grid = useMemo(() => monthGridDays(month), [month, firstDow])
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
        <span className="amx-mini-title">{monthLabel(month)}</span>
        <button className="amx-mini-nav" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label={t('calcfg.prevMonth')}><ChevronLeft size={14} /></button>
        <button className="amx-mini-nav" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label={t('calcfg.nextMonth')}><ChevronRight size={14} /></button>
      </div>
      <div className="amx-mini-dow">
        {weekdays().map((w) => (
          <span key={w}>{w}</span>
        ))}
      </div>
      <div className="amx-mini-grid">
        {grid.map((d, i) => {
          const out = d.getMonth() !== month.getMonth()
          const isToday = fmtStamp(d, true) === todayStr
          // 可见区间画成一整条带子:每行里带子的头尾圆角(跨行时每行各自收头)。
          const band = inBand(d)
          const bandEnds = band
            ? `${i % 7 === 0 || !inBand(grid[i - 1]) ? ' band-start' : ''}${i % 7 === 6 || !grid[i + 1] || !inBand(grid[i + 1]) ? ' band-end' : ''}`
            : ''
          return (
            <button
              key={+d}
              className={`amx-mini-day${out ? ' out' : ''}${isToday ? ' today' : ''}${band ? ' band' : ''}${bandEnds}`}
              onClick={() => pick(d)}
              title={focused ? t('calcfg.jumpToDay') : undefined}
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
  const { t } = useI18n()
  const vault = usePageStore((s) => s.vaultRoot) ?? ''
  const members = useCalendarMembers()
  const agentDbs = useAgentCalDbs() // agent 日程只读源:进图例(调色/显隐可用,无 ★/⋯)
  const otherDbs = useOtherVaultCalDbs() // 非活动侧只读日历(任务1:汇总两侧,名字已带 Vault 后缀)
  const icsDbs = useIcsCalDbs() // 外部日历订阅(.ics)
  const icsErrors = useIcsCalendars((s) => s.errors)
  const byVault = useCalendarConfig((s) => s.byVault)
  const setColor = useCalendarConfig((s) => s.setColor)
  const toggleHidden = useCalendarConfig((s) => s.toggleHidden)
  const setDefault = useCalendarConfig((s) => s.setDefault)
  const addMember = useCalendarConfig((s) => s.addMember)
  const removeMember = useCalendarConfig((s) => s.removeMember)

  const [showAdd, setShowAdd] = useState(false)
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null)
  const [importErr, setImportErr] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ db: AggDb; kind?: 'agent' | 'other' | 'ics'; color: string; x: number; y: number } | null>(null)
  const [editing, setEditing] = useState<AggDb | null>(null) // 「Calendar 设置」改列映射
  // Esc 收起 ⋯ / + 菜单(焦点在触发按钮上,菜单自己收不到键;走查里 Esc 没关掉,下一下点进了盖着的菜单)
  useEffect(() => {
    if (!menu && !addMenu) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setMenu(null)
      setAddMenu(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [menu, addMenu])

  const memberPaths = useMemo(() => new Set(members.map((m) => m.db.path)), [members])
  const dbs: Array<{ db: AggDb; readonly?: boolean; kind?: 'agent' | 'other' | 'ics' }> = [
    ...members.map((m) => ({ db: m.db })),
    ...agentDbs.map((db) => ({ db, readonly: true, kind: 'agent' as const })),
    ...otherDbs.map((db) => ({ db, readonly: true, kind: 'other' as const })),
    ...icsDbs.map((db) => ({ db, readonly: true, kind: 'ics' as const })),
  ]
  const def = defaultDbPath(vault, byVault)

  const rename = (db: AggDb): void => {
    setMenu(null)
    void askString(t('calcfg.renameCalendar'), db.name).then((n) => {
      const name = n?.trim()
      if (name && name !== db.name) useDbStore.getState().mutate(db.path, (d) => ({ ...d, name }))
    })
  }

  // ── 外部日历订阅(.ics)──────────────────────────────────────────────────
  const icsId = (path: string): string => path.slice('ics://'.length)
  const icsError = (path: string): string | undefined => icsErrors[icsId(path)]
  const subscribe = (): void => {
    void askString(t('calcfg.subscribeExternal'), '', { label: t('calcfg.subscribeHint') }).then((url) => {
      const u = url?.trim()
      if (!u) return
      useIcsCalendars.getState().add(u) // 名字先占位;首轮拉取拿到 X-WR-CALNAME 自动替换
    })
  }
  const importFile = (): void => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.ics,text/calendar'
    input.onchange = () => {
      const f = input.files?.[0]
      if (!f) return
      // 解析是同步的:大文件不设闸会把渲染进程冻住(用户误选一个几百 MB 的文件不是稀奇事)。
      if (f.size > MAX_IMPORT_BYTES) { setImportErr(t('calcfg.fileTooLarge', { mb: MAX_IMPORT_BYTES / 1024 / 1024 })); return }
      setImportErr(null)
      void f
        .text()
        .then((text) => {
          if (!useIcsCalendars.getState().importText(icsCalendarName(text) || f.name.replace(/\.ics$/i, ''), text)) {
            setImportErr(t('calcfg.notIcs'))
          }
        })
        .catch((e: unknown) => setImportErr(t('calcfg.readFailed', { msg: (e as Error)?.message || String(e) })))
    }
    input.click()
  }

  const openAdd = (e: ReactMouseEvent<HTMLElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    setAddMenu({ x: Math.max(12, Math.min(r.left, window.innerWidth - 200)), y: r.bottom + 4 })
  }
  // 一行只剩「颜色方块(= 显隐开关)+ 名字」,默认日历在右边写淡字「默认」;改颜色、设默认、来源说明都在 ⋯ 里(2026-10-16 方向 1)。
  return (
    <div className="amx-calcfg">
      <div className="amx-calcfg-head">
        <span>{t('calcfg.title')}</span>
        <button className="amx-calcfg-addbtn" aria-label={t('calcfg.addCalendar')} title={t('calcfg.addCalendar')} onClick={openAdd}><Plus size={14} /></button>
      </div>
      {dbs.length === 0 && <div className="amx-calcfg-empty">{t('calcfg.empty')}</div>}
      <div className="amx-calcfg-list">
        {dbs.map(({ db, readonly, kind }, di) => {
          const color = colorForDb(vault, byVault, db.path, di)
          const visible = !isHidden(vault, byVault, db.path)
          const isDefault = !readonly && (def ? def === db.path : di === 0) // 未显式设默认时,首个隐式为默认
          return (
            <div className="amx-calcfg-row" key={db.path}>
              <button
                className={`amx-calcfg-swatch${visible ? ' on' : ''}`}
                style={{ '--amx-swatch': color } as CSSProperties}
                role="checkbox"
                aria-checked={visible}
                aria-label={t('calcfg.showName', { name: db.name })}
                onClick={() => toggleHidden(vault, db.path)}
              />
              <span className={`amx-calcfg-name${visible ? '' : ' off'}`} title={icsError(db.path) || db.name}>
                {db.name}
                {kind === 'ics' && icsError(db.path) && <span className="amx-calcfg-err"> · {t('calcfg.fetchFailed')}</span>}
              </span>
              {isDefault && <span className="amx-calcfg-default" title={t('calcfg.defaultHint')}>{t('calcfg.default')}</span>}
              <button
                className="amx-calcfg-more"
                title={t('calcfg.more')}
                aria-label={t('calcfg.more')}
                onClick={(e) => {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  setMenu({ db, kind, color, x: Math.min(r.left, window.innerWidth - 200), y: r.bottom + 4 })
                }}
              >
                ⋯
              </button>
            </div>
          )
        })}
      </div>
      {importErr && <div className="amx-calcfg-hint" style={{ color: 'var(--danger)' }}>{importErr}</div>}

      {addMenu && (
        <div className="amx-db-popwrap" onMouseDown={() => setAddMenu(null)}>
          <OverlayAt className="amx-db-pop amx-calcfg-addmenu" x={addMenu.x} y={addMenu.y} onMouseDown={(e) => e.stopPropagation()}>
            <button className="amx-db-opt" onClick={() => { setAddMenu(null); setShowAdd(true) }}><Database size={14} /> {t('calcfg.addDatabase')}</button>
            <button className="amx-db-opt" onClick={() => { setAddMenu(null); subscribe() }}><Globe size={14} /> {t('calcfg.subscribeExternal')}</button>
            <button className="amx-db-opt" onClick={() => { setAddMenu(null); importFile() }}><Upload size={14} /> {t('calcfg.importIcs')}</button>
          </OverlayAt>
        </div>
      )}

      {menu && (
        <div className="amx-db-popwrap" onMouseDown={() => setMenu(null)}>
          <OverlayAt className="amx-db-pop amx-calcfg-menu" x={menu.x} y={menu.y} onMouseDown={(e) => e.stopPropagation()}>
            {menu.kind && (
              <div className="amx-calcfg-menusrc">
                {menu.kind === 'agent' ? t('calcfg.srcAgent') : menu.kind === 'other' ? t('calcfg.srcOther', { side: menu.db.vaultLabel || '' }) : t('calcfg.srcIcs')}
              </div>
            )}
            <label className="amx-db-opt amx-calcfg-colorrow">
              <span className="amx-calcfg-colordot" style={{ background: menu.color }} />
              {t('calcfg.eventColor')}
              <input type="color" value={menu.color} onChange={(e) => { setColor(vault, menu.db.path, e.target.value); setMenu({ ...menu, color: e.target.value }) }} />
            </label>
            {menu.kind === 'agent' || menu.kind === 'other' ? null : menu.kind === 'ics' ? (
              <>
                {!!useIcsCalendars.getState().subs.find((x) => x.id === icsId(menu.db.path))?.url && (
                  <button className="amx-db-opt" onClick={() => { void useIcsCalendars.getState().refresh(icsId(menu.db.path)); setMenu(null) }}>{t('calcfg.refreshNow')}</button>
                )}
                <button
                  className="amx-db-opt"
                  onClick={() => {
                    const id = icsId(menu.db.path)
                    const cur = menu.db.name
                    setMenu(null)
                    void askString(t('calcfg.renameSub'), cur).then((n) => { if (n?.trim()) useIcsCalendars.getState().rename(id, n.trim()) })
                  }}
                >
                  {t('calcfg.rename')}
                </button>
                <button className="amx-db-opt amx-db-opt-danger" onClick={() => { useIcsCalendars.getState().remove(icsId(menu.db.path)); setMenu(null) }}>{t('calcfg.unsubscribe')}</button>
              </>
            ) : (
              <>
            <button className="amx-db-opt" onClick={() => rename(menu.db)}>{t('calcfg.rename')}</button>
            <button className="amx-db-opt" onClick={() => { setDefault(vault, menu.db.path); setMenu(null) }}>{t('calcfg.setDefaultDb')}</button>
            <button className="amx-db-opt" onClick={() => { openDb(menu.db.path); setMenu(null) }}>{t('calcfg.openInNewTab')}</button>
            <button className="amx-db-opt" onClick={() => { setEditing(menu.db); setMenu(null) }}>{t('calcfg.columnMapping')}</button>
            <button className="amx-db-opt amx-db-opt-danger" onClick={() => { removeMember(vault, menu.db.path); setMenu(null) }}>{t('calcfg.removeFromCalendar')}</button>
              </>
            )}
          </OverlayAt>
        </div>
      )}

      {showAdd && (
        <AddDbPopup
          memberPaths={memberPaths}
          onClose={() => setShowAdd(false)}
          onAdd={(db, dateCol, checkboxCol) => { addMember(vault, db.path, dateCol, checkboxCol); setShowAdd(false) }}
        />
      )}
      {editing && (
        <div className="amx-db-popwrap" onMouseDown={() => setEditing(null)}>
          <div className="amx-db-pop amx-calpick-pop" onMouseDown={(e) => e.stopPropagation()}>
            <MemberColPicker
              dbName={editing.name}
              columns={editing.columns}
              initial={memberOf(vault, byVault, editing.path)}
              onCancel={() => setEditing(null)}
              onConfirm={(dateCol, checkboxCol) => { addMember(vault, editing.path, dateCol, checkboxCol); setEditing(null) }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

/** 搜索全库「含日期属性 + 尚未加入」的数据库(对齐 Notion「有日期属性才出现」),选中后配列映射。 */
function AddDbPopup({ memberPaths, onClose, onAdd }: {
  memberPaths: Set<string>
  onClose: () => void
  onAdd: (db: AggDb, dateCol: string, checkboxCol?: string) => void
}) {
  const { t } = useI18n()
  const all = useAllDatabases()
  const [q, setQ] = useState('')
  const [picking, setPicking] = useState<AggDb | null>(null)
  const candidates = useMemo(
    () => all.filter((db) => !memberPaths.has(db.path) && db.columns.some(isDateCol)),
    [all, memberPaths],
  )
  const shown = q ? candidates.filter((db) => db.name.toLowerCase().includes(q.toLowerCase())) : candidates
  // 居中悬浮(复用 quick-find 面板 chrome);选中库后第二步用同款居中小卡配列映射。
  return (
    <div className="amx-qf-scrim" onMouseDown={onClose}>
      {picking ? (
        <div className="amx-qf-card" onMouseDown={(e) => e.stopPropagation()}>
          <MemberColPicker dbName={picking.name} columns={picking.columns} onCancel={() => setPicking(null)} onConfirm={(d, c) => onAdd(picking, d, c)} />
        </div>
      ) : (
        <div className="amx-qf" onMouseDown={(e) => e.stopPropagation()}>
          <div className="amx-qf-head">
            <Search size={16} className="amx-qf-searchicon" />
            <input autoFocus className="amx-qf-input" placeholder={t('calcfg.searchDbPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="amx-qf-list">
            {shown.map((db) => (
              <button key={db.path} className="amx-qf-row" onClick={() => setPicking(db)}>
                <span className="amx-qf-icon"><Database size={15} /></span>
                <span className="amx-qf-title">{db.name || db.path}</span>
                <span className="amx-qf-sub">{db.path.replace(/\\/g, '/').split('/').slice(0, -1).join('/') || '/'}</span>
              </button>
            ))}
            {shown.length === 0 && <div className="amx-qf-empty">{t('calcfg.noCandidates')}</div>}
          </div>
          <div className="amx-qf-foot">{t('calcfg.footHint')}</div>
        </div>
      )}
    </div>
  )
}
