/**
 * 帮助改进 Forsion v2:宿主侧的白名单键、设置分档与报错归类(契约 docs/ToBeImproved/默认数据采集方案_2026-10-28/contract.md §9 / §11)。
 * 主进程(electron/telemetryHost.ts)与渲染层共用这一份:键名照抄 telemetry-schema.json,改一处两边一起变。
 * 纯函数、零依赖。报错归类只看报错原文的形状,**原文本身一个字都不往外带**,只回枚举。
 */

/** 渲染层经 preload telemetryReport 报给主进程的种类(契约 §9);主进程 shapeRendererReport 每种一个分支,别的一律丢。 */
export const RENDERER_REPORT_KINDS = [
  'crash', 'feature', 'longtasks', 'plugin_install', 'plugin_deps', 'plugin_lifecycle', 'plugin_load', 'onboarding', 'guide_tip', 'count', 'command', 'setting',
] as const
export type RendererReportKind = typeof RENDERER_REPORT_KINDS[number]

/** app_counts 的字段(telemetry-schema.json events.app_counts,逐字照抄)。 */
export const APP_COUNT_KEYS = [
  'achChatSend', 'achChatGroup', 'achNoteCreate', 'achNoteWikilink', 'achNoteCanvas', 'achBaseCreate', 'achSpaceSave', 'achSpaceSwitch',
  'achAgentCreate', 'achAutomationCreate', 'achMuseOpen', 'achComputerUse', 'achMarketInstall', 'achThemeChange', 'achTodoDone',
  'achCalendarEvent', 'achAccountLogin', 'achImageGenerate', 'achDrawingCreate', 'achMiniOpen', 'achSpecialEnable',
  'chatStop', 'chatRegenerate', 'chatEditResend', 'chatTruncateResend', 'chatRetry', 'chatRewind', 'chatBranch', 'chatSteer',
  'chatSteerWithdraw', 'chatCompact', 'chatRetryFailed',
  'searchOpen', 'searchPick', 'searchCloseEmpty',
  'providerLoginOk', 'providerLoginFail', 'byokSave', 'byokImport', 'byokImportStale', 'byokDelete',
  'connTestOk', 'connTestFail', 'connTestAuthRejected',
  'modelSwitchUser', 'modelSwitchRemember', 'engineDefaultModelSet',
  'homeWidgetAdd', 'homeWidgetRemove', 'homeWidgetMove',
  'openNote', 'openDatabase', 'openDashboard', 'openPdf', 'openBoard', 'openPluginFile', 'openOther',
] as const
export type AppCountKey = typeof APP_COUNT_KEYS[number]
const COUNT_SET: ReadonlySet<string> = new Set(APP_COUNT_KEYS)
export const isAppCountKey = (k: unknown): k is AppCountKey => typeof k === 'string' && COUNT_SET.has(k)

/** 官方成就计数名 → app_counts 字段。插件的 plugin:* 计数与这张表以外的一律不发。 */
export const ACHIEVEMENT_COUNT_KEYS: Readonly<Record<string, AppCountKey>> = {
  'chat.send': 'achChatSend', 'chat.group': 'achChatGroup', 'note.create': 'achNoteCreate', 'note.wikilink': 'achNoteWikilink',
  'note.canvas': 'achNoteCanvas', 'base.create': 'achBaseCreate', 'space.save': 'achSpaceSave', 'space.switch': 'achSpaceSwitch',
  'agent.create': 'achAgentCreate', 'automation.create': 'achAutomationCreate', 'muse.open': 'achMuseOpen', 'computer.use': 'achComputerUse',
  'market.install': 'achMarketInstall', 'theme.change': 'achThemeChange', 'todo.done': 'achTodoDone', 'calendar.event': 'achCalendarEvent',
  'account.login': 'achAccountLogin', 'image.generate': 'achImageGenerate', 'drawing.create': 'achDrawingCreate', 'mini.open': 'achMiniOpen',
  'special.enable': 'achSpecialEnable',
}
export const achievementCountKey = (event: string): AppCountKey | undefined =>
  Object.hasOwn(ACHIEVEMENT_COUNT_KEYS, event) ? ACHIEVEMENT_COUNT_KEYS[event] : undefined

