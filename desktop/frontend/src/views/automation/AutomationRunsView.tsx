/**
 * 自动化 Space 右栏:选中项的触发记录。
 *   动作链规则 → 执行账本(automation_executions:每次触发一行,按步骤 tooltip);
 *   Muse / 旧式 agent 规则 → 该常驻会话的历次 run(GET /agent/special/automation/runs);
 *   Historian → special_agent_log 活动流;
 *   Muse 老路规则 → 记录并在「Muse 巡检」的会话里(提示)。
 * 行只带元信息(时间/状态/摘要),不按 run 切片消息——主区恒显完整会话尾部。
 */
import React, { useEffect, useState } from 'react'
import { CheckCircle2, CircleAlert } from 'lucide-react'
import { Skeleton } from '@lcl/engine'
import './messages'
import { useApp } from '../../stores/appStore'
import { useAutomation, sessionForTrigger } from '../../stores/automationStore'
import { getAutomationExecutions, getAutomationRuns, getHistorianActivity } from '../../services/backendService'
import { useI18n } from '../../i18n'
import { fmtTime } from './lib'
import type { AutomationExecutionInfo, AutomationRunInfo, HistorianActivityItem, TanguDesktopConfig } from '../../types'
import './automation.css'

const dotClass = (status: string): string =>
  status === 'running' || status === 'queued' ? 'running' : status === 'completed' || status === 'done' ? 'on' : 'off'

/** 执行账本的模块级缓存(U-39,stale-while-revalidate):面板重建 / 在规则间来回切时先画上次的记录,后台照常轮询。
 *  按**连接 + 账号**分桶(executionsScope):换账号 / 换后端 = 换桶,旧环境的记录绝不先画出来;
 *  cfg 里别的字段(默认模型、生图模型 …)变了不换桶 —— 以前按 cfg 对象引用分桶,在别处改个默认模型
 *  appStore 就换一个新 cfg 对象,回来又是骨架(Codex 第一轮 D-2)。
 *  Codex 第三轮 H1-5:键里只放令牌的哈希(不在内存里另存一份明文令牌);桶数与每桶条目都有上限(按最近使用淘汰);
 *  退出 / 切换账号时整份清空 —— 长期运行、来回换连接或账号也不会无限增长。 */
