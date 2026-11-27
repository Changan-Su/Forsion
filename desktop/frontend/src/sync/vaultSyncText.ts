/**
 * 智库同步的说法:左栏「智库」那行、同步面板、状态栏、通知、智库菜单只从这里取字(方案「状态的说法」,zh / en 成对)。
 * 全套只有这几种:已同步 · 2 分钟前 / 正在核对 / 正在同步 132 / 475 / 10 篇等你定 / 同步出错 / 离线 · 3 个改动没同步 / 已暂停 / 只在这台,
 * 外加「没登录，没在同步」。放不下整句时用 short(淡勾 / 进度圈 + 百分比 / 圆点 + 篇数 / 红点),整句进悬停提示和面板。
 */
import type { SyncFailure, SyncOp, SyncRoundRecord, SyncScope, SyncTarget, VaultSyncView } from '../../../shared/vaultSync'
import { vaultReviewCount } from '../../../shared/vaultSync'
import { registerMessages, translate } from '../i18n'

registerMessages({
  'vsync.synced': { zh: '已同步 · {ago}', en: 'Synced · {ago}' },
  'vsync.syncedPlain': { zh: '已同步', en: 'Synced' },
  'vsync.ago.now': { zh: '刚刚', en: 'just now' },
  'vsync.ago.min': { zh: '{n} 分钟前', en: '{n} min ago' },
  'vsync.ago.hour': { zh: '{n} 小时前', en: '{n} h ago' },
  'vsync.ago.day': { zh: '{n} 天前', en: '{n} d ago' },
  'vsync.checking': { zh: '正在核对', en: 'Checking' },
  'vsync.syncingCount': { zh: '正在同步 {done} / {total}', en: 'Syncing {done} / {total}' },
  'vsync.syncing': { zh: '正在同步', en: 'Syncing' },
  'vsync.review': { zh: '{n} 篇等你定', en: '{n} to review' },
  'vsync.reviewItems': { zh: '{n} 项等你定', en: '{n} to review' },
  'vsync.error': { zh: '同步出错', en: 'Sync error' },
  'vsync.offline': { zh: '离线 · {n} 个改动没同步', en: 'Offline · {n} changes not synced' },
  'vsync.offlinePlain': { zh: '离线', en: 'Offline' },
  'vsync.paused': { zh: '已暂停', en: 'Paused' },
  'vsync.signedOut': { zh: '没登录，没在同步', en: 'Signed out — not syncing' },
  'vsync.off': { zh: '只在这台', en: 'This computer only' },
  'vsync.on': { zh: '同步开着', en: 'Sync is on' },
  'vsync.scope.vault': { zh: '整个库', en: 'Whole vault' },
  'vsync.scope.items': { zh: '选中的 {n} 项', en: '{n} selected items' },
  'vsync.target.penzor': { zh: '蓬洲云', en: 'Penzor Cloud' },
  'vsync.target.folder': { zh: '本地文件夹', en: 'Local folder' },
  'vsync.target.gdrive': { zh: 'Google 云端硬盘', en: 'Google Drive' },
  'vsync.target.other': { zh: '远程服务', en: 'Remote service' },
  'vsync.op.upload': { zh: '正在上传 {path}', en: 'Uploading {path}' },
  'vsync.op.download': { zh: '正在下载 {path}', en: 'Downloading {path}' },
  'vsync.op.merge': { zh: '正在合并 {path}', en: 'Merging {path}' },
  'vsync.op.delete': { zh: '正在删除 {path}', en: 'Deleting {path}' },
  'vsync.op.rename': { zh: '正在改名 {path}', en: 'Renaming {path}' },
  'vsync.op.check': { zh: '正在处理 {path}', en: 'Working on {path}' },
  'vsync.reason.tooLarge': { zh: '超过 {mb} MB，{target}的单个文件上限', en: 'Over {mb} MB, the {target} limit for one file' },
  'vsync.reason.tooLargePlain': { zh: '文件太大，{target}不收', en: 'Too large for {target}' },
  'vsync.reason.invalidName': { zh: '文件名{target}不认，改个名字就能同步', en: '{target} can’t take this file name; rename it to sync' },
  'vsync.reason.unreadable': { zh: '这台读不了这个文件（{code}）', en: 'This computer can’t read the file ({code})' },
  'vsync.reason.rejected': { zh: '{target}没收下（{code}）', en: '{target} refused it ({code})' },
  'vsync.reason.failed': { zh: '没传上（{code}），会自己再试', en: 'Didn’t go through ({code}); will retry' },
  'vsync.reason.failedPlain': { zh: '没传上，会自己再试', en: 'Didn’t go through; will retry' },
  // 放不下整句时的最短写法(只有字、没有图形的那几种)
  'vsync.short.signedOut': { zh: '没登录', en: 'Signed out' },
  // 悬停提示:整句 · 范围 → 去处
  'vsync.tip': { zh: '{text} · {scope} → {target}', en: '{text} · {scope} → {target}' },
  // 同步面板
  'vsync.panel.label': { zh: '{name}的同步', en: 'Sync for {name}' },
  'vsync.panel.syncNow': { zh: '立即同步', en: 'Sync now' },
  'vsync.panel.review': { zh: '等你定', en: 'To review' },
  'vsync.panel.newerHere': { zh: '这台更新', en: 'Newer here' },
  'vsync.panel.newerThere': { zh: '云端更新', en: 'Newer in the cloud' },
  'vsync.panel.newerUnknown': { zh: '时间不明', en: 'Time unknown' },
  'vsync.panel.all': { zh: '全部…', en: 'All…' },
  'vsync.panel.collapse': { zh: '收起', en: 'Collapse' },
  'vsync.panel.deletes': { zh: '拦下了 {n} 个删除', en: '{n} deletions held back' },
  'vsync.panel.deletesAccount': { zh: '账号里一共拦下了 {n} 个删除', en: '{n} deletions held back across the account' },
  'vsync.panel.deletesGo': { zh: '去确认…', en: 'Review…' },
  'vsync.panel.round': { zh: '这一轮', en: 'This round' },
  'vsync.panel.checkingDots': { zh: '正在核对…', en: 'Checking…' },
  'vsync.panel.files': { zh: '{done} / {total} 个文件', en: '{done} / {total} files' },
  'vsync.panel.filesDone': { zh: '已处理 {done} 个文件', en: '{done} files done' },
  'vsync.panel.rateLimited': { zh: '服务器限速，{n} 秒后继续 · 不算出错', en: 'Server is slowing requests; resuming in {n} s · not an error' },
  'vsync.panel.idle': { zh: '两边一样，没有要传的', en: 'Both sides match; nothing to send' },
  'vsync.panel.restSyncs': { zh: '其余照常同步', en: 'Everything else syncs as usual' },
  'vsync.panel.unknown': { zh: '同步开着，还没收到它这一轮的状态', en: 'Sync is on; no status from it yet' },
  'vsync.panel.recordsUnavailable': { zh: '这台的同步记录读不出来', en: 'Couldn’t read the sync history on this computer' },
  'vsync.panel.failed': { zh: '{n} 个没传上', en: '{n} not synced' },
  'vsync.panel.retry': { zh: '重试', en: 'Retry' },
  'vsync.panel.more': { zh: '还有 {n} 个，见全部记录', en: '{n} more in the full history' },
  'vsync.panel.records': { zh: '同步记录', en: 'Sync history' },
  'vsync.panel.noRecords': { zh: '还没有记录', en: 'No history yet' },
  'vsync.panel.settings': { zh: '同步设置…', en: 'Sync settings…' },
  'vsync.panel.allRecords': { zh: '全部记录', en: 'Full history' },
  'vsync.panel.elsewhere': { zh: '别处还有 {n} 项要看', en: '{n} more need attention elsewhere' },
  // 一轮一行
  'vsync.rec.uploaded': { zh: '上传 {n}', en: '{n} uploaded' },
  'vsync.rec.downloaded': { zh: '下载 {n}', en: '{n} downloaded' },
  'vsync.rec.merged': { zh: '合并 {n}', en: '{n} merged' },
  'vsync.rec.renamed': { zh: '改名 {n}', en: '{n} renamed' },
  'vsync.rec.deletedCloud': { zh: '删云端 {n}', en: '{n} deleted in the cloud' },
  'vsync.rec.deletedLocal': { zh: '删这台 {n}', en: '{n} deleted here' },
  'vsync.rec.held': { zh: '放着 {n}', en: '{n} set aside' },
  'vsync.rec.failed': { zh: '{n} 个没传上', en: '{n} not synced' },
  'vsync.rec.idle': { zh: '没有变化', en: 'No changes' },
  'vsync.rec.first': { zh: '第一次同步', en: 'First sync' },
  'vsync.rec.took': { zh: '用时 {d}', en: 'took {d}' },
  'vsync.rec.sec': { zh: '{s} 秒', en: '{s} s' },
  'vsync.rec.minSec': { zh: '{m} 分 {s} 秒', en: '{m} min {s} s' },
  'vsync.rec.stopped': { zh: '没跑完', en: 'Stopped early' },
  'vsync.rec.mirror': { zh: '云端智库', en: 'Cloud vault' },
  'vsync.rec.share': { zh: '与我共享', en: 'Shared with me' },
  'vsync.rec.feed': { zh: '{name} → {target}', en: '{name} → {target}' },
  // 通知
  'vsync.ntf.error': { zh: '{name}同步出错：{e}', en: 'Sync error for {name}: {e}' },
  'vsync.ntf.failed': { zh: '{path} 没传上：{reason}', en: '{path} didn’t sync: {reason}' },
  'vsync.ntf.failedMore': { zh: '{path} 等 {more} 个文件没传上：{reason}', en: '{path} and {more} more didn’t sync: {reason}' },
  'vsync.ntf.review': { zh: '{name}有 {n} 项等你定', en: '{n} to review in {name}' },
  // 全部记录
  'vsync.all.title': { zh: '同步记录', en: 'Sync history' },
  'vsync.all.sub': { zh: '最近 30 天，一轮一行，存在这台电脑上，换账号不带走', en: 'Last 30 days, one row per round. Kept on this computer; not carried across accounts' },
  'vsync.all.empty': { zh: '最近 30 天还没有同步记录', en: 'No sync history in the last 30 days' },
  'vsync.all.noFailures': { zh: '这一轮没有失败的文件', en: 'No failed files in this round' },
  'vsync.all.failedHead': { zh: '没传上的文件', en: 'Files not synced' },
  'vsync.all.moreFailed': { zh: '另有 {n} 个没列出', en: '{n} more not listed' },
})

