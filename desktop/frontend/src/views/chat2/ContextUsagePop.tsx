/**
 * 输入框上下文环的详情弹层(09-26,对标 Claude 的 Context window 面板):
 * 头部「已用 / 窗口 tokens(%)」+ 分段条 + 自动压缩线;点头部展开分项、窗口来源与指令文件;
 * 登录 Forsion 再列今日 / 本周托管额度。
 *
 * 分项口径:引擎 context_info 只给系统提示各段与历史消息的**估算**,工具定义不单列 → 真实占用减去两者的余数
 * 记作「工具与本轮」。按「系统段 → 历史 → 余数」依次截断:压缩后占用回落、分项仍是 run 开始时的值,也不会出负数。
 */
import { Fragment, useEffect, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { CtxInfo } from '../../types'
import { registerMessages, useI18n } from '../../i18n'
import { useApp } from '../../stores/appStore'
import { TierBadge } from '../../components/TierBadge'
import { formatDateTime } from '../../format/time'
import { publishAccountQuota, remainingPercent, subscribeAccountQuota, type AccountQuotaView } from '../../services/accountQuota'

registerMessages({
  'ctx.pop.title': { zh: '上下文窗口', en: 'Context window' },
  'ctx.pop.compact': { zh: '立即压缩', en: 'Compact now' },
  'ctx.grp.tools': { zh: '工具与本轮', en: 'Tools & this run' },
  'ctx.grp.system': { zh: '系统提示', en: 'System prompt' },
  'ctx.grp.memory': { zh: '记忆', en: 'Memory' },
  'ctx.grp.project': { zh: '项目与资料', en: 'Project & files' },
  'ctx.grp.skills': { zh: '技能', en: 'Skills' },
  'ctx.grp.used': { zh: '已用', en: 'Used' },
  'ctx.grp.buffer': { zh: '自动压缩预留', en: 'Auto-compact buffer' },
  'ctx.grp.free': { zh: '剩余可用', en: 'Free space' },
  'ctx.untilCompact': { zh: '还剩 {left} 触发自动压缩（{n}，{pct}%）', en: '{left} until auto-compact ({n}, {pct}%)' },
  'ctx.limit.title': { zh: 'Forsion 额度', en: 'Forsion usage limits' },
  'ctx.limit.resetsIn': { zh: '{h} 小时 {m} 分钟后重置', en: 'Resets in {h} hr {m} min' },
  'ctx.limit.resetsAt': { zh: '{when} 重置', en: 'Resets {when}' },
  'ctx.limit.used': { zh: '已用 {pct}%', en: '{pct}% used' },
})

/** token 计数进位:满千 k、满百万 M,一位小数。截断而非四舍五入 —— 999,999 是 999.9k,不是 1000k。 */
export const fmtTokens = (n: number): string =>
  n >= 1e6 ? `${Math.floor(n / 1e5) / 10}M` : n >= 1e3 ? `${Math.floor(n / 100) / 10}k` : String(n)

/** 引擎已知的注入段;未来新增的段显示 key 本身并归进「系统提示」,别渲染成 'ctx.sec.xxx' 原始键。 */
const CTX_SEC_KEYS = new Set(['persona', 'harness', 'guidance', 'profile', 'project', 'agentFolder', 'memory', 'skills', 'environment', 'hooks', 'plan'])

// 没有分类色板:借模型标签的蓝 / 紫 + 语义绿 / 琥珀 + 主题色调和。不用 --danger —— 弹层里它是「预警」的意思。
const BLUE = 'var(--model-tag-blue)'
const GROUPS = [
  { id: 'system', keys: ['persona', 'guidance', 'environment', 'hooks', 'plan'], color: 'var(--warning)' },
  { id: 'memory', keys: ['memory', 'profile', 'harness'], color: 'var(--green)' },
  { id: 'project', keys: ['project', 'agentFolder'], color: 'color-mix(in srgb, var(--accent-ink) 55%, transparent)' },
  { id: 'skills', keys: ['skills'], color: 'color-mix(in srgb, var(--model-tag-blue) 45%, var(--green))' },
]

export interface CtxSegment {
  id: string
  label: string
  tokens: number
  color: string
  parts?: Array<{ label: string; tokens: number }>
}

/** 真实占用 used 按分项切段(见文件头口径);没有 context_info(本次启动还没跑过 run)只给一段「已用」。 */
export function ctxSegments(used: number, info: CtxInfo | null, t: (k: string, v?: Record<string, unknown>) => string): CtxSegment[] {
  if (!info) return used > 0 ? [{ id: 'used', label: t('ctx.grp.used'), tokens: used, color: BLUE }] : []
  let left = Math.max(0, used)
  const take = (n: number): number => { const v = Math.min(left, Math.max(0, n)); left -= v; return v }
  const groups: CtxSegment[] = GROUPS.map((g) => {
    const parts = info.sections.filter((s) => g.keys.includes(s.k) || (g.id === 'system' && !CTX_SEC_KEYS.has(s.k)))
    const sum = parts.reduce((n, s) => n + s.tokens, 0)
    const tokens = take(sum)
    return {
      id: g.id,
      label: t(`ctx.grp.${g.id}`),
      color: g.color,
      tokens,
      // 被截断了(压缩后)就不列子项:子项还是 run 开始时的估算,会比父项大
      parts: tokens === sum ? parts.map((s) => ({ label: CTX_SEC_KEYS.has(s.k) ? t(`ctx.sec.${s.k}`) : s.k, tokens: s.tokens })) : undefined,
    }
  })
  const messages = { id: 'messages', label: t('ctx.sec.history', { n: info.historyCount }), tokens: take(info.historyTokens), color: BLUE }
  const tools = { id: 'tools', label: t('ctx.grp.tools'), tokens: left, color: 'var(--model-tag-purple)' }
  return [messages, tools, ...groups].filter((s) => s.tokens > 0)
}

const BEIJING = 8 * 3600e3
/** 托管额度按北京时间 0 点换日(server tokenQuotaService 的周期口径)。 */
export const msToDailyReset = (now: number): number => 86400e3 - ((now + BEIJING) % 86400e3)
/** weeklyResetAt 是北京日历日 YYYY-MM-DD:手工拆,不过 new Date(str)(按 UTC 解析,西时区会差一天)。 */
export function weeklyResetTime(d?: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || '')
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - BEIJING) : null
}