const MAX_SCOPES = 4
const MAX_TRIGGERS_PER_SCOPE = 40
const executionsCache = new Map<string, Map<string, AutomationExecutionInfo[]>>()
/** 非加密哈希(cyrb53):只为让缓存键里不出现明文令牌,不做安全用途。 */
function tokenDigest(token: string): string {
  let h1 = 0xdeadbeef ^ token.length
  let h2 = 0x41c6ce57 ^ token.length
  for (let i = 0; i < token.length; i++) {
    const c = token.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}
export function executionsScope(cfg: Pick<TanguDesktopConfig, 'backendUrl' | 'token'>, accountId: string | null | undefined): string {
  return JSON.stringify([cfg.backendUrl.replace(/\/+$/, ''), cfg.token ? tokenDigest(cfg.token) : '', accountId ?? ''])
}
/** 取桶(没有就建),并把它挪到「最近使用」一端;超出桶数上限时淘汰最久没用的。 */
const cacheOf = (scope: string): Map<string, AutomationExecutionInfo[]> => {
  let bucket = executionsCache.get(scope)
  if (bucket) executionsCache.delete(scope)
  else bucket = new Map()
  executionsCache.set(scope, bucket)
  while (executionsCache.size > MAX_SCOPES) executionsCache.delete(executionsCache.keys().next().value!)
  return bucket
}
/** 写一条规则的记录,同样按最近使用淘汰超出上限的规则。 */
const remember = (scope: string, triggerId: string, rows: AutomationExecutionInfo[]): void => {
  const bucket = cacheOf(scope)
  bucket.delete(triggerId)
  bucket.set(triggerId, rows)
  while (bucket.size > MAX_TRIGGERS_PER_SCOPE) bucket.delete(bucket.keys().next().value!)
}
/** 只读:不建桶、不改淘汰顺序(渲染期调用)。 */
const peek = (scope: string, triggerId: string): AutomationExecutionInfo[] | undefined => executionsCache.get(scope)?.get(triggerId)
/** 测试用:当前缓存形状(桶数、每桶条目数、全部键)。 */
export const executionsCacheStats = (): { scopes: string[]; sizes: number[] } =>
  ({ scopes: [...executionsCache.keys()], sizes: [...executionsCache.values()].map((b) => b.size) })
// 退出 / 切换账号 → 整份清空(旧账号的记录不留在内存里)。订阅挂在模块上:面板没开着也照样清。
if (typeof (useApp as { subscribe?: unknown }).subscribe === 'function') {
  useApp.subscribe((s, prev) => {
    const now = s.authInfo?.loggedIn ? (s.authInfo.accountId ?? s.authInfo.username ?? '') : null
    const before = prev.authInfo?.loggedIn ? (prev.authInfo.accountId ?? prev.authInfo.username ?? '') : null
    if (before !== null && now !== before) executionsCache.clear()
  })
}

/** Expandable ledger, shared by the main result area and the runs sidebar. */
export const ExecutionsList: React.FC<{ triggerId: string }> = ({ triggerId }) => {
  const { t } = useI18n()
  const cfg = useApp((s) => s.cfg)
  const accountId = useApp((s) => s.authInfo?.accountId ?? s.authInfo?.username ?? null)
  const scope = executionsScope(cfg, accountId)
  const nonce = useAutomation((s) => s.refreshNonce)
  const [rows, setRows] = useState<AutomationExecutionInfo[]>(() => peek(scope, triggerId) ?? [])
  const [loading, setLoading] = useState(() => !peek(scope, triggerId))
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let alive = true
    const pull = async (): Promise<void> => {
      try {
        const result = await getAutomationExecutions(cfg, triggerId)
        if (!alive) return // 已卸载 / 已换规则或配置:迟到的结果不进缓存也不上屏
        remember(scope, triggerId, result)
        setRows(result); setFailed(false)
      } catch { if (alive) setFailed(true) }
      finally { if (alive) setLoading(false) }
    }
    void pull()
    const timer = setInterval(() => void pull(), 8000)
    return () => { alive = false; clearInterval(timer) }
  }, [cfg, scope, triggerId, nonce, retry])
  // 骨架自带 150ms 出现延迟(快的时候什么都不闪);读屏靠 sr-only 状态句。
  if (loading) return <div className="auto-runs-loading"><Skeleton variant="list" /><span className="auto-sr-only" role="status">{t('automation.ux.runLoading')}</span></div>
  if (failed) return <div className="auto-runs-empty" role="alert">{t('automation.ux.runError')} <button className="btn ghost sm" onClick={() => setRetry((n) => n + 1)}>{t('automation.ux.retry')}</button></div>
  if (!rows.length) return <div className="auto-runs-empty">{t('automation.ux.runEmpty')}</div>
  return <div className="auto-executions">{rows.map((r, index) => (
    <details key={r.id} className="auto-execution" open={index === 0 ? true : undefined}>
      <summary>
        <span className={`auto-dot ${dotClass(r.status)}`} />
        <time>{fmtTime(r.created_at)}</time>
        <span className="auto-execution-status">{['done', 'failed', 'running', 'queued'].includes(r.status) ? t(`automation.ux.${r.status}`) : r.status}</span>
        <span className="auto-hint">{t(r.origin === 'auto' ? 'automation.ux.autoOrigin' : 'automation.ux.manualOrigin')}</span>
      </summary>
      {r.error && <p className="auto-execution-error">{r.error}</p>}
      <ol>{r.steps.map((step, i) => <li key={i}>
        {step.ok ? <CheckCircle2 size={14} /> : <CircleAlert size={14} />}
        <div><strong>{t('automation.ux.stepResult', { n: String(i + 1), type: t(`automation.step.${step.type}`) })}{step.tool ? ` · ${step.tool}` : ''}</strong><p>{step.summary}</p></div>
      </li>)}</ol>
      {!r.steps.length && <p className="auto-hint">{t('automation.ux.noSteps')}</p>}
    </details>
  ))}</div>
}

