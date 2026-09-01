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
import React, { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Bell, Bot, Database, Sparkles, Trash2, Workflow, Wrench, Zap } from 'lucide-react'
import { useApp } from '../../stores/appStore'
import { useAutomation } from '../../stores/automationStore'
import { saveMuseTrigger } from '../../services/backendService'
import { useI18n } from '../../i18n'
import { BUILTIN_EVENTS, isFinishedTrigger, parseLocalDatetime } from './lib'
import { listPluginAutomationEvents } from '../../amadeus/plugins/pluginStore'
import { useShallow } from 'zustand/react/shallow'
import { usePageStore } from '../../amadeus/store/pageStore'
import { useDbStore } from '../../amadeus/store/dbStore'
import { ensureAmadeusReady } from '../../amadeusPlugins'
import type { AutomationActionCatalogItem, AutomationActionSpec, MuseTriggerInfo } from '../../types'

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

interface StepDraft {
  key: number
  type: 'notify' | 'agent_run' | 'tool_call' | 'db_row_add' | 'db_row_edit'
  title: string
  body: string
  agentSlug: string
  prompt: string
  tool: string
  /** 工具参数原始输入(全字符串;boolean 存 'true'/'')。 */
  argValues: Record<string, string>
  /** db 动作:目标 .db(vault 相对路径)。 */
  dbPath: string
  /** db_row_edit:行 id;空 = 触发命中的那一行(仅多维表触发下有)。 */
  rowId: string
  /** db 动作:写入的 列名/列id → 值(值可含 {{row.X}} 模板)。 */
  cells: Array<{ k: string; v: string }>
}

/** 本版构建器能编辑的全部步骤类型(2.8 起含 DB 动作)。 */
function isEditableStep(a: AutomationActionSpec): boolean {
  return a.type === 'notify' || a.type === 'agent_run' || a.type === 'tool_call' || a.type === 'db_row_add' || a.type === 'db_row_edit'
}

/** 这条规则里有本版构建器还不认识的部分吗(将来引擎新增的动作类型;不静默降级 —— 那等于
 *  用户点开看一眼、按保存就把动作抹了)。 */
export function hasUnsupportedParts(t?: MuseTriggerInfo): boolean {
  if (!t) return false
  return !!t.actions?.some((a) => !isEditableStep(a))
}

let stepKey = 1
const blankStep = (type: StepDraft['type']): StepDraft =>
  ({ key: stepKey++, type, title: '', body: '', agentSlug: '', prompt: '', tool: '', argValues: {}, dbPath: '', rowId: '', cells: [{ k: '', v: '' }] })

/** editing → 表单初值(旧式 agentSlug 规则转成一个 agent_run 步骤)。 */
function stepsFrom(editing?: MuseTriggerInfo): StepDraft[] {
  if (editing?.actions?.length) {
    return editing.actions.filter(isEditableStep).map((a) => ({
      ...blankStep(a.type as StepDraft['type']),
      title: a.type === 'notify' ? a.title : '',
      body: a.type === 'notify' ? a.body || '' : '',
      agentSlug: a.type === 'agent_run' ? a.agentSlug : '',
      prompt: a.type === 'agent_run' ? a.prompt : '',
      tool: a.type === 'tool_call' ? a.tool : '',
      argValues: a.type === 'tool_call'
        ? Object.fromEntries(Object.entries(a.args || {}).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]))
        : {},
      dbPath: a.type === 'db_row_add' || a.type === 'db_row_edit' ? a.path : '',
      rowId: a.type === 'db_row_edit' ? a.rowId || '' : '',
      cells: a.type === 'db_row_add' || a.type === 'db_row_edit'
        ? [...Object.entries(a.cells || {}).map(([k, v]) => ({ k, v })), { k: '', v: '' }]
        : [{ k: '', v: '' }],
    }))
  }
  if (editing?.agentSlug) return [{ ...blankStep('agent_run'), agentSlug: editing.agentSlug, prompt: editing.prompt || '' }]
  return []
}

