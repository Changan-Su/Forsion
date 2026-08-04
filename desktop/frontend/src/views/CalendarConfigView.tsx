/** Calendar 右栏 = mini 月历(上) + 日历配置(下),竖向分屏。
 *  mini:主题色标今天;当主区 focus 的是 Calendar View 时,额外用淡色条标出其当前可见日期区间
 *  (实时跟随滚动),点某日则请求主区丝滑跳转。非 Calendar 主视图时这些效果关闭。
 *  配置:列出日历成员库(显式成员制,calendarMembers),每库可设颜色/显隐,并经 ⋯ 菜单
 *  重命名/设默认/新标签打开/改列映射/移出日历;底部「+ 添加 Forsion database」搜库入历。 */
import { useEffect, useMemo, useState } from 'react'
import { useWorkspace, activeMainPanel } from '@lcl/engine'
import { Plus, Search, Database, Globe, Upload } from 'lucide-react'
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput'
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
import { WEEKDAYS, addDays, diffDays, fmtStamp, monthGridDays, monthLabel, startOfDay, toLocalDate } from './calendar/dateUtils'
import { OverlayAt } from '@lcl/engine'

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
  const vaultSide = usePageStore((s) => s.vaultSide)
  const activeLabel = vaultSide === 'cloud' ? '云端' : vault.split(/[\\/]/).pop() || vault // 活动侧默认 Calendar 的后缀标签
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
  const [importErr, setImportErr] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ db: AggDb; ics?: boolean; x: number; y: number } | null>(null)
  const [editing, setEditing] = useState<AggDb | null>(null) // 「Calendar 设置」改列映射

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
    void askString('重命名日历', db.name).then((n) => {
      const name = n?.trim()
      if (name && name !== db.name) useDbStore.getState().mutate(db.path, (d) => ({ ...d, name }))
    })
  }

  // ── 外部日历订阅(.ics)──────────────────────────────────────────────────
  const icsId = (path: string): string => path.slice('ics://'.length)
  const icsError = (path: string): string | undefined => icsErrors[icsId(path)]
  const subscribe = (): void => {
    void askString('订阅外部日历', '', { label: '粘贴 .ics 订阅地址(Google / Outlook / Apple 日历「密钥地址」都行)' }).then((url) => {
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
      if (f.size > MAX_IMPORT_BYTES) { setImportErr(`文件过大(> ${MAX_IMPORT_BYTES / 1024 / 1024}MB)`); return }
      setImportErr(null)
      void f
        .text()
        .then((text) => {
          if (!useIcsCalendars.getState().importText(icsCalendarName(text) || f.name.replace(/\.ics$/i, ''), text)) {
            setImportErr('这不是一个 .ics 日历文件')
          }
        })
        .catch((e: unknown) => setImportErr(`读取失败:${(e as Error)?.message || String(e)}`))
    }
    input.click()
  }

  return (
    <div className="amx-calcfg">
      <div className="amx-calcfg-head">日历</div>
      {dbs.length === 0 && <div className="amx-calcfg-empty">还没有加入日历的多维表。</div>}
      <div className="amx-calcfg-list">
        {dbs.map(({ db, readonly, kind }, di) => {
          const color = colorForDb(vault, byVault, db.path, di)
          const visible = !isHidden(vault, byVault, db.path)
          const isDefault = def ? def === db.path : di === 0 // 未显式设默认时,首个隐式为默认
          return (
            <div className="amx-calcfg-row" key={db.path}>
              <span className="amx-calcfg-swatch" style={{ background: visible ? color : 'transparent', borderColor: color }}>
                <input type="color" value={color} onChange={(e) => setColor(vault, db.path, e.target.value)} title="事件颜色" />
              </span>
              <span className={`amx-calcfg-name${visible ? '' : ' off'}`} title={icsError(db.path) || db.name}>
                {kind === 'agent' ? `⚙ ${db.name}` : kind === 'ics' ? `🌐 ${db.name}` : db.name}
                {kind === 'ics' && icsError(db.path) && <span className="amx-cal-vault"> · 拉取失败</span>}
                {(() => {
                  // Vault 归属后缀(淡显):agent 已用 ⚙ 标识不缀;other 用其所属侧名;其余=活动侧库,缀活动侧名。
                  const vaultLabel = kind === 'agent' ? '' : kind === 'other' ? (db.vaultLabel || '') : activeLabel
                  return vaultLabel ? <span className="amx-cal-vault"> · {vaultLabel}</span> : null
                })()}
                {!readonly && isDefault && ' ★'}
              </span>
              <CheckboxInput
                label="在日历中显示"
                isLabelHidden
                size="sm"
                value={visible}
                onChange={() => toggleHidden(vault, db.path)}
              />
              {(!readonly || kind === 'ics') && (
                <button
                  className="amx-calcfg-more"
                  title="更多"
                  onClick={(e) => {
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                    setMenu({ db, ics: kind === 'ics', x: Math.min(r.left, window.innerWidth - 180), y: r.bottom + 4 })
                  }}
                >
                  ⋯
                </button>
              )}
            </div>
          )
        })}
      </div>
      <button className="amx-calcfg-add" onClick={() => setShowAdd(true)}>
        <Plus size={14} /> 添加 Forsion database
      </button>
      <button className="amx-calcfg-add" onClick={subscribe}>
        <Globe size={14} /> 订阅外部日历(.ics)
      </button>
      <button className="amx-calcfg-add" onClick={importFile}>
        <Upload size={14} /> 导入 .ics 文件
      </button>
      {importErr && <div className="amx-calcfg-hint" style={{ color: 'var(--danger)' }}>{importErr}</div>}
      {dbs.length > 0 && <div className="amx-calcfg-hint">★=新建默认库 · 勾选=是否显示 · 点色块改颜色 · ⋯ 更多</div>}

      {menu && (
        <div className="amx-db-popwrap" onMouseDown={() => setMenu(null)}>
          <OverlayAt className="amx-db-pop amx-calcfg-menu" x={menu.x} y={menu.y} onMouseDown={(e) => e.stopPropagation()}>
            {menu.ics ? (
              <>
                {!!useIcsCalendars.getState().subs.find((x) => x.id === icsId(menu.db.path))?.url && (
                  <button className="amx-db-opt" onClick={() => { void useIcsCalendars.getState().refresh(icsId(menu.db.path)); setMenu(null) }}>立即刷新</button>
                )}
                <button
                  className="amx-db-opt"
                  onClick={() => {
                    const id = icsId(menu.db.path)
                    const cur = menu.db.name
                    setMenu(null)
                    void askString('重命名订阅', cur).then((n) => { if (n?.trim()) useIcsCalendars.getState().rename(id, n.trim()) })
                  }}
                >
                  重命名
                </button>
                <button className="amx-db-opt amx-db-opt-danger" onClick={() => { useIcsCalendars.getState().remove(icsId(menu.db.path)); setMenu(null) }}>取消订阅</button>
              </>
            ) : (
              <>
            <button className="amx-db-opt" onClick={() => rename(menu.db)}>重命名</button>
            <button className="amx-db-opt" onClick={() => { setDefault(vault, menu.db.path); setMenu(null) }}>设为默认库</button>
            <button className="amx-db-opt" onClick={() => { openDb(menu.db.path); setMenu(null) }}>在新标签打开</button>
            <button className="amx-db-opt" onClick={() => { setEditing(menu.db); setMenu(null) }}>Calendar 设置(改列映射)</button>
            <button className="amx-db-opt amx-db-opt-danger" onClick={() => { removeMember(vault, menu.db.path); setMenu(null) }}>从日历移除</button>
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
            <input autoFocus className="amx-qf-input" placeholder="搜索要加入日历的数据库…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="amx-qf-list">
            {shown.map((db) => (
              <button key={db.path} className="amx-qf-row" onClick={() => setPicking(db)}>
                <span className="amx-qf-icon"><Database size={15} /></span>
                <span className="amx-qf-title">{db.name || db.path}</span>
                <span className="amx-qf-sub">{db.path.replace(/\\/g, '/').split('/').slice(0, -1).join('/') || '/'}</span>
              </button>
            ))}
            {shown.length === 0 && <div className="amx-qf-empty">没有含日期属性的可添加数据库</div>}
          </div>
          <div className="amx-qf-foot">只有含「日期」属性的数据库会出现在这里</div>
        </div>
      )}
    </div>
  )
}