export const COMMAND_SOURCES = ['palette', 'hotkey', 'ribbon', 'agent', 'other'] as const
export type CommandSource = typeof COMMAND_SOURCES[number]

// ── setting_change:只收这张表里的键,值是枚举或分档;别的键 / 值一律丢 ──
const onOff = (v: unknown): string | undefined => (typeof v === 'boolean' ? (v ? 'on' : 'off') : v === 'on' || v === 'off' ? v : undefined)
const oneOf = (values: readonly string[]) => (v: unknown): string | undefined => (typeof v === 'string' && values.includes(v) ? v : undefined)
/** 主题语言 / 配色:内置 id 原样,用户自己的(磁盘主题、自定义色)由渲染层先换成 custom。这里只认 kebab 短串。 */
const themeId = (v: unknown): string | undefined => (typeof v === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(v) ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
/** 界面缩放:按 0.1 一档,超出 0.5–2 的夹到边上。 */
const scaleBucket = (v: unknown): string | undefined => {
  const n = num(v)
  if (n === undefined || n <= 0) return undefined
  return (Math.round(Math.min(2, Math.max(0.5, n)) * 10) / 10).toFixed(1)
}
const heartbeatBucket = (v: unknown): string | undefined => {
  const n = num(v)
  if (n === undefined) return undefined
  return [30, 60, 120, 180].includes(n) ? String(n) : 'other'
}
/** 每天最多几条私信:0 = 不限。 */
const dmBucket = (v: unknown): string | undefined => {
  const n = num(v)
  if (n === undefined || n < 0 || !Number.isInteger(n)) return undefined
  return n <= 1 ? String(n) : n <= 3 ? '2-3' : n <= 5 ? '4-5' : n <= 10 ? '6-10' : '11+'
}

/** 契约 §9 的设置键表。代码里找不到对应设置的键不在这里(sync.* 在 Extend 的同步页、ui.motionTheme / plugins.autoUpdate 见交付说明)。 */
export const SETTING_KEYS: Readonly<Record<string, (v: unknown) => string | undefined>> = {
  'ui.themeMode': oneOf(['light', 'dark', 'system']),
  'ui.language': oneOf(['zh', 'en']),
  'ui.designLanguage': themeId,
  'ui.skin': themeId,
  'ui.bg': themeId,
  'ui.scale': scaleBucket,
  'muse.enabled': onOff,
  'muse.mode': oneOf(['ask', 'agent', 'auto']),
  'muse.notify': oneOf(['immediate', 'digest']),
  'muse.heartbeat': heartbeatBucket,
  'muse.maxDmPerDay': dmBucket,
  'computerHistory.enabled': onOff,
  'update.channel': oneOf(['stable', 'beta']),
  'approval.defaultMode': oneOf(['readonly', 'auto-edit', 'full-auto', 'custom']),
}
/** 一条设置改动 → 白名单里的 { key, value };键不在表里、值归不了档 → null。 */
export function settingChange(key: unknown, value: unknown): { key: string; value: string } | null {
  if (typeof key !== 'string' || !Object.hasOwn(SETTING_KEYS, key)) return null
  const v = SETTING_KEYS[key](value)
  return v === undefined ? null : { key, value: v }
}

// ── 报错归类:只回枚举,原文不出这个函数 ──
const DISK = /\b(ENOSPC|EACCES|EPERM|EBUSY|EROFS|EMFILE|EIO)\b|no space left/i
const NETWORK = /\b(ECONN\w*|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EPIPE|UND_ERR\w*|CERT_\w+)\b|fetch failed|net::ERR_|socket|network|unreachable|getaddrinfo|certificate|aborted/i

export type InstallStage = 'resolve' | 'download' | 'install'
export type InstallErrorClass = 'timeout' | 'network' | 'http' | 'too-large' | 'not-zip' | 'integrity' | 'identity' | 'version' | 'min-app'
  | 'platform' | 'deps' | 'builtin' | 'activate' | 'disk' | 'other'

/** DownloadFailed 的原文:`<主机>: <原因码>` 用 ` · ` 连起来(electron/marketInstall.ts)。主机必须带点,
 *  否则 Node 的 `EACCES: permission denied, …` 这类也会被当成「主机: 原因」。 */
const DOWNLOAD_PART = /^(?:[a-z0-9-]+\.)+[a-z0-9-]+(?::\d+)?: \S/i
function downloadClass(reasons: string[]): InstallErrorClass {
  if (reasons.some((r) => /too large/i.test(r))) return 'too-large'
  if (reasons.some((r) => /not a zip|unexpected content/i.test(r))) return 'not-zip'
  if (reasons.length && reasons.every((r) => /^(timeout|stalled)$/i.test(r))) return 'timeout'
  if (reasons.some((r) => /^HTTP \d/.test(r))) return 'http'
  if (reasons.some((r) => DISK.test(r))) return 'disk'
  return 'network'
}

/**
 * 商店安装失败 → { stage, errorClass }。raw = 主进程 market:install 抛出的原文(渲染层剥掉 Electron 那层包装之前或之后都行)。
 * lastPhase = 安装进度最后报到的阶段(没有前缀可认时用它)。
 */
export function classifyInstallError(raw: unknown, lastPhase?: InstallStage): { stage: InstallStage; errorClass: InstallErrorClass } {
  const m = String(raw ?? '').replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '').trim()
  if (m.startsWith('resolve: ')) {
    const d = m.slice(9)
    const errorClass: InstallErrorClass = /^timeout\b|TimeoutError/i.test(d) ? 'timeout' : /^HTTP \d/.test(d) ? 'http'
      : /identity/i.test(d) ? 'identity' : NETWORK.test(d) || /^E[A-Z_]{3,}$/.test(d) ? 'network' : 'other'
    return { stage: 'resolve', errorClass }
  }
  if (m.startsWith('install: ')) {
    const d = m.slice(9)
    const errorClass: InstallErrorClass = /^requires Forsion/i.test(d) ? 'min-app' : /unsupported platform/i.test(d) ? 'platform'
      : /integrity/i.test(d) ? 'integrity' : /identity/i.test(d) ? 'identity' : /^builtin$/i.test(d) ? 'builtin'
      : /versions? differ|not newer|incompatible/i.test(d) ? 'version' : DISK.test(d) ? 'disk' : 'other'
    return { stage: 'install', errorClass }
  }
  const parts = m.split(' · ')
  if (m && parts.every((p) => DOWNLOAD_PART.test(p))) {
    return { stage: 'download', errorClass: downloadClass(parts.map((p) => p.replace(/^[^:]+(?::\d+)?: /, '').trim())) }
  }
  // 解压阶段:extractZipToDir 的两句中文、JSZip 认不出的包
  if (/压缩包|central directory|End of data|Corrupted zip|invalid zip|is this a zip/i.test(m)) return { stage: 'install', errorClass: 'not-zip' }
  if (DISK.test(m)) return { stage: lastPhase ?? 'install', errorClass: 'disk' }
  if (/^timeout$|TimeoutError/i.test(m)) return { stage: lastPhase ?? 'resolve', errorClass: 'timeout' }
  if (NETWORK.test(m)) return { stage: lastPhase ?? 'resolve', errorClass: 'network' }
  return { stage: lastPhase ?? 'install', errorClass: 'other' }
}

export type UpdateErrorClass = 'network' | 'http' | 'integrity' | 'signature' | 'version' | 'identity' | 'incompatible' | 'disk' | 'other'
/** 更新失败(安装包 / 引擎 / 内置插件 / 商店插件)→ errorClass。 */
export function classifyUpdateError(raw: unknown): UpdateErrorClass {
  const m = String(raw ?? '')
  if (/integrity|checksum|sha512 mismatch/i.test(m)) return 'integrity'
  if (/signature|code sign|^package:|not signed/i.test(m)) return 'signature'
  if (/identity/i.test(m)) return 'identity'
  if (/incompatible/i.test(m)) return 'incompatible'
  if (DISK.test(m)) return 'disk'
  if (/\bHTTP \d{3}\b|HttpError|status code \d{3}/.test(m)) return 'http'
  if (/^package is .+, not |not newer|versions? differ/i.test(m)) return 'version'
  if (NETWORK.test(m) || /timeout|stalled/i.test(m)) return 'network'
  return 'other'
}
