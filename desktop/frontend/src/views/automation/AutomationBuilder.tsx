/**
 * 可视化新建/编辑自动化(Dify 借鉴的是执行契约与表单化配置,不是画布):
 * 触发卡(定时统一入口:每天/一次/间隔 + 事件目录 datalist + 文件达标)→ 可增删排序的动作步骤卡
 * (通知/跑 Agent/调工具;工具参数表单按目录 JSON schema 自动生成)→ 底部护栏行。
 * 竖排线性链 + CSS 连接线,刻意不做自由画布(分支编排出现再升级)。
 * 0 个步骤 = 旧语义「唤醒 Muse 整理为 TODO」(保存 actions:null);编辑旧式 agentSlug 规则时
 * 自动转成一个 agent_run 步骤(保存即迁移到动作链模型)。
 * 保存 = POST /agent/special/muse/triggers upsert(校验在引擎端与 manage_automation 工具同源;
 * tool_call 只有这条 UI 通道能建=保存即人工预批)。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Bell, Bot, Database, Sparkles, Trash2, Workflow, Wrench, Zap } from 'lucide-react'
import { useApp } from '../../stores/appStore'
import { useAutomation } from '../../stores/automationStore'
import { saveMuseTrigger } from '../../services/backendService'
import { useI18n } from '../../i18n'
import {
  BUILTIN_EVENTS, MAX_WHERE, WHERE_OPS, blankStep, cooldownPayload, hasUnsupportedParts, initialCooldown,
  isFinishedTrigger, parseLocalDatetime, stepsFrom, toSpec, watchedColumnIds, whereDraftFrom, whereToUpsert, type StepDraft, type WhereDraft,
} from './lib'
import { listPluginAutomationEvents } from '../../amadeus/plugins/pluginStore'
import { useShallow } from 'zustand/react/shallow'
import { usePageStore } from '../../amadeus/store/pageStore'
import { useDbStore } from '../../amadeus/store/dbStore'
import { ensureAmadeusReady } from '../../amadeusPlugins'
import type { MuseTriggerInfo } from '../../types'

type TriggerKind = 'timer' | 'event_seen' | 'file_chars_gte' | 'manual' | 'db_changed'
type TimerMode = 'daily_at' | 'at' | 'every'

/** 嵌入用法(Amadeus 按钮块的配置弹层):固定手动触发 + 保存后把规则交回调用方,不碰自动化 Space 的选中态。 */
export interface AutomationBuilderProps {
  editing?: MuseTriggerInfo
  /** true=锁死「手动(按钮)」触发,隐藏触发类型选择器。 */
  fixedManual?: boolean
  /** 给了就用它取代默认的「关闭构建器 + 选中该规则」收尾。 */
  onSaved?: (trigger: MuseTriggerInfo) => void
  onCancel?: () => void
}

// StepDraft / stepsFrom / toSpec / hasUnsupportedParts 住 lib.ts(纯模块才进得了 vitest:往返不丢字段有仪器);
// 这里只留 React 与表单。hasUnsupportedParts 仍从本模块出口,老引用不断。
export { hasUnsupportedParts }

