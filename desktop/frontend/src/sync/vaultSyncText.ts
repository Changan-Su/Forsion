/**
 * 智库同步的说法:左栏「智库」那行、同步面板、状态栏、通知、智库菜单只从这里取字(方案「状态的说法」,zh / en 成对)。
 * 全套只有这几种:已同步 · 2 分钟前 / 正在核对 / 正在同步 132 / 475 / 10 篇等你定 / 同步出错 / 离线 · 3 个改动没同步 / 已暂停 / 只在这台,
 * 外加「没登录，没在同步」。放不下整句时用 short(淡勾 / 进度圈 + 百分比 / 圆点 + 篇数 / 红点),整句进悬停提示和面板。
 */
import type { SyncFailure, SyncOp, SyncScope, SyncTarget, VaultSyncView } from '../../../shared/vaultSync'
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
  'vsync.scope.vault': { zh: '整个库', en: 'Whole vault' },
  'vsync.scope.items': { zh: '选中的 {n} 项', en: '{n} selected items' },
  'vsync.target.penzor': { zh: '蓬洲云', en: 'Penzor Cloud' },
  'vsync.target.dropbox': { zh: 'Dropbox', en: 'Dropbox' },
  'vsync.target.webdav': { zh: 'WebDAV', en: 'WebDAV' },
  'vsync.target.s3': { zh: 'S3', en: 'S3' },
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

export function targetName(target: SyncTarget | null, t: T = tr): string {
  return t(`vsync.target.${target ?? 'penzor'}`)
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
    case 'signed-out': return { text: t('vsync.signedOut'), short: { kind: 'text', text: t('vsync.signedOut') }, tone: 'muted' }
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
    default: {
      const text = view.lastSyncAt ? t('vsync.synced', { ago: agoText(view.lastSyncAt, now, t) }) : t('vsync.syncedPlain')
      return { text, short: { kind: 'check' }, tone: 'muted' }
    }
  }
}
