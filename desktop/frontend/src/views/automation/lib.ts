/** 「自动化」Space 三个 view 共用的小工具(文案拼装;t 由调用方传入)。 */
import type { MuseTriggerInfo, NormalAgentDef } from '../../types'

type T = (key: string, vars?: Record<string, string>) => string

/** 触发条件的人话摘要(未知类型防御回落——新引擎新 cond 不炸旧面板)。 */
export function condText(t: T, cond: MuseTriggerInfo['cond']): string {
  if (!cond || typeof cond !== 'object') return '—'
  if (cond.type === 'daily_at') return t('automation.cond.daily', { time: cond.time })
  if (cond.type === 'event_seen') return t('automation.cond.event', { match: cond.match })
  if (cond.type === 'at') return t('automation.cond.at', { time: String(cond.datetime || '').replace('T', ' ') })
  if (cond.type === 'every') return t('automation.cond.every', { ivl: cond.interval })
  if (cond.type === 'file_chars_gte') return t('automation.cond.file', { path: shortPath(cond.path), n: String(cond.n) })
  if (cond.type === 'manual') return t('automation.cond.manual')
  if (cond.type === 'db_changed') {
    return cond.event === 'row_added'
      ? t('automation.cond.dbRow', { path: shortPath(cond.path) })
      : t('automation.cond.dbCell', { path: shortPath(cond.path) })
  }
  return String((cond as any).type || '—')
}

/** 动作链摘要(列表副行/详情 facts):notify → 通知 · agent_run → agent 名 · tool_call → 工具名。 */
export function actionsText(t: T, defs: NormalAgentDef[], tr: MuseTriggerInfo): string {
  if (tr.actions?.length) {
    return tr.actions
      .map((a) =>
        a.type === 'notify' ? t('automation.step.notify')
        : a.type === 'agent_run' ? runnerName(defs, a.agentSlug)
        : a.type === 'db_row_add' || a.type === 'db_row_edit' ? `${a.type === 'db_row_add' ? '＋' : '✎'} ${shortPath(a.path)}`
        : (a as any).tool || 'tool')
      .join(' → ')
  }
  return runnerName(defs, tr.agentSlug)
}

/** 路径尾部截断(列表摘要用)。 */
export function shortPath(p: string): string {
  return p.length > 36 ? `…${p.slice(-35)}` : p
}

/** 'YYYY-MM-DD[( |T)HH:mm]' → 本地 Date(时分缺省 00:00;手工拆分量,勿 Date.parse——UTC 午夜坑)。 */
export function parseLocalDatetime(raw: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/.exec(String(raw || '').trim())
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0))
  return isNaN(d.getTime()) ? null : d
}

/** 已结束=一次性(at)规则时刻已过且已停用(触发自灭/手动关过期)——重新启用会被引擎拒,归档显示。 */
export function isFinishedTrigger(tr: MuseTriggerInfo): boolean {
  if (tr.cond?.type !== 'at' || tr.enabled) return false
  const d = parseLocalDatetime(tr.cond.datetime)
  return !!d && d.getTime() <= Date.now()
}

/** 执行者显示名:agentSlug 缺省=Muse(品牌名不进 i18n);有 slug 找 defs 显示名,找不到回落 slug。 */
export function runnerName(defs: NormalAgentDef[], agentSlug?: string): string {
  if (!agentSlug) return 'Muse'
  return defs.find((d) => d.slug === agentSlug)?.name || agentSlug
}

/**
 * 内置活动事件目录(builder 事件 datalist;正典=各埋点调用处,这里只是补全建议非枚举约束,
 * 自由子串仍然合法)。插件声明的事件由 pluginStore 侧合并(Phase G)。
 */
export const BUILTIN_EVENTS = [
  'note.edit', 'note.create', 'file.save', 'chat.send', 'chat.new', 'agent.edit',
  'run.done', 'row.edit', 'task.new', 'event.new', 'base.create', 'drawing.create',
  'mindmap.create', 'image.generate', 'market.install', 'agent.create', 'app.start', 'view.open', 'space.save',
]

/** ISO/epoch → 本地短时间。 */
export function fmtTime(v: string | number | null | undefined): string {
  if (!v) return '—'
  const d = new Date(v)
  if (isNaN(d.getTime())) return '—'
  const p = (x: number): string => String(x).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`
}