/** 本地 datetime-local 初值:整点下一小时。 */
function defaultDatetime(): string {
  const d = new Date(Date.now() + 3600_000)
  d.setMinutes(0, 0, 0)
  const p = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:00`
}

export const AutomationBuilder: React.FC<AutomationBuilderProps> = ({ editing, fixedManual, onSaved, onCancel }) => {
  const { t } = useI18n()
  const cfg = useApp((s) => s.cfg)
  const agentDefs = useApp((s) => s.agentDefs)
  const st = useAutomation()
  const catalog = st.actionsCatalog

  const [desc, setDesc] = useState(editing?.desc || '')
  const initCond = editing?.cond
  const [kind, setKind] = useState<TriggerKind>(
    !initCond ? (fixedManual ? 'manual' : 'timer')
    : initCond.type === 'event_seen' ? 'event_seen'
    : initCond.type === 'file_chars_gte' ? 'file_chars_gte'
    : initCond.type === 'manual' ? 'manual'
    : initCond.type === 'db_changed' ? 'db_changed'
    : 'timer',
  )
  const [timerMode, setTimerMode] = useState<TimerMode>(
    initCond?.type === 'at' ? 'at' : initCond?.type === 'every' ? 'every' : 'daily_at',
  )
  const [time, setTime] = useState(initCond?.type === 'daily_at' ? initCond.time : '09:00')
  // 已结束的一次性规则(时刻过+已停用,与列表归档同判):重置为下一整点,编辑=改期重开(保存强制 enabled)。
  // 仅"时刻刚过但仍 enabled"(引擎 tick 未至,提醒还欠着)不算——那时重置时间会静默吞掉待补发的提醒。
  const expiredAt = !!editing && isFinishedTrigger(editing)
  const [datetime, setDatetime] = useState(initCond?.type === 'at' && !expiredAt ? initCond.datetime.replace(' ', 'T') : defaultDatetime())
  const initIvl = initCond?.type === 'every' ? /^(\d+)([mhd])$/.exec(initCond.interval) : null
  const [ivlN, setIvlN] = useState(initIvl ? initIvl[1] : '1')
  const [ivlUnit, setIvlUnit] = useState<'m' | 'h' | 'd'>(initIvl ? (initIvl[2] as 'm' | 'h' | 'd') : 'h')
  const [match, setMatch] = useState(initCond?.type === 'event_seen' ? initCond.match : '')
  const [path, setPath] = useState(initCond?.type === 'file_chars_gte' ? initCond.path : '')
  const [n, setN] = useState(initCond?.type === 'file_chars_gte' ? String(initCond.n) : '100')
  // 多维表触发(db_changed):表路径 / 事件 / 监听列(cell_changed 必填)/ 可选等值条件。
  const [dbPath, setDbPath] = useState(initCond?.type === 'db_changed' ? initCond.path : '')
  const [dbEvent, setDbEvent] = useState<'row_added' | 'cell_changed'>(initCond?.type === 'db_changed' ? initCond.event : 'row_added')
  // 监听列可多选(任一列变化即命中);保存时 column_id=首列 + column_ids=全部(引擎归一排序,单列归回 columnId)。
  const [dbColumnIds, setDbColumnIds] = useState<string[]>(() => watchedColumnIds(initCond))
  const toggleDbColumn = (id: string, on: boolean): void =>
    setDbColumnIds((ids) => (on ? (ids.includes(id) ? ids : [...ids, id]) : ids.filter((x) => x !== id)))
  const [dbEquals, setDbEquals] = useState(initCond?.type === 'db_changed' ? initCond.equals || '' : '')
  // 附加条件 where(row_added / cell_changed 都可用;与 equals AND)。
  const [dbWhere, setDbWhere] = useState<WhereDraft[]>(() => whereDraftFrom(initCond))
  const patchWhere = (i: number, patch: Partial<WhereDraft>): void =>
    setDbWhere((ws) => ws.map((w, j) => (j === i ? { ...w, ...patch } : w)))
  // vault 里的 .db 清单 + 选中表的列(监听列下拉);Automation Space 可能先于 Amadeus 打开,先确保 vault 已恢复。
  useEffect(() => {
    ensureAmadeusReady()
  }, [])
  const vaultFiles = usePageStore((s) => s.files)
  const allDbFiles = useMemo(() => vaultFiles.filter((f) => /\.db$/i.test(f)), [vaultFiles])
  // 全部候选表都得加载:笔记视图库(source=folder)触发端永不命中、动作端引擎直接拒,
  // 下拉里就不该给(codex 抓的);没加载完之前先出现,保存时还有一道权威闸。
  useEffect(() => {
    for (const p of allDbFiles) void useDbStore.getState().load(p, p)
  }, [allDbFiles])
  const noteViewDbs = useDbStore(useShallow((s) => allDbFiles.filter((f) => s.entries[f]?.data?.source !== undefined)))
  const dbFiles = useMemo(() => allDbFiles.filter((f) => !noteViewDbs.includes(f)), [allDbFiles, noteViewDbs])
  const dbColsRaw = useDbStore((s) => (kind === 'db_changed' && dbPath ? s.entries[dbPath]?.data?.columns : undefined))
  // 计算列(公式/引用)不落盘,引擎游标比对永远看不见它变 —— 列出来 = 一条永不触发的规则。
  const dbCols = useMemo(() => dbColsRaw?.filter((c) => c.type !== 'formula' && c.type !== 'lookup'), [dbColsRaw])
  const [steps, setSteps] = useState<StepDraft[]>(() => stepsFrom(editing))
  const [musePrompt, setMusePrompt] = useState(editing && !editing.actions?.length && !editing.agentSlug ? editing.prompt || '' : '')
  const [cooldown, setCooldown] = useState(() => initialCooldown(editing, kind))
  // 新建规则时切触发类型,冷却初值跟着换(db_changed → 0);用户已亲手改过的值不动。
  const cooldownTouched = useRef(false)
  useEffect(() => {
    if (!editing && !cooldownTouched.current) setCooldown(initialCooldown(null, kind))
  }, [kind, editing])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const hasAgentStep = steps.some((s) => s.type === 'agent_run')
  const patchStep = (key: number, patch: Partial<StepDraft>): void =>
    setSteps((ss) => ss.map((s) => (s.key === key ? { ...s, ...patch } : s)))
  const moveStep = (i: number, dir: -1 | 1): void =>
    setSteps((ss) => {
      const j = i + dir
      if (j < 0 || j >= ss.length) return ss
      const next = [...ss]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })

  // 含 DB 触发/动作的规则:本版表单表达不了它,渲染出来就会在保存时把那部分抹掉。
  // 明说 + 不给保存,比"看着能编辑其实会毁配置"强(codex 抓的)。
  if (hasUnsupportedParts(editing)) {
    return (
      <div className="auto-builder">
        <div className="auto-builder-title"><Workflow size={17} /> {t('automation.builder.editTitle')}</div>
        <div className="auto-node">
          <div className="auto-hint">{t('automation.builder.unsupported')}</div>
        </div>
        <div className="auto-builder-actions">
          <button className="btn ghost" onClick={() => (onCancel ? onCancel() : st.closeBuilder())}>{t('common.cancel')}</button>
        </div>
      </div>
    )
  }

  const stepValid = (s: StepDraft): boolean => {
    if (s.type === 'notify') return !!s.title.trim()
    if (s.type === 'agent_run') return !!s.agentSlug && !!s.prompt.trim()
    if (s.type === 'db_row_add' || s.type === 'db_row_edit') {
      if (!/\.db$/i.test(s.dbPath.trim())) return false
      if (!s.cells.some((c) => c.k.trim())) return false
      if (s.type === 'db_row_edit') {
        // 改行:不是多维表触发就没有「触发命中的那一行」可缺省,必须显式给行 id 或按列值匹配(match 不靠触发行)。
        if (kind !== 'db_changed' && !s.rowId.trim() && !s.matchColumn.trim()) return false
        // rowFrom 沿的是触发行的关联列,没有触发行就是一条死配置。
        if (s.rowFrom.trim() && kind !== 'db_changed') return false
        // 有匹配列没匹配值 = 匹配空串,几乎必是误填。
        if (s.matchColumn.trim() && !s.matchValue.trim()) return false
      }
      return true
    }
    const cat = catalog.find((c) => c.name === s.tool)
    if (!cat) return false
    return (cat.parameters.required || []).every((k) => (s.argValues[k] || '').trim() !== '')
  }

  const canSave = useMemo(() => {
    if (!desc.trim()) return false
    if (kind === 'timer') {
      if (timerMode === 'daily_at' && !/^\d{1,2}:\d{2}$/.test(time)) return false
      if (timerMode === 'at' && !datetime) return false
      if (timerMode === 'every' && !(Number(ivlN) > 0)) return false
    }
    if (kind === 'event_seen' && !match.trim()) return false
    if (kind === 'file_chars_gte' && (!path.trim() || !(Number(n) > 0))) return false
    if (kind === 'db_changed') {
      if (!/\.db$/i.test(dbPath.trim())) return false
      if (dbEvent === 'cell_changed' && !dbColumnIds.length) return false
      // where 默认放行(可选),只挡明显坏行:超条数 / eq·ne 选了列却没给值(没选列的行保存时直接丢)。
      if (dbWhere.length > MAX_WHERE) return false
      if (dbWhere.some((w) => w.column.trim() && (w.op === 'eq' || w.op === 'ne') && !w.value.trim())) return false
    }
    // 手动类没有 Muse 兜底语义:0 步骤的按钮点了什么也不会发生,直接不让存。
    if (kind === 'manual' && !steps.length) return false
    return steps.every(stepValid)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stepValid 闭包只另依赖 kind/catalog(已在列)
  }, [desc, kind, timerMode, time, datetime, ivlN, match, path, n, dbPath, dbEvent, dbColumnIds, dbWhere, steps, catalog])

  const save = async (): Promise<void> => {
    const condType = kind === 'timer' ? timerMode : kind
    // 预检:编辑器开久了 at 时刻悄悄过期(mount 时的 expiredAt 不会重算)——引擎同口径(5min 容忍)本地先拒
    if (condType === 'at' && (parseLocalDatetime(datetime)?.getTime() ?? 0) < Date.now() - 5 * 60_000) {
      setError(t('automation.builder.atPast'))
      return
    }
    // 笔记视图库的权威闸(下拉过滤只是便利,直填路径/加载迟到都可能漏):保存前按已加载数据再拒一次。
    const isNoteViewDb = (p: string): boolean => useDbStore.getState().entries[p]?.data?.source !== undefined
    const dbTargets = [
      ...(condType === 'db_changed' ? [dbPath.trim()] : []),
      ...steps.filter((s) => s.type === 'db_row_add' || s.type === 'db_row_edit').map((s) => s.dbPath.trim()),
    ].filter(Boolean)
    if (dbTargets.some(isNoteViewDb)) {
      setError(t('automation.builder.dbNoteView'))
      return
    }
    setBusy(true)
    setError('')
    const actions = toSpec(steps, catalog)
    try {
      const saved = await saveMuseTrigger(cfg, {
        id: editing?.id,
        // actor='user':构建器保存是显式意图(与面板拨开关同档),可以把引擎自动停用的规则开回来。
        actor: 'user',
        desc: desc.trim(),
        cond_type: condType,
        time: condType === 'daily_at' ? time : undefined,
        datetime: condType === 'at' ? datetime : undefined,
        interval: condType === 'every' ? `${Math.floor(Number(ivlN))}${ivlUnit}` : undefined,
        match: condType === 'event_seen' ? match.trim() : undefined,
        path: condType === 'file_chars_gte' ? path.trim() : condType === 'db_changed' ? dbPath.trim() : undefined,
        n: condType === 'file_chars_gte' ? Number(n) : undefined,
        event: condType === 'db_changed' ? dbEvent : undefined,
        column_id: condType === 'db_changed' && dbEvent === 'cell_changed' ? dbColumnIds[0] : undefined,
        // ≥2 列才发 column_ids(单列只发 column_id,存量规则形状不变 → 不被引擎当成 cond 变了重置游标)
        column_ids: condType === 'db_changed' && dbEvent === 'cell_changed' && dbColumnIds.length > 1 ? dbColumnIds : undefined,
        equals: condType === 'db_changed' && dbEvent === 'cell_changed' && dbEquals.trim() ? dbEquals.trim() : undefined,
        // where 对 row_added 也有效;空数组送 undefined(见 whereToUpsert 注释)。
        where: condType === 'db_changed' ? whereToUpsert(dbWhere) : undefined,
        // 编辑既有 db 规则:钉回建规则时的 vault(省略会被引擎重钉到**当前** vault,切库编辑会静默改靶)。
        vault: condType === 'db_changed' && editing?.cond.type === 'db_changed' ? editing.cond.vault : undefined,
        prompt: steps.length ? undefined : musePrompt.trim() || undefined,
        cooldown_hours: cooldownPayload(kind, cooldown), // 0 放行(db_changed 纯动作链 = 不冷却)
        // 新 builder 不再产旧式单动作;0 步骤 = 显式清空(actions:null)回到唤醒 Muse 旧语义
        actions: steps.length ? actions : null,
        enabled: expiredAt ? true : editing?.enabled ?? true,
      })
      st.bump()
      if (onSaved) { onSaved(saved); return } // 嵌入用法(Amadeus 按钮块):由调用方决定收尾
      st.closeBuilder()
      if (editing) st.setSel({ kind: 'trigger', triggerId: editing.id })
    } catch (e: any) {
      setError(String(e?.message || e))
    } finally {
      setBusy(false)
    }
  }

  const stepIcon = (ty: StepDraft['type']): React.ReactNode =>
    ty === 'notify' ? <Bell size={14} /> : ty === 'agent_run' ? <Bot size={14} />
    : ty === 'db_row_add' || ty === 'db_row_edit' ? <Database size={14} /> : <Wrench size={14} />

  return (
    <div className="auto-builder">
      <div className="auto-builder-title">
        <Workflow size={17} /> {editing ? t('automation.builder.editTitle') : t('automation.builder.title')}
      </div>

      <div className="auto-node">
        <div className="auto-node-head"><span className="auto-ic"><Zap size={14} /></span>{t('automation.builder.trigger')}</div>
        <div className="field">
          <label>{t('automation.builder.desc')}</label>
          <input type="text" value={desc} maxLength={200} placeholder={t('automation.builder.descPh')} onChange={(e) => setDesc(e.target.value)} />
        </div>
        {!fixedManual && (
          <div className="field">
            <label>{t('automation.builder.condType')}</label>
            <div className="auto-seg">
              <button className={kind === 'timer' ? 'active' : ''} onClick={() => setKind('timer')}>{t('automation.builder.condTimer')}</button>
              <button className={kind === 'event_seen' ? 'active' : ''} onClick={() => setKind('event_seen')}>{t('automation.builder.condEvent')}</button>
              <button className={kind === 'file_chars_gte' ? 'active' : ''} onClick={() => setKind('file_chars_gte')}>{t('automation.builder.condFile')}</button>
              <button className={kind === 'db_changed' ? 'active' : ''} onClick={() => setKind('db_changed')}>{t('automation.builder.condDb')}</button>
              <button className={kind === 'manual' ? 'active' : ''} onClick={() => setKind('manual')}>{t('automation.builder.condManual')}</button>
            </div>
          </div>
        )}
        {kind === 'db_changed' && (
          <>
            <div className="field">
              <label>{t('automation.builder.dbPath')}</label>
              <select value={dbPath} onChange={(e) => { setDbPath(e.target.value); setDbColumnIds([]) }}>
                <option value="">{t('automation.builder.dbPickDb')}</option>
                {dbFiles.map((f) => <option key={f} value={f}>{f}</option>)}
                {dbPath && !dbFiles.includes(dbPath) && <option value={dbPath}>{dbPath}</option>}
              </select>
            </div>
            <div className="field">
              <label>{t('automation.builder.dbEvent')}</label>
              <div className="auto-seg">
                <button className={dbEvent === 'row_added' ? 'active' : ''} onClick={() => setDbEvent('row_added')}>{t('automation.builder.dbEventRow')}</button>
                <button className={dbEvent === 'cell_changed' ? 'active' : ''} onClick={() => setDbEvent('cell_changed')}>{t('automation.builder.dbEventCell')}</button>
              </div>
            </div>
            {dbEvent === 'cell_changed' && (
              <>
                <div className="field">
                  <label>{t('automation.builder.dbColumn')}</label>
                  <div className="auto-checks">
                    {(dbCols ?? []).map((c) => (
                      <label className="auto-check" key={c.id}>
                        <input type="checkbox" checked={dbColumnIds.includes(c.id)} onChange={(e) => toggleDbColumn(c.id, e.target.checked)} />
                        {c.name}
                      </label>
                    ))}
                    {/* 规则里存着、当前表里已没有(或表还没加载)的列 id:照旧显示成 (id),可以取消勾选,别静默丢 */}
                    {dbColumnIds.filter((id) => !(dbCols ?? []).some((c) => c.id === id)).map((id) => (
                      <label className="auto-check" key={id}>
                        <input type="checkbox" checked onChange={() => toggleDbColumn(id, false)} />
                        ({id})
                      </label>
                    ))}
                    {!dbCols && <span className="auto-hint">{t('automation.builder.dbColsLoading')}</span>}
                  </div>
                  <div className="auto-hint">{t('automation.builder.dbColumnsHint')}</div>
                </div>
                <div className="field">
                  <label>{t('automation.builder.dbEquals')}</label>
                  <input type="text" value={dbEquals} maxLength={200} placeholder={t('automation.builder.dbEqualsPh')} onChange={(e) => setDbEquals(e.target.value)} />
                </div>
              </>
            )}
            {/* 附加条件放在 cell_changed 块**之外**:row_added 也能用(ERP「出库 row_added 且 配件 不为空」)。
                列下拉用 dbColsRaw 不用 dbCols:监听列要求落盘列(游标比得到),where 比的是物化后的值,公式/引用列也行。 */}
            <div className="field">
              <label>{t('automation.builder.dbWhere')}</label>
              {dbWhere.map((w, wi) => (
                <div className="auto-inline" key={wi}>
                  <select value={w.column} onChange={(e) => patchWhere(wi, { column: e.target.value })}>
                    <option value="">{dbColsRaw ? t('automation.builder.dbPickCol') : t('automation.builder.dbColsLoading')}</option>
                    {(dbColsRaw ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    {w.column && !(dbColsRaw ?? []).some((c) => c.id === w.column) && <option value={w.column}>({w.column})</option>}
                  </select>
                  <select value={w.op} onChange={(e) => patchWhere(wi, { op: e.target.value as WhereDraft['op'] })}>
                    {WHERE_OPS.map((op) => (
                      <option key={op} value={op}>
                        {op === 'eq' ? t('automation.builder.dbWhereOpEq') : op === 'ne' ? t('automation.builder.dbWhereOpNe')
                          : op === 'empty' ? t('automation.builder.dbWhereOpEmpty') : t('automation.builder.dbWhereOpNotEmpty')}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={w.value}
                    maxLength={200}
                    disabled={w.op === 'empty' || w.op === 'notempty'}
                    placeholder={t('automation.builder.dbWhereValPh')}
                    onChange={(e) => patchWhere(wi, { value: e.target.value })}
                  />
                  <button className="icon-btn" title={t('common.delete')} onClick={() => setDbWhere((ws) => ws.filter((_, j) => j !== wi))}><Trash2 size={12} /></button>
                </div>
              ))}
              <button
                className="icon-btn"
                title={t('automation.builder.dbWhereAdd')}
                disabled={dbWhere.length >= MAX_WHERE}
                onClick={() => setDbWhere((ws) => [...ws, { column: '', op: 'eq', value: '' }])}
              >＋</button>
              <div className="auto-hint">{t('automation.builder.dbWhereHint')}</div>
            </div>
            <div className="auto-hint">{t('automation.builder.dbHint')}</div>
          </>
        )}
        {kind === 'manual' && <div className="auto-hint">{t('automation.builder.manualHint')}</div>}
        {kind === 'timer' && (
          <>
            <div className="field">
              <label>{t('automation.builder.timerMode')}</label>
              <div className="auto-seg">
                <button className={timerMode === 'daily_at' ? 'active' : ''} onClick={() => setTimerMode('daily_at')}>{t('automation.builder.timerDaily')}</button>
                <button className={timerMode === 'at' ? 'active' : ''} onClick={() => setTimerMode('at')}>{t('automation.builder.timerOnce')}</button>
                <button className={timerMode === 'every' ? 'active' : ''} onClick={() => setTimerMode('every')}>{t('automation.builder.timerEvery')}</button>
              </div>
            </div>
            {timerMode === 'daily_at' && (
              <div className="field"><label>{t('automation.builder.time')}</label><input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></div>
            )}
            {timerMode === 'at' && (
              <div className="field">
                <label>{t('automation.builder.datetime')}</label>
                <input type="datetime-local" value={datetime} onChange={(e) => setDatetime(e.target.value)} />
                <div className="auto-hint">{expiredAt ? t('automation.builder.expiredReset') : t('automation.builder.onceHint')}</div>
              </div>
            )}
            {timerMode === 'every' && (
              <div className="field">
                <label>{t('automation.builder.interval')}</label>
                <div className="auto-inline">
                  <input type="number" value={ivlN} min={1} style={{ width: 90 }} onChange={(e) => setIvlN(e.target.value)} />
                  <select value={ivlUnit} onChange={(e) => setIvlUnit(e.target.value as 'm' | 'h' | 'd')}>
                    <option value="m">{t('automation.builder.unitM')}</option>
                    <option value="h">{t('automation.builder.unitH')}</option>
                    <option value="d">{t('automation.builder.unitD')}</option>
                  </select>
                </div>
                <div className="auto-hint">{t('automation.builder.everyHint')}</div>
              </div>
            )}
          </>
        )}
        {kind === 'event_seen' && (
          <div className="field">
            <label>{t('automation.builder.match')}</label>
            <input type="text" list="auto-event-catalog" value={match} maxLength={120} placeholder={t('automation.builder.matchPh')} onChange={(e) => setMatch(e.target.value)} />
            <datalist id="auto-event-catalog">
              {BUILTIN_EVENTS.map((ev) => <option key={ev} value={ev} />)}
              {listPluginAutomationEvents().map((ev) => <option key={ev.name} value={ev.name} label={ev.label} />)}
            </datalist>
            <div className="auto-hint">{t('automation.builder.matchHint')}</div>
          </div>
        )}
        {kind === 'file_chars_gte' && (
          <>
            <div className="field">
              <label>{t('automation.builder.path')}</label>
              <input type="text" value={path} placeholder="~/Forsion/Notes/xxx.md" onChange={(e) => setPath(e.target.value)} />
            </div>
            <div className="field">
              <label>{t('automation.builder.chars')}</label>
              <input type="number" value={n} min={1} onChange={(e) => setN(e.target.value)} />
            </div>
          </>
        )}
      </div>

      {steps.map((s, i) => {
        const cat = s.type === 'tool_call' ? catalog.find((c) => c.name === s.tool) : undefined
        return (
          <div className="auto-node" key={s.key}>
            <div className="auto-node-head">
              <span className="auto-ic">{stepIcon(s.type)}</span>
              {t('automation.builder.stepN', { n: String(i + 1) })} · {t(`automation.step.${s.type}`)}
              <span className="auto-step-tools">
                <button className="icon-btn" disabled={i === 0} title={t('automation.builder.moveUp')} onClick={() => moveStep(i, -1)}><ArrowUp size={12} /></button>
                <button className="icon-btn" disabled={i === steps.length - 1} title={t('automation.builder.moveDown')} onClick={() => moveStep(i, 1)}><ArrowDown size={12} /></button>
                <button className="icon-btn" title={t('common.delete')} onClick={() => setSteps((ss) => ss.filter((x) => x.key !== s.key))}><Trash2 size={12} /></button>
              </span>
            </div>
            {s.type === 'notify' && (
              <>
                <div className="field">
                  <label>{t('automation.builder.notifyTitle')}</label>
                  <input type="text" value={s.title} maxLength={200} placeholder={t('automation.builder.notifyTitlePh')} onChange={(e) => patchStep(s.key, { title: e.target.value })} />
                </div>
                <div className="field">
                  <label>{t('automation.builder.notifyBody')}</label>
                  <textarea value={s.body} maxLength={4000} onChange={(e) => patchStep(s.key, { body: e.target.value })} />
                </div>
                <div className="auto-hint">{t('automation.builder.notifyHint')}</div>
              </>
            )}
            {s.type === 'agent_run' && (
              <>
                <div className="field">
                  <label>{t('automation.builder.runner')}</label>
                  <select value={s.agentSlug} onChange={(e) => patchStep(s.key, { agentSlug: e.target.value })}>
                    <option value="">{t('automation.builder.runnerPick')}</option>
                    {agentDefs.filter((d) => d.slug !== 'muse').map((d) => (
                      <option key={d.slug} value={d.slug}>{d.name}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>{t('automation.builder.prompt')}</label>
                  <textarea value={s.prompt} maxLength={500} placeholder={t('automation.builder.promptPh')} onChange={(e) => patchStep(s.key, { prompt: e.target.value })} />
                </div>
              </>
            )}
            {(s.type === 'db_row_add' || s.type === 'db_row_edit') && (
              <>
                <div className="field">
                  <label>{t('automation.builder.dbPath')}</label>
                  <select value={s.dbPath} onChange={(e) => patchStep(s.key, { dbPath: e.target.value })}>
                    <option value="">{t('automation.builder.dbPickDb')}</option>
                    {dbFiles.map((f) => <option key={f} value={f}>{f}</option>)}
                    {s.dbPath && !dbFiles.includes(s.dbPath) && <option value={s.dbPath}>{s.dbPath}</option>}
                  </select>
                </div>
                {s.type === 'db_row_edit' && (
                  <div className="field">
                    <label>{t('automation.builder.dbRowId')}</label>
                    <input
                      type="text"
                      value={s.rowId}
                      placeholder={kind === 'db_changed' ? t('automation.builder.dbRowIdPh') : t('automation.builder.dbRowIdRequired')}
                      onChange={(e) => patchStep(s.key, { rowId: e.target.value })}
                    />
                  </div>
                )}
                {s.type === 'db_row_edit' && (
                  <>
                    {/* 自由文本不做下拉:rowFrom 的列属于触发表、match.column 属于目标表,两个列源各异且目标表没有响应式 selector。 */}
                    <div className="field">
                      <label>{t('automation.builder.dbRowFrom')}</label>
                      <input
                        type="text"
                        value={s.rowFrom}
                        maxLength={200}
                        placeholder={t('automation.builder.dbRowFromPh')}
                        onChange={(e) => patchStep(s.key, { rowFrom: e.target.value })}
                      />
                    </div>
                    <div className="field">
                      <label>{t('automation.builder.dbMatch')}</label>
                      <div className="auto-inline">
                        <input
                          type="text"
                          value={s.matchColumn}
                          maxLength={200}
                          placeholder={t('automation.builder.dbCellKey')}
                          style={{ width: 120 }}
                          onChange={(e) => patchStep(s.key, { matchColumn: e.target.value })}
                        />
                        <input
                          type="text"
                          value={s.matchValue}
                          maxLength={2000}
                          placeholder={t('automation.builder.dbMatchValPh')}
                          onChange={(e) => patchStep(s.key, { matchValue: e.target.value })}
                        />
                      </div>
                      <div className="auto-hint">{t('automation.builder.dbTargetHint')}</div>
                    </div>
                  </>
                )}
                <div className="field">
                  <label>{t('automation.builder.dbCells')}</label>
                  {s.cells.map((c, ci) => (
                    <div className="auto-inline" key={ci}>
                      <input
                        type="text"
                        value={c.k}
                        placeholder={t('automation.builder.dbCellKey')}
                        style={{ width: 120 }}
                        onChange={(e) => patchStep(s.key, { cells: s.cells.map((x, j) => (j === ci ? { ...x, k: e.target.value } : x)) })}
                      />
                      <input
                        type="text"
                        value={c.v}
                        placeholder={ci === 0 ? t('automation.builder.dbCellValPh') : t('automation.builder.dbCellVal')}
                        onChange={(e) => patchStep(s.key, { cells: s.cells.map((x, j) => (j === ci ? { ...x, v: e.target.value } : x)) })}
                      />
                      <button className="icon-btn" title={t('common.delete')} disabled={s.cells.length <= 1} onClick={() => patchStep(s.key, { cells: s.cells.filter((_, j) => j !== ci) })}><Trash2 size={12} /></button>
                    </div>
                  ))}
                  <button className="icon-btn" title={t('automation.builder.dbCellAdd')} onClick={() => patchStep(s.key, { cells: [...s.cells, { k: '', v: '' }] })}>＋</button>
                  <div className="auto-hint">{t('automation.builder.dbCellsHint')}</div>
                </div>
                {s.type === 'db_row_add' && (
                  <div className="field">
                    <label>{t('automation.builder.dbSkipIfEmpty')}</label>
                    <input
                      type="text"
                      value={s.skipIfEmpty}
                      maxLength={200}
                      placeholder={t('automation.builder.dbSkipIfEmptyPh')}
                      onChange={(e) => patchStep(s.key, { skipIfEmpty: e.target.value })}
                    />
                  </div>
                )}
              </>
            )}
            {s.type === 'tool_call' && (
              <>
                <div className="field">
                  <label>{t('automation.builder.tool')}</label>
                  <select value={s.tool} onChange={(e) => patchStep(s.key, { tool: e.target.value, argValues: {} })}>
                    <option value="">{t('automation.builder.toolPick')}</option>
                    {catalog.map((c) => (
                      <option key={c.name} value={c.name}>{c.name}{c.dangerous ? ' ⚠' : ''}</option>
                    ))}
                  </select>
                  {cat && <div className="auto-hint">{cat.description}{cat.dangerous ? ` · ${t('automation.builder.dangerous')}` : ''}</div>}
                </div>
                {cat && Object.entries(cat.parameters.properties || {}).map(([pname, p]) => {
                  const required = (cat.parameters.required || []).includes(pname)
                  const label = `${pname}${required ? ' *' : ''}`
                  const val = s.argValues[pname] || ''
                  const setVal = (v: string): void => patchStep(s.key, { argValues: { ...s.argValues, [pname]: v } })
                  return (
                    <div className="field" key={pname}>
                      <label title={p.description || ''}>{label}</label>
                      {p.enum?.length ? (
                        <select value={val} onChange={(e) => setVal(e.target.value)}>
                          <option value=""></option>
                          {p.enum.map((v) => <option key={v} value={v}>{v}</option>)}
                        </select>
                      ) : p.type === 'boolean' ? (
                        <label className="auto-check"><input type="checkbox" checked={val === 'true'} onChange={(e) => setVal(e.target.checked ? 'true' : '')} /> {p.description || ''}</label>
                      ) : p.type === 'number' ? (
                        <input type="number" value={val} onChange={(e) => setVal(e.target.value)} />
                      ) : p.type === 'string' ? (
                        <textarea rows={2} value={val} placeholder={p.description || ''} onChange={(e) => setVal(e.target.value)} />
                      ) : (
                        <textarea rows={2} value={val} placeholder={`JSON — ${p.description || ''}`} onChange={(e) => setVal(e.target.value)} />
                      )}
                    </div>
                  )
                })}
              </>
            )}
          </div>
        )
      })}

      {steps.length === 0 && kind !== 'manual' && (
        <div className="auto-node auto-node-muse">
          <div className="auto-node-head"><span className="auto-ic"><Sparkles size={14} /></span>{t('automation.builder.museFallback')}</div>
          <div className="auto-hint">{t('automation.builder.museFallbackHint')}</div>
          <div className="field">
            <label>{t('automation.builder.prompt')}</label>
            <textarea value={musePrompt} maxLength={500} placeholder={t('automation.builder.promptPh')} onChange={(e) => setMusePrompt(e.target.value)} />
          </div>
        </div>
      )}

      <div className="auto-addstep">
        <button onClick={() => setSteps((ss) => [...ss, blankStep('notify')])}><Bell size={12} /> {t('automation.step.notify')}</button>
        <button onClick={() => setSteps((ss) => [...ss, blankStep('agent_run')])}><Bot size={12} /> {t('automation.step.agent_run')}</button>
        <button disabled={!catalog.length} title={catalog.length ? '' : t('automation.builder.toolCatalogEmpty')} onClick={() => setSteps((ss) => [...ss, blankStep('tool_call')])}><Wrench size={12} /> {t('automation.step.tool_call')}</button>
        <button onClick={() => setSteps((ss) => [...ss, blankStep('db_row_add')])}><Database size={12} /> {t('automation.step.db_row_add')}</button>
        <button onClick={() => setSteps((ss) => [...ss, blankStep('db_row_edit')])}><Database size={12} /> {t('automation.step.db_row_edit')}</button>
      </div>

      {kind !== 'timer' && kind !== 'manual' && (
        <div className="auto-guard">
          <label>{t('automation.builder.cooldown')}</label>
          {/* E6:多维表触发的纯动作链下限 0(链式规则要能不冷却);含 agent 步仍 1h。 */}
          <input type="number" value={cooldown} min={hasAgentStep ? 1 : kind === 'db_changed' ? 0 : 0.25} step="1" onChange={(e) => { cooldownTouched.current = true; setCooldown(e.target.value) }} />
          <span className="auto-hint">
            {hasAgentStep ? t('automation.builder.cooldownAgentHint') : kind === 'db_changed' ? t('automation.builder.cooldownDbHint') : t('automation.builder.cooldownHint')}
          </span>
        </div>
      )}

      {error && <div style={{ color: 'var(--warn, #b8860b)', fontSize: 12, marginTop: 12 }}>{error}</div>}
      <div className="auto-builder-actions">
        <button className="btn ghost" onClick={() => (onCancel ? onCancel() : st.closeBuilder())}>{t('common.cancel')}</button>
        <button className="btn" disabled={!canSave || busy} onClick={() => void save()}>
          {busy ? '…' : t('common.save')}
        </button>
      </div>
    </div>
  )
}