type T = (key: string, vars?: Record<string, string | number>) => string
const tr: T = (k, v) => translate(k, v)

export function agoText(at: number, now: number, t: T = tr): string {
  const s = Math.max(0, now - at) / 1000
  if (s < 60) return t('vsync.ago.now')
  if (s < 3600) return t('vsync.ago.min', { n: Math.floor(s / 60) })
  if (s < 86400) return t('vsync.ago.hour', { n: Math.floor(s / 3600) })
  return t('vsync.ago.day', { n: Math.floor(s / 86400) })
}

/** 品牌名两种语言同形,不进词条(i18n 覆盖 F:zh 值不许是纯拉丁文)。 */
const BRAND_TARGET: Partial<Record<SyncTarget, string>> = { dropbox: 'Dropbox', webdav: 'WebDAV', s3: 'S3' }

export function targetName(target: SyncTarget | null, t: T = tr): string {
  const key = target ?? 'penzor'
  return BRAND_TARGET[key] ?? t(`vsync.target.${key}`)
}

export function scopeText(scope: SyncScope | null, t: T = tr): string {
  if (!scope) return ''
  return scope.kind === 'vault' ? t('vsync.scope.vault') : t('vsync.scope.items', { n: scope.count })
}

export function opText(op: SyncOp, path: string, t: T = tr): string {
  return t(`vsync.op.${op}`, { path })
}