interface Props {
  open: boolean
  contextWindow: number
  ctxTokens?: number
  sessionTokens?: number
  runCost?: number
  costLimit?: number
  ctxInfo?: CtxInfo | null
  onCompact?: () => void
}

export function ContextUsagePop({ open, contextWindow, ctxTokens, sessionTokens, runCost, costLimit, ctxInfo, onCompact }: Props) {
  const { t } = useI18n()
  const [detail, setDetail] = useState(false)
  const used = ctxTokens || 0
  const pct = (n: number): number => (n / contextWindow) * 100
  const fmtPct = (n: number): string => `${Math.round(pct(n) * 10) / 10}%`
  // 超出窗口(模型实际窗口比登记的大)时分段按窗口封顶,否则图例百分比加起来超过 100%;头部仍写真实占用
  const segs = ctxSegments(Math.min(used, contextWindow), ctxInfo ?? null, t)
  const compactAt = ctxInfo?.compactAt && ctxInfo.compactAt < contextWindow ? ctxInfo.compactAt : 0
  const buffer = compactAt ? Math.max(0, contextWindow - Math.max(compactAt, used)) : 0
  const free = Math.max(0, contextWindow - used - buffer)
  return (
    <>
      <button type="button" className="t2c-cu-head" aria-expanded={detail} onClick={() => setDetail((v) => !v)}>
        <span className="t2c-cu-title">{t('ctx.pop.title')}</span>
        <span className="t2c-cu-num">{fmtTokens(used)} / {fmtTokens(contextWindow)} tokens ({Math.min(100, Math.round(pct(used)))}%)</span>
        <ChevronRight size={13} className="t2c-cu-chev" aria-hidden="true" />
      </button>
      <span className="t2c-cu-bar" aria-hidden="true">
        {segs.map((s) => <span key={s.id} style={{ width: `${pct(s.tokens)}%`, background: s.color }} />)}
        {buffer > 0 && <span className="t2c-cu-buffer" style={{ width: `${pct(buffer)}%` }} />}
      </span>
      {/* 被缺省上限封了顶(模型本身更大、没手动覆盖):说清楚分母为什么不是模型窗口 —— 不藏进详情,一眼要看到 */}
      {ctxInfo && ctxInfo.ctxWindowSource !== 'override' && (ctxInfo.ctxWindowMax ?? 0) > ctxInfo.ctxWindow && (
        <span className="t2c-ctxinfo-src">{t('ctx.windowCapped', { max: fmtTokens(ctxInfo.ctxWindowMax!), n: fmtTokens(ctxInfo.ctxWindow) })}</span>
      )}
      {detail && (
        <span className="t2c-cu-detail">
          <span className="t2c-cu-legend">
            {segs.map((s) => (
              <Fragment key={s.id}>
                <span className="t2c-cu-row"><i style={{ background: s.color }} /><span>{s.label}</span><span>{fmtTokens(s.tokens)}</span><span>{fmtPct(s.tokens)}</span></span>
                {s.parts && s.parts.length > 1 && s.parts.map((p) => (
                  <span key={p.label} className="t2c-cu-row is-sub"><i /><span>{p.label}</span><span>~{fmtTokens(p.tokens)}</span><span /></span>
                ))}
              </Fragment>
            ))}
            {buffer > 0 && <span className="t2c-cu-row"><i className="t2c-cu-buffer" /><span>{t('ctx.grp.buffer')}</span><span>{fmtTokens(buffer)}</span><span>{fmtPct(buffer)}</span></span>}
            <span className="t2c-cu-row"><i className="is-free" /><span>{t('ctx.grp.free')}</span><span>{fmtTokens(free)}</span><span>{fmtPct(free)}</span></span>
          </span>
          {/* 窗口来源:family/default 是猜的,要标注 */}
          {ctxInfo && (
            <span className="t2c-ctxinfo-src">
              {t(`ctx.windowSource.${['override', 'model', 'learned', 'family', 'default'].includes(ctxInfo.ctxWindowSource) ? ctxInfo.ctxWindowSource : 'default'}`)}
            </span>
          )}
          {!!sessionTokens && sessionTokens > 0 && <span className="t2c-ctxinfo-src">{t('input.sessionTokens', { n: fmtTokens(sessionTokens) })}</span>}
          {/* 空态也要说话:不显示这一节时,「这个工作区没有指令文件」和「这功能坏了」长得一模一样(08-18 真机走查的假 ❌)。 */}
          {ctxInfo && (
            <span className="t2c-ctxinfo-files">
              <span className="t2c-ctxinfo-label">{t('ctx.files.label')}{ctxInfo.filesTruncated ? ` ${t('ctx.files.truncated')}` : ''}</span>
              {ctxInfo.files.length > 0
                ? ctxInfo.files.map((f) => <span key={f} className="t2c-ctxinfo-file" title={f}>{f.split(/[/\\]/).slice(-2).join('/')}</span>)
                : <span className="t2c-ctxinfo-file dim">{t('ctx.files.none')}</span>}
            </span>
          )}
        </span>
      )}
      <span className="t2c-cu-foot">
        {/* 触发线用引擎算好的 compactAt(窗口 − 预留,再被设置里的百分比往下拉),不在客户端另算一份 */}
        {compactAt > 0 && <span>{t('ctx.untilCompact', { left: fmtTokens(Math.max(0, compactAt - used)), n: fmtTokens(compactAt), pct: Math.round(pct(compactAt)) })}</span>}
        {onCompact && <button type="button" className="t2c-ctxring-compact" onClick={onCompact} title={t('input.slash.compact')}>{t('ctx.pop.compact')}</button>}
      </span>
      {runCost != null && costLimit != null && costLimit > 0 && (
        <span className="t2c-ctxinfo-src" data-warn={runCost >= costLimit * 0.8 || undefined}>{t('input.runCost', { used: Math.round(runCost).toLocaleString(), limit: costLimit.toLocaleString() })}</span>
      )}
      <QuotaLimits open={open} />
    </>
  )
}

