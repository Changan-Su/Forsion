/**
 * 额度提醒(借 magpie 第二轮 11,设置 → 通知 → 额度,缺省都关):
 *  - 用到一定比例(50 / 80 / 95%)时提醒;
 *  - 按周或更长的窗口快重置了还剩很多(续期前 24 小时、已用不到 85%)时提醒 —— Codex 的 5 小时窗口不算,否则每 5 小时弹一次。
 * 数据复用引擎的来源额度缓存(GET /agent/models/quota,按来源缓存 5 分钟,上下文环弹层同一份),不另起轮询:
 * 启动拿到模型目录、窗口回到前台、一轮 run 结束时各判一次(notificationWiring F 段)。只问本机的直连 / 订阅来源;
 * Forsion 云端额度另有提示。同一来源、同一窗口、同一次重置只提醒一次(重置时刻差 ±10 分钟算同一次),记录落盘;
 * 读失败 / 旧读数既不判断、也不清记录。
 */
import { registerMessages, translate } from '../i18n'
import { formatDayTime } from '../format/time'
import { getModelQuota } from '../services/backendService'
import { focusRef, homeTarget } from '../services/engine/targets'
import { useApp } from './appStore'
import { notifyApp } from './notificationStore'
import type { ProviderQuota, QuotaWindow } from '../../../../tangu-agent/src/contracts/clientTypes'

registerMessages({
  'ntf.quota.group': { zh: '额度', en: 'Quota' },
  'ntf.quota.groupHint': { zh: '本机订阅与 API 来源的额度；Forsion 云端积分另有提示。', en: 'Usage limits of your own plans and API keys on this computer. Forsion Cloud credits have their own alerts.' },
  'ntf.quota.used': { zh: '额度用到一定比例时提醒', en: 'Alert when usage reaches a level' },
  'ntf.quota.usedHint': { zh: '每个窗口每次重置只提醒一次。', en: 'Once per window, per reset.' },
  'ntf.quota.off': { zh: '关', en: 'Off' },
  'ntf.quota.left': { zh: '每周额度快重置了还剩很多时提醒', en: 'Alert when a weekly limit is about to reset with plenty left' },
  'ntf.quota.leftHint': { zh: '续期前 24 小时、已用不到 85% 时提醒一次；只看按周或更长的窗口。', en: 'Once, 24 hours before the reset, if less than 85% is used. Weekly or longer windows only.' },
  'ntf.quota.plan': { zh: '{name} 订阅', en: '{name} plan' },
  'ntf.quota.msgUsedWeek': { zh: '{source}本周额度已用 {pct}%，{when} 重置', en: '{source}: {pct}% of this week used, resets {when}' },
  'ntf.quota.msgUsedOther': { zh: '{source}的 {window}额度已用 {pct}%，{when} 重置', en: '{source}: {pct}% of the {window} limit used, resets {when}' },
  'ntf.quota.msgLeftWeek': { zh: '{source}本周额度还剩 {pct}%，{when} 重置', en: '{source}: {pct}% of this week left, resets {when}' },
  'ntf.quota.msgLeftOther': { zh: '{source}的 {window}额度还剩 {pct}%，{when} 重置', en: '{source}: {pct}% of the {window} limit left, resets {when}' },
  'ntf.quota.hours': { zh: '{n} 小时', en: '{n}-hour' },
  'ntf.quota.days': { zh: '{n} 天', en: '{n}-day' },
})

export type QuotaThreshold = 0 | 50 | 80 | 95
export interface QuotaAlertPrefs { threshold: QuotaThreshold; weeklyLeft: boolean }

const PREFS_KEY = 'forsion.ntf.quota'
const SEEN_KEY = 'forsion.ntf.quotaSeen'
const MIN = 60_000
const DAY = 24 * 60 * MIN
const SAME_RESET_MS = 10 * MIN
/** 读数比这更旧 = 旧缓存,不判(引擎缓存 5 分钟,正常不会超过)。 */
const STALE_MS = 10 * MIN
const LEFT_BEFORE_MS = DAY
const LEFT_MAX_USED = 85

// 每次判都现读 localStorage:设置在独立浮窗里改,主窗的内存副本会是旧的。
export function readQuotaPrefs(): QuotaAlertPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')
    return { threshold: [50, 80, 95].includes(v?.threshold) ? v.threshold : 0, weeklyLeft: v?.weeklyLeft === true }
  } catch { return { threshold: 0, weeklyLeft: false } }
}
export function writeQuotaPrefs(p: QuotaAlertPrefs): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)) } catch { /* 隐私模式:只这一次不记 */ }
}