export function failureText(f: SyncFailure, target: SyncTarget | null, t: T = tr): string {
  const name = targetName(target, t)
  switch (f.reason) {
    case 'too-large': return f.maxBytes ? t('vsync.reason.tooLarge', { mb: Math.round(f.maxBytes / (1024 * 1024)), target: name }) : t('vsync.reason.tooLargePlain', { target: name })
    case 'invalid-name': return t('vsync.reason.invalidName', { target: name })
    case 'unreadable': return t('vsync.reason.unreadable', { code: f.code ?? '' })
    case 'rejected': return t('vsync.reason.rejected', { target: name, code: f.code ?? '' })
    default: return f.code ? t('vsync.reason.failed', { code: f.code }) : t('vsync.reason.failedPlain')
  }
}

/** 放不下整句时的最短写法(方案:已同步一枚淡勾 / 正在同步进度圈 + 百分比 / 等你定圆点 + 篇数 / 出错红点)。 */
export type VaultSyncShort =
  | { kind: 'check' }
  | { kind: 'ring'; pct: number | null }
  | { kind: 'dot'; n: number }
  | { kind: 'error' }
  | { kind: 'text'; text: string }

export type VaultSyncTone = 'muted' | 'accent' | 'warning' | 'danger'

export interface VaultSyncWords {
  /** 整句(左栏放得下时、悬停提示、面板、状态栏、智库菜单) */
  text: string
  short: VaultSyncShort
  tone: VaultSyncTone
}