/** 登录 Forsion 才有:今日 / 本周托管额度(用量口径同账号菜单;后台 Agent 额度与重置卡仍只在账号菜单)。 */
function QuotaLimits({ open }: { open: boolean }) {
  const { t, locale } = useI18n()
  // 账号身份进依赖:A 直接切到 B 时清掉 A 的额度、作废 A 在途的请求(只看「登没登录」会串号)
  const account = useApp((s) => (s.authInfo?.loggedIn && s.authInfo.tokenValid !== false ? `${s.authInfo.accountId ?? ''}:${s.authInfo.username ?? ''}` : null))
  const can = account !== null && !!window.tangu?.accountQuota
  const tier = useApp((s) => s.authInfo?.membershipTier)
  const [quota, setQuota] = useState<AccountQuotaView | null>(null)
  // 每收到一次别处推来的新额度(重置卡、提示条刷新)就进一代;在途的旧请求回来发现代数变了就作废,别把新值盖回旧值
  const gen = useRef(0)
  useEffect(() => subscribeAccountQuota((q) => { gen.current++; setQuota(q) }), [])
  useEffect(() => { setQuota(null) }, [account])
  useEffect(() => {
    if (!can || !open) return
    let alive = true
    const mine = ++gen.current
    void window.tangu!.accountQuota!().then((r) => {
      if (!alive || mine !== gen.current || r?.status !== 200 || !r.json) return
      setQuota(r.json as AccountQuotaView)
      publishAccountQuota(r.json as AccountQuotaView) // 顺手同步额度提示条 / 账号菜单
    }).catch(() => {})
    return () => { alive = false }
  }, [open, account, can])
  if (!can || !quota) return null
  const left = msToDailyReset(Date.now())
  const weekly = weeklyResetTime(quota.weeklyResetAt)
  const rows = [
    {
      key: 'daily', label: t('sidebar.account.menu.daily'), limit: Number(quota.dailyLimit),
      rem: remainingPercent(quota.dailyLimit, quota.dailyRemaining, quota.dailyPercent),
      reset: t('ctx.limit.resetsIn', { h: Math.floor(left / 3600e3), m: Math.floor((left % 3600e3) / 60e3) }),
    },
    {
      key: 'weekly', label: t('sidebar.account.menu.weekly'), limit: Number(quota.weeklyLimit),
      rem: remainingPercent(quota.weeklyLimit, quota.weeklyRemaining, quota.weeklyPercent),
      reset: weekly ? t('ctx.limit.resetsAt', { when: formatDateTime(weekly, { locale }) }) : '',
    },
  ].filter((r) => r.limit < 0 || r.rem !== null)
  if (!rows.length) return null
  return (
    <span className="t2c-cu-limits">
      <span className="t2c-cu-limits-title">{t('ctx.limit.title')}<TierBadge tier={tier} /></span>
      {rows.map((r) => (
        <span key={r.key} className="t2c-cu-limit" data-limit={r.key}>
          <span className="t2c-cu-limit-line">
            <span className="t2c-cu-limit-name">{r.label}</span>
            {r.rem !== null && <span className="t2c-cu-limit-reset">{r.reset}</span>}
            <span>{r.rem === null ? t('sidebar.account.menu.unlimited') : t('ctx.limit.used', { pct: Math.round(100 - r.rem) })}</span>
          </span>
          {r.rem !== null && (
            <span className="t2c-cu-bar" data-warn={r.rem <= 15 || undefined} aria-hidden="true"><span style={{ width: `${100 - r.rem}%` }} /></span>
          )}
        </span>
      ))}
    </span>
  )
}