export interface QuotaAlert { key: string; kind: 'used' | 'left'; window: QuotaWindow & { resetAt: number } }

/** 这一份读数里该提醒的(纯函数)。seen = 去重记录(键 → 上次提醒时那一轮的重置时刻)。 */
export function pendingQuotaAlerts(q: ProviderQuota | null, prefs: QuotaAlertPrefs, now: number, seen: Record<string, number>): QuotaAlert[] {
  if (!q?.windows?.length || now - q.fetchedAt > STALE_MS) return []
  const out: QuotaAlert[] = []
  for (const w of q.windows) {
    if (!w.resetAt || w.resetAt <= now) continue // 没有重置时刻就没法按「同一次重置」去重
    const win = w as QuotaAlert['window']
    const fresh = (kind: QuotaAlert['kind']): string | null => {
      const key = `${q.providerId}:${w.seconds}:${kind}`
      return seen[key] !== undefined && Math.abs(seen[key] - w.resetAt!) <= SAME_RESET_MS ? null : key
    }
    if (prefs.threshold && w.usedPercent >= prefs.threshold) {
      const key = fresh('used')
      if (key) out.push({ key, kind: 'used', window: win })
    }
    if (prefs.weeklyLeft && w.seconds >= DAY / 1000 && w.resetAt - now <= LEFT_BEFORE_MS && w.usedPercent < LEFT_MAX_USED) {
      const key = fresh('left')
      if (key) out.push({ key, kind: 'left', window: win })
    }
  }
  return out
}

export function quotaAlertText(q: ProviderQuota, a: QuotaAlert, now: number): string {
  const name = q.providerId.charAt(0).toUpperCase() + q.providerId.slice(1)
  const source = q.plan ? translate('ntf.quota.plan', { name }) : name
  const s = a.window.seconds
  const week = s === 7 * DAY / 1000
  const window = s % (DAY / 1000) === 0 ? translate('ntf.quota.days', { n: s / (DAY / 1000) }) : translate('ntf.quota.hours', { n: Math.round(s / 3600) })
  const used = Math.round(a.window.usedPercent)
  const pct = a.kind === 'used' ? used : 100 - used
  const key = a.kind === 'used' ? (week ? 'ntf.quota.msgUsedWeek' : 'ntf.quota.msgUsedOther') : (week ? 'ntf.quota.msgLeftWeek' : 'ntf.quota.msgLeftOther')
  return translate(key, { source, window, pct, when: formatDayTime(a.window.resetAt, { now }) })
}

function readSeen(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}') || {} } catch { return {} }
}

let lastCheck = 0
let inFlight = false
/** 判一次本机直连 / 订阅来源的额度。60s 内重复调用只算一次(引擎那边本来就按来源缓存 5 分钟)。 */
export async function checkQuotaAlerts(now = Date.now()): Promise<void> {
  const prefs = readQuotaPrefs()
  if (!prefs.threshold && !prefs.weeklyLeft) return
  if (inFlight || now - lastCheck < MIN) return
  // 只认本机:焦点在别的电脑时 modelsResp 是那台的目录;Forsion 云端模型不在 directProviders 里
  if (focusRef().kind !== 'home') return
  const providers = useApp.getState().modelsResp?.directProviders ?? []
  const probes = providers.map((p) => p.modelIds?.[0]).filter((id): id is string => !!id)
  if (!probes.length) return
  lastCheck = now
  inFlight = true
  try {
    for (const modelId of probes) {
      const q = await getModelQuota(homeTarget(), modelId).then((r) => r.quota).catch(() => null)
      if (!q) continue // 读失败:不判、不清记录
      const seen = readSeen()
      const alerts = pendingQuotaAlerts(q, prefs, Date.now(), seen)
      if (!alerts.length) continue
      const next = { ...seen }
      for (const a of alerts) next[a.key] = a.window.resetAt
      for (const [k, at] of Object.entries(next)) if (at < Date.now() - 7 * DAY) delete next[k] // 早过期的轮次不留
      try { localStorage.setItem(SEEN_KEY, JSON.stringify(next)) } catch { /* 记不下顶多再提醒一次 */ }
      for (const a of alerts) {
        notifyApp({ event: 'quota.alert', level: a.kind === 'used' ? 'warning' : 'info', text: quotaAlertText(q, a, Date.now()), dedupeKey: `quota:${a.key}` })
      }
    }
  } finally { inFlight = false }
}