/** 一个库此刻的那句话。 */
export function vaultSyncWords(view: VaultSyncView, now = Date.now(), t: T = tr): VaultSyncWords {
  switch (view.state) {
    case 'off': return { text: t('vsync.off'), short: { kind: 'text', text: t('vsync.off') }, tone: 'muted' }
    case 'signed-out': return { text: t('vsync.signedOut'), short: { kind: 'text', text: t('vsync.short.signedOut') }, tone: 'muted' }
    case 'checking': return { text: t('vsync.checking'), short: { kind: 'ring', pct: null }, tone: 'accent' }
    case 'syncing': {
      const f = view.progress?.files
      const pct = f && f.total ? Math.min(100, Math.floor((f.done / f.total) * 100)) : null
      return { text: f && f.total ? t('vsync.syncingCount', { done: f.done, total: f.total }) : t('vsync.syncing'), short: { kind: 'ring', pct }, tone: 'accent' }
    }
    case 'review': {
      const n = vaultReviewCount(view)
      const onlyNotes = view.review.every((r) => r.kind === 'differs')
      return { text: t(onlyNotes ? 'vsync.review' : 'vsync.reviewItems', { n }), short: { kind: 'dot', n }, tone: 'warning' }
    }
    case 'error': return { text: t('vsync.error'), short: { kind: 'error' }, tone: 'danger' }
    case 'offline': {
      const text = view.pendingChanges > 0 ? t('vsync.offline', { n: view.pendingChanges }) : t('vsync.offlinePlain')
      return { text, short: { kind: 'text', text: t('vsync.offlinePlain') }, tone: 'muted' }
    }
    case 'paused': return { text: t('vsync.paused'), short: { kind: 'text', text: t('vsync.paused') }, tone: 'muted' }
    case 'on': return { text: t('vsync.on'), short: { kind: 'text', text: t('vsync.on') }, tone: 'muted' }
    default: {
      const text = view.lastSyncAt ? t('vsync.synced', { ago: agoText(view.lastSyncAt, now, t) }) : t('vsync.syncedPlain')
      return { text, short: { kind: 'check' }, tone: 'muted' }
    }
  }
}

/** 悬停提示:整句 · 范围 → 去处(没有范围 / 去处时只给整句)。 */
export function vaultSyncTip(view: VaultSyncView, words: VaultSyncWords, t: T = tr): string {
  if (view.state === 'off' || view.state === 'signed-out' || !view.scope) return words.text
  return t('vsync.tip', { text: words.text, scope: scopeText(view.scope, t), target: targetName(view.target, t) })
}

/** 一轮用了多久(记录里「第一次同步 · 上传 471 · 用时 1 分 06 秒」那一段;不到 1 秒不写)。 */
export function durationText(ms: number, t: T = tr): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return t('vsync.rec.sec', { s })
  return t('vsync.rec.minSec', { m: Math.floor(s / 60), s: String(s % 60).padStart(2, '0') })
}

/** 同步记录一行的那句话:「上传 3 · 下载 1」「没有变化」「上传 12 · 1 个没传上」「第一次同步 · 上传 471 · 用时 1 分 06 秒」。 */
export function recordSummary(r: SyncRoundRecord, t: T = tr): string {
  const parts: string[] = []
  if (r.first) parts.push(t('vsync.rec.first'))
  const counts: Array<[keyof SyncRoundRecord, string]> = [
    ['uploaded', 'vsync.rec.uploaded'], ['downloaded', 'vsync.rec.downloaded'], ['merged', 'vsync.rec.merged'], ['renamed', 'vsync.rec.renamed'],
    ['deletedCloud', 'vsync.rec.deletedCloud'], ['deletedLocal', 'vsync.rec.deletedLocal'], ['held', 'vsync.rec.held'],
  ]
  for (const [k, key] of counts) { const n = r[k] as number; if (n > 0) parts.push(t(key, { n })) }
  if (r.failedCount > 0) parts.push(t('vsync.rec.failed', { n: r.failedCount }))
  if (!parts.length || (parts.length === 1 && r.first)) parts.push(t('vsync.rec.idle'))
  if (r.first && r.finishedAt - r.startedAt >= 1000) parts.push(t('vsync.rec.took', { d: durationText(r.finishedAt - r.startedAt, t) }))
  if (!r.completed) parts.push(t('vsync.rec.stopped'))
  return parts.join(' · ')
}

/** 全部记录里这一行是哪一路:「Notes → 蓬洲云」「云端笔记库 → 蓬洲云」。 */
export function recordFeedLabel(r: SyncRoundRecord, t: T = tr): string {
  const name = r.feed === 'legacy:mirror' ? t('vsync.rec.mirror')
    : r.feed.startsWith('legacy:share:') ? t('vsync.rec.share')
      : (r.vault?.split(/[\\/]/).filter(Boolean).pop() ?? t('vsync.rec.mirror'))
  return t('vsync.rec.feed', { name, target: targetName(r.target, t) })
}