/** 本地 datetime-local 初值:整点下一小时。 */
function defaultDatetime(): string {
  const d = new Date(Date.now() + 3600_000)
  d.setMinutes(0, 0, 0)
  const p = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:00`
}

/** 参数原始输入 → 工具 args(按 schema 类型转换;空值省略;非原语字段尝试 JSON)。 */
function buildToolArgs(cat: AutomationActionCatalogItem | undefined, vals: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const props = cat?.parameters?.properties || {}
  for (const [k, raw] of Object.entries(vals)) {
    if (raw === undefined || raw === '') continue
    const ty = props[k]?.type
    if (ty === 'number') out[k] = Number(raw)
    else if (ty === 'boolean') out[k] = raw === 'true'
    else if (ty === 'string' || ty === undefined) out[k] = raw
    else { try { out[k] = JSON.parse(raw) } catch { out[k] = raw } }
  }
  return out
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
  const [dbColumnId, setDbColumnId] = useState(initCond?.type === 'db_changed' ? initCond.columnId || '' : '')
  const [dbEquals, setDbEquals] = useState(initCond?.type === 'db_changed' ? initCond.equals || '' : '')
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
  const [cooldown, setCooldown] = useState(String(editing?.cooldownHours || 24))
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
      // 改行:不是多维表触发就没有「触发命中的那一行」可缺省,必须显式给行 id。
      if (s.type === 'db_row_edit' && kind !== 'db_changed' && !s.rowId.trim()) return false
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
      if (dbEvent === 'cell_changed' && !dbColumnId.trim()) return false
    }
    // 手动类没有 Muse 兜底语义:0 步骤的按钮点了什么也不会发生,直接不让存。
    if (kind === 'manual' && !steps.length) return false
    return steps.every(stepValid)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stepValid 闭包只另依赖 kind/catalog(已在列)
  }, [desc, kind, timerMode, time, datetime, ivlN, match, path, n, dbPath, dbEvent, dbColumnId, steps, catalog])

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
    const cellsOf = (s: StepDraft): Record<string, string> =>
      Object.fromEntries(s.cells.filter((c) => c.k.trim()).map((c) => [c.k.trim(), c.v]))
    const actions: AutomationActionSpec[] = steps.map((s) =>
      s.type === 'notify' ? { type: 'notify', title: s.title.trim(), body: s.body.trim() || undefined }
      : s.type === 'agent_run' ? { type: 'agent_run', agentSlug: s.agentSlug, prompt: s.prompt.trim() }
      : s.type === 'db_row_add' ? { type: 'db_row_add', path: s.dbPath.trim(), cells: cellsOf(s) }
      : s.type === 'db_row_edit' ? { type: 'db_row_edit', path: s.dbPath.trim(), rowId: s.rowId.trim() || undefined, cells: cellsOf(s) }
      : { type: 'tool_call', tool: s.tool, args: buildToolArgs(catalog.find((c) => c.name === s.tool), s.argValues) })
    try {
      const saved = await saveMuseTrigger(cfg, {
        id: editing?.id,
        desc: desc.trim(),
        cond_type: condType,
        time: condType === 'daily_at' ? time : undefined,
        datetime: condType === 'at' ? datetime : undefined,
        interval: condType === 'every' ? `${Math.floor(Number(ivlN))}${ivlUnit}` : undefined,
        match: condType === 'event_seen' ? match.trim() : undefined,
        path: condType === 'file_chars_gte' ? path.trim() : condType === 'db_changed' ? dbPath.trim() : undefined,
        n: condType === 'file_chars_gte' ? Number(n) : undefined,
        event: condType === 'db_changed' ? dbEvent : undefined,
        column_id: condType === 'db_changed' && dbEvent === 'cell_changed' ? dbColumnId.trim() : undefined,
        equals: condType === 'db_changed' && dbEvent === 'cell_changed' && dbEquals.trim() ? dbEquals.trim() : undefined,
        // 编辑既有 db 规则:钉回建规则时的 vault(省略会被引擎重钉到**当前** vault,切库编辑会静默改靶)。
        vault: condType === 'db_changed' && editing?.cond.type === 'db_changed' ? editing.cond.vault : undefined,
        prompt: steps.length ? undefined : musePrompt.trim() || undefined,
        cooldown_hours: kind === 'timer' || kind === 'manual' ? undefined : Number(cooldown) > 0 ? Number(cooldown) : undefined,
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
              <select value={dbPath} onChange={(e) => { setDbPath(e.target.value); setDbColumnId('') }}>
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
                  <select value={dbColumnId} onChange={(e) => setDbColumnId(e.target.value)}>
                    <option value="">{dbCols ? t('automation.builder.dbPickCol') : t('automation.builder.dbColsLoading')}</option>
                    {(dbCols ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    {dbColumnId && !(dbCols ?? []).some((c) => c.id === dbColumnId) && <option value={dbColumnId}>({dbColumnId})</option>}
                  </select>
                </div>
                <div className="field">
                  <label>{t('automation.builder.dbEquals')}</label>
                  <input type="text" value={dbEquals} maxLength={200} placeholder={t('automation.builder.dbEqualsPh')} onChange={(e) => setDbEquals(e.target.value)} />
                </div>
              </>
            )}
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
                        placeholder={t('automation.builder.dbCellVal')}
                        onChange={(e) => patchStep(s.key, { cells: s.cells.map((x, j) => (j === ci ? { ...x, v: e.target.value } : x)) })}
                      />
                      <button className="icon-btn" title={t('common.delete')} disabled={s.cells.length <= 1} onClick={() => patchStep(s.key, { cells: s.cells.filter((_, j) => j !== ci) })}><Trash2 size={12} /></button>
                    </div>
                  ))}
                  <button className="icon-btn" title={t('automation.builder.dbCellAdd')} onClick={() => patchStep(s.key, { cells: [...s.cells, { k: '', v: '' }] })}>＋</button>
                  <div className="auto-hint">{t('automation.builder.dbCellsHint')}</div>
                </div>
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
          <input type="number" value={cooldown} min={hasAgentStep ? 1 : 0.25} step="1" onChange={(e) => setCooldown(e.target.value)} />
          <span className="auto-hint">{hasAgentStep ? t('automation.builder.cooldownAgentHint') : t('automation.builder.cooldownHint')}</span>
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