const RunsList: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const { t } = useI18n()
  const cfg = useApp((s) => s.cfg)
  const nonce = useAutomation((s) => s.refreshNonce)
  const [runs, setRuns] = useState<AutomationRunInfo[]>([])
  useEffect(() => {
    let alive = true
    const pull = (): void => void getAutomationRuns(cfg, sessionId).then((r) => alive && setRuns(r)).catch(() => {})
    pull()
    const timer = setInterval(pull, 8000)
    return () => { alive = false; clearInterval(timer) }
  }, [cfg, sessionId, nonce])
  if (!runs.length) return <div className="auto-runs-empty">{t('automation.runs.empty')}</div>
  return (
    <>
      {runs.map((r) => (
        <div key={r.id} className="auto-run-row" title={r.error || r.status}>
          <span className={`auto-dot ${dotClass(r.status)}`} />
          <span className="auto-run-time">{fmtTime(r.created_at)}</span>
          <span className="auto-run-meta">
            {r.error ? r.error.slice(0, 40) : r.tokens_total ? `${(r.tokens_total / 1000).toFixed(1)}k tok` : r.status}
          </span>
        </div>
      ))}
    </>
  )
}

const HistorianList: React.FC = () => {
  const { t } = useI18n()
  const cfg = useApp((s) => s.cfg)
  const [items, setItems] = useState<HistorianActivityItem[]>([])
  useEffect(() => {
    let alive = true
    const pull = (): void => void getHistorianActivity(cfg, 50).then((a) => alive && setItems(a)).catch(() => {})
    pull()
    const timer = setInterval(pull, 8000)
    return () => { alive = false; clearInterval(timer) }
  }, [cfg])
  if (!items.length) return <div className="auto-runs-empty">{t('automation.runs.empty')}</div>
  return (
    <>
      {items.map((it) => (
        <div key={it.id} className="auto-run-row" title={it.detail}>
          <span className="auto-dot on" />
          <span className="auto-run-time">{fmtTime(it.created_at)}</span>
          <span className="auto-run-meta">{it.action}</span>
        </div>
      ))}
    </>
  )
}

export const AutomationRunsView: React.FC<{ renderSession?: (sessionId: string) => React.ReactNode }> = ({ renderSession }) => {
  const { t } = useI18n()
  const st = useAutomation()
  const sel = st.builder ? null : st.sel

  let body: React.ReactNode = <div className="auto-runs-empty">{t('automation.runs.pick')}</div>
  if (sel?.kind === 'muse') {
    body = st.museStatus?.sessionId ? <RunsList sessionId={st.museStatus.sessionId} /> : <div className="auto-runs-empty">{t('automation.runs.empty')}</div>
  } else if (sel?.kind === 'historian') {
    body = <HistorianList />
  } else if (sel?.kind === 'trigger') {
    const tr = st.triggers.find((x) => x.id === sel.triggerId)
    if (tr?.actions?.length) {
      body = <ExecutionsList key={tr.id} triggerId={tr.id} />
    } else if (tr?.agentSlug) {
      const sid = sessionForTrigger(st.autoSessions, tr.id)
      body = sid ? <><RunsList sessionId={sid} />{renderSession?.(sid)}</> : <div className="auto-runs-empty">{t('automation.trigger.neverFired')}</div>
    } else {
      body = <div className="auto-runs-empty">{t('automation.trigger.museNote')}</div>
    }
  } else if (sel?.kind === 'schedule') {
    const sid = sessionForTrigger(st.autoSessions, `sched:${sel.slug}:${sel.rowId}`)
    body = sid ? <RunsList sessionId={sid} /> : <div className="auto-runs-empty">{t('automation.trigger.neverFired')}</div>
  }

  return <div className="auto-runs">{body}</div>
}
